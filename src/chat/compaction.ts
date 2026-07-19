// Compact conversation, context-aware (#38). A conversation's context grows every turn; once the
// running transcript nears the ACTIVE MODEL's context window the model starts dropping the oldest
// turns (or the router truncates). This module is the PURE core that decides when to nudge the user
// to compact and how much to fold — kept free of I/O so it is exhaustively unit-testable, mirroring
// how src/settings/preferences.ts owns the normalization boundary.
//
// Compaction is a CONTEXT-WINDOW construct, never a data operation: the raw `messages` log stays
// intact (see the schema note on `conversations.compactedThroughMessageId`). "Folding" only means
// the model PROMPT for later turns replaces the pre-boundary turns with the rolling summary the
// two-tier memory already maintains. So this file computes the boundary + the usage meter; the
// route persists the boundary and reuses the memory service's summary machinery to represent the
// folded turns.

// A turn as this module reasons about it — the ACTIVE message of a thread slot. Kept to the minimum
// (id + role + content) so callers can pass either DB rows or a lightweight projection.
export interface CompactTurn {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
}

// ---- Tunables --------------------------------------------------------------

// Rough chars-per-token for the estimate. There's no local tokenizer in the codebase (Jano owns the
// real one), so the product-standard chars/4 heuristic is the honest, dependency-free approximation.
// It only drives a soft "you're getting full" nudge, never a hard truncation, so an approximation is
// safe: the real window is enforced upstream.
export const CHARS_PER_TOKEN = 4;

// Per-message framing overhead (role tag, delimiters) the transcript costs beyond its raw text.
// Small + fixed; keeps a chat of many tiny messages from reading as near-zero tokens.
export const PER_MESSAGE_TOKEN_OVERHEAD = 4;

// Conservative window for a model we can't resolve a real context length for (uncataloged, or a
// catalog row that omits `contextTokens`). Fail-safe: an UNKNOWN model degrades to a SMALL window,
// so we prompt to compact EARLIER rather than let an unbounded transcript silently overflow.
export const FALLBACK_CONTEXT_WINDOW = 8192;

// A small per-model default window map, consulted only when the live catalog carries no
// `contextTokens` for the id (a redundant safety net for the models Jano serves today, and a place
// to pin a sensible window for a known id the catalog hasn't been filled in for). The catalog stays
// the source of truth when present; this is the fallback BEFORE the conservative constant above.
export const MODEL_CONTEXT_FALLBACKS: Record<string, number> = {
  "qwen-chat": 32768,
  "qwen-code": 32768,
  "qwen-omni": 32768,
};

// Prompt to compact once the transcript is estimated to fill this fraction of the window. Below it
// we say nothing; at/above it the banner appears. Default behavior is to PROMPT (never silent
// auto-compaction) — the user stays in control.
export const COMPACT_PROMPT_RATIO = 0.75;

// Below this fraction the usage meter stays HIDDEN — a subtle affordance that only appears as the
// conversation actually gets long, so a short chat carries no chrome.
export const CONTEXT_METER_MIN_RATIO = 0.5;

// How many recent turns (thread slots) compaction keeps VERBATIM; everything older folds into the
// summary. Keeps the last few exchanges lossless so the immediate thread reads naturally while the
// long tail is summarized.
export const KEEP_RECENT_TURNS = 6;

// Don't bother compacting unless at least this many turns would actually fold — otherwise the churn
// (an LLM summary pass, a boundary write) buys almost nothing.
export const MIN_FOLD_TURNS = 2;

// ---- Token estimate (pure) -------------------------------------------------

// Estimate the tokens a string costs. chars/4, rounded up; empty/blank ⇒ 0. Guards a non-string
// (defensive — callers are typed, but a bad row shouldn't throw).
export function estimateTokens(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Estimate the tokens a set of turns costs: each turn's content plus a small framing overhead.
export function estimateTurnsTokens(turns: { content: string }[]): number {
  let total = 0;
  for (const t of turns) total += estimateTokens(t.content) + PER_MESSAGE_TOKEN_OVERHEAD;
  return total;
}

// ---- Context window resolution (pure, fail-safe) ---------------------------

// The context window (in tokens) to meter this model against. Precedence:
//   1. the live catalog's `contextTokens` (the honest served window, #63) when it's a positive number
//   2. the small per-model default map (a known id the catalog didn't fill in)
//   3. the conservative FALLBACK (unknown model → small window → prompt earlier)
// Never returns 0/negative, so the meter can always divide safely.
export function resolveContextWindow(modelId: string, contextTokens?: number | null): number {
  if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0) {
    return Math.floor(contextTokens);
  }
  const mapped = MODEL_CONTEXT_FALLBACKS[modelId];
  if (typeof mapped === "number" && mapped > 0) return mapped;
  return FALLBACK_CONTEXT_WINDOW;
}

// ---- Threshold decision (pure) ---------------------------------------------

// The compaction decision for a usage/window pair. `ratio` is clamped to [0,1] for display;
// `shouldPrompt` is true once usage reaches the threshold. A non-positive window (can't happen via
// resolveContextWindow, but guarded for direct callers) yields ratio 0 / no prompt — never NaN,
// never a spurious nag.
export interface CompactionState {
  ratio: number;
  shouldPrompt: boolean;
}

export function compactionState(
  usedTokens: number,
  windowTokens: number,
  threshold: number = COMPACT_PROMPT_RATIO,
): CompactionState {
  if (!(windowTokens > 0) || !(usedTokens >= 0)) return { ratio: 0, shouldPrompt: false };
  const raw = usedTokens / windowTokens;
  const ratio = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  return { ratio, shouldPrompt: raw >= threshold };
}

// The full context-usage snapshot the API returns to the client. Extends the decision with the raw
// numbers (so the UI can label "12k / 32k") and a `showMeter` flag (keep the affordance hidden until
// the conversation is actually long). One shape, computed server-side, so the pure token logic lives
// in exactly one place.
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
  shouldPrompt: boolean;
  showMeter: boolean;
}

export function contextUsage(usedTokens: number, windowTokens: number): ContextUsage {
  const { ratio, shouldPrompt } = compactionState(usedTokens, windowTokens);
  return {
    usedTokens: Math.max(0, Math.round(usedTokens)),
    windowTokens,
    ratio,
    shouldPrompt,
    showMeter: ratio >= CONTEXT_METER_MIN_RATIO,
  };
}

// ---- Compaction plan (pure) ------------------------------------------------

// Where to draw the boundary, given the active turns oldest→newest. Keeps the last `keepRecent`
// turns verbatim and folds everything before them into the summary. `boundaryId` is the id of the
// LAST folded turn (the marker persisted on the conversation); `foldedCount` is how many turns fold.
// Returns null when there's nothing worth compacting (fewer than MIN_FOLD_TURNS would fold), so the
// caller can decline cleanly rather than churn an LLM pass for no benefit.
export interface CompactionPlan {
  boundaryId: string;
  foldedCount: number;
}

export function planCompaction(activeTurns: CompactTurn[], keepRecent: number = KEEP_RECENT_TURNS): CompactionPlan | null {
  const keep = Math.max(0, Math.floor(keepRecent));
  const foldedCount = activeTurns.length - keep;
  if (foldedCount < MIN_FOLD_TURNS) return null;
  const boundary = activeTurns[foldedCount - 1];
  if (!boundary) return null;
  return { boundaryId: boundary.id, foldedCount };
}

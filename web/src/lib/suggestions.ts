import type { SuggestionHint } from "./api";

// Capability suggestion engine (#22) — the CLIENT half. The server ships the caller's ACTIVE nudge
// set in /api/me (enabled + entitled capabilities that declare one). Here we do the cheap,
// content-free matching against the latest exchange and remember dismissals. Kept a pure module (no
// React) so the matching + persistence are unit-testable and ChatView stays thin. Nothing here
// touches the network or the core renderer — a nudge is a subtle, dismissible chip, never Clippy.

export type { SuggestionHint };

const DISMISSED_KEY = "a7t_suggest_dismissed";

// Case-insensitive, word-boundary match of a controlled keyword/phrase against text. The keywords
// come from OUR OWN capability descriptors (never user input), but we still escape regex
// metacharacters so a phrase matches literally — no accidental pattern, no ReDoS. The boundaries
// are "not a letter or number" (unicode-aware) so `map` doesn't fire inside `example`, while a
// multi-word phrase like `road trip` still matches naturally.
function keywordHit(text: string, keyword: string): boolean {
  const kw = keyword.trim();
  if (!kw) return false;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, "iu").test(text);
}

export interface MatchInput {
  // The recent exchange text to match triggers against (e.g. the latest user + assistant turn).
  contextText: string;
  // The latest assistant reply, used to suppress a nudge when the reply ALREADY used that marker.
  assistantText: string;
  hints: SuggestionHint[];
  // Capability ids the user has permanently dismissed (kept out of the way — never nag).
  dismissed: Set<string>;
}

// The single active nudge for the current context, or null. At most ONE is ever returned (we never
// stack chips), taking the first matching hint in the server's order. A hint is skipped when it's
// been dismissed, when the reply already carries its marker (`[[<id>:` — already discovered), or
// when no trigger matches. An empty context never matches.
export function matchSuggestion({ contextText, assistantText, hints, dismissed }: MatchInput): SuggestionHint | null {
  if (!contextText.trim()) return null;
  for (const hint of hints) {
    if (dismissed.has(hint.id)) continue;
    if (assistantText.includes(`[[${hint.id}:`)) continue;
    if (hint.triggers.some((kw) => keywordHit(contextText, kw))) return hint;
  }
  return null;
}

// The set of capability ids the user has dismissed, read from localStorage. Any failure (private
// mode, quota, corrupt value) degrades to an empty set — a nudge showing again is harmless.
export function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

// Persist the dismissed-id set. A localStorage failure is a safe no-op — the caller also holds the
// dismissal in React state, so it still takes effect for the session even if it can't be saved.
export function persistDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore — see note above
  }
}

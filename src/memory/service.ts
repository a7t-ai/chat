import { and, desc, eq, ne } from "drizzle-orm";
import { capabilitySystemPrompt } from "../capabilities/registry.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { facts, memoryChunks, messages, summaries, users } from "../db/schema.ts";
import { backend } from "../jano/client.ts";
import type { ChatMessage } from "../jano/types.ts";
import { parseStoredPreferences } from "../settings/preferences.ts";

// Two-tier memory, READ + WRITE paths.
//   READ:  buildSystemPrompt injects the derived tier (facts + rolling summary) so the
//          assistant "remembers everything" and can be proactive.
//   WRITE: updateMemory runs after a turn (fire-and-forget) to extract durable facts and
//          refresh the conversation summary. The raw message log is the lossless source;
//          this derived tier is compacted and re-derivable. (Tier 3 = sqlite-vec semantic
//          recall, added with the embed service.)

export function userFacts(userId: string, limit = 40): string[] {
  return db
    .select()
    .from(facts)
    .where(eq(facts.userId, userId))
    .orderBy(desc(facts.updatedAt))
    .limit(limit)
    .all()
    .map((f) => f.content);
}

// ---- Archivist transparency + control (#27) --------------------------------
// The user-facing memory surface: what a7t.chat durably remembers about you, and the controls
// to forget it. Facts are the human-readable derived tier (the summaries are per-conversation
// working context, the chunks are embeddings of your own messages) — so this is the transparent
// list. Every helper is scoped to the caller's own userId; nothing here can touch another user.

export interface RememberedFact {
  id: string;
  content: string;
  createdAt: Date;
}

// The caller's remembered facts, most-recently-updated first (matching how they're injected).
export function listFacts(userId: string): RememberedFact[] {
  return db
    .select({ id: facts.id, content: facts.content, createdAt: facts.createdAt })
    .from(facts)
    .where(eq(facts.userId, userId))
    .orderBy(desc(facts.updatedAt))
    .all();
}

// Forget one fact. Scoped by BOTH userId and id, so a caller can only ever delete their own
// fact — another account's (or an unknown) id deletes nothing and returns false (the route maps
// that to a 404, no existence oracle).
export function forgetFact(userId: string, id: string): boolean {
  const removed = db
    .delete(facts)
    .where(and(eq(facts.userId, userId), eq(facts.id, id)))
    .returning({ id: facts.id })
    .all();
  return removed.length > 0;
}

// Forget everything: wipe the caller's whole DERIVED memory tier — durable facts, rolling
// summaries, and semantic-recall embeddings. The verbatim message log (the user's own
// conversations, which they delete separately) is untouched; this clears only what the assistant
// has learned. Returns the number of facts cleared (the surface the UI reported). If memory is
// still enabled it will re-derive on the next turn — a durable stop is the `memory.enabled`
// toggle, which this deliberately does not change.
export function forgetAllMemory(userId: string): number {
  const cleared = db
    .delete(facts)
    .where(eq(facts.userId, userId))
    .returning({ id: facts.id })
    .all();
  db.delete(summaries).where(eq(summaries.userId, userId)).run();
  db.delete(memoryChunks).where(eq(memoryChunks.userId, userId)).run();
  return cleared.length;
}

// Whether durable memory is ON for this user — read from their stored preferences (#27). The
// chat route consults this (for the OWNER, who memory always follows) to gate both the READ
// (injecting facts/recall) and the WRITE (extracting facts, embedding). A missing/corrupt
// preferences column degrades to the default (enabled), never silently opting a user out.
export function memoryEnabledFor(userId: string): boolean {
  const row = db.select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).get();
  return parseStoredPreferences(row?.preferences).memory.enabled;
}

export function conversationSummary(userId: string, conversationId: string): string | null {
  const s = db
    .select()
    .from(summaries)
    .where(
      and(
        eq(summaries.userId, userId),
        eq(summaries.scope, "conversation"),
        eq(summaries.conversationId, conversationId),
      ),
    )
    .get();
  return s?.content ?? null;
}

// Recent assistant replies the user voted on, as steering examples. Cross-conversation,
// most-recent-first, snippets truncated to bound the prompt size.
export function votedExamples(userId: string, limit = 3): { liked: string[]; disliked: string[] } {
  const rows = db
    .select({ content: messages.content, vote: messages.vote })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.role, "assistant"), ne(messages.vote, 0)))
    .orderBy(desc(messages.createdAt))
    .all();

  const liked: string[] = [];
  const disliked: string[] = [];
  for (const r of rows) {
    const snippet = r.content.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!snippet) continue;
    if (r.vote === 1 && liked.length < limit) liked.push(snippet);
    else if (r.vote === -1 && disliked.length < limit) disliked.push(snippet);
    if (liked.length >= limit && disliked.length >= limit) break;
  }
  return { liked, disliked };
}

export function buildSystemPrompt(
  userId: string,
  conversationId: string | null,
  login: string,
  recalled: string[] = [],
  // The user's persona fragment (#11), pre-rendered by the caller from their preferences.
  // Injected right after the base line so the assistant adopts the requested tone/address
  // before any memory context. Empty/null = the user set no persona.
  persona: string | null = null,
  // Whether to seed the prompt with the user's OWNER-GLOBAL memory — durable facts and
  // cross-conversation voted-style examples. On a collaborative turn (#46) the prompter is
  // NOT the conversation owner: granting the `prompt` role on ONE conversation is not consent
  // to read the owner's memory from every OTHER private thread back out through the model, so
  // the caller passes `false` and also withholds cross-conversation `recall`. The conversation
  // summary stays either way — it is scoped to THIS conversation, which the collaborator can
  // already read in full.
  ownerMemory = true,
): ChatMessage {
  const lines: string[] = ["You are a7t.chat, a helpful, concise assistant running locally."];

  if (persona && persona.trim()) lines.push("", persona);

  const fcts = ownerMemory ? userFacts(userId) : [];
  if (fcts.length > 0) {
    lines.push("", `What you remember about ${login}:`, ...fcts.map((f) => `- ${f}`));
  }

  const sum = conversationId ? conversationSummary(userId, conversationId) : null;
  if (sum) lines.push("", `Conversation so far: ${sum}`);

  if (recalled.length > 0) {
    lines.push("", "Relevant context from earlier conversations:", ...recalled.map((r) => `- ${r}`));
  }

  const { liked, disliked } = ownerMemory ? votedExamples(userId) : { liked: [], disliked: [] };
  if (liked.length > 0) {
    lines.push("", "The user thumbs-upped replies like these — favor this style and substance:", ...liked.map((s) => `+ ${s}`));
  }
  if (disliked.length > 0) {
    lines.push("", "The user thumbs-downed replies like these — avoid this style and substance:", ...disliked.map((s) => `- ${s}`));
  }

  lines.push(
    "",
    "Be proactive: when the request connects to something you remember, surface it naturally and briefly — don't force it.",
  );

  // Capabilities (maps, …) each contribute an instruction fragment teaching the model
  // when to emit their inline marker. Appended last so they read as concrete tools.
  const caps = capabilitySystemPrompt();
  if (caps.trim()) lines.push(caps);

  return { role: "system", content: lines.join("\n") };
}

// Steer a regenerate ("retry") so it diverges from the answers already produced for this
// slot instead of re-deriving near-identical text. We fold the prior answer(s) into the
// system prompt and instruct the model to take a fresh angle — accuracy first, novelty
// second. Bounded (last few answers, each truncated) so a long reply or many retries
// can't blow up the prompt. Returns the system message unchanged when there's nothing to
// diverge from.
export function withRegenerateSteering(system: ChatMessage, priorAnswers: string[]): ChatMessage {
  const recent = priorAnswers.map((a) => a.trim()).filter((a) => a.length > 0).slice(-3);
  if (recent.length === 0) return system;
  const shown = recent.map((a, i) => {
    const body = a.length > 1200 ? `${a.slice(0, 1200)}…` : a;
    return `--- previous answer ${i + 1} ---\n${body}`;
  });
  const steer = [
    "",
    "The user pressed retry on your previous answer: they want a genuinely DIFFERENT response, not a reworded version of the same one.",
    recent.length === 1
      ? "Your previous answer to this exact prompt:"
      : "Your previous answers to this exact prompt:",
    ...shown,
    "",
    "Write a new answer that meaningfully differs: take a different angle or perspective, lead with a different point, and reorganize rather than reusing the same opening, phrasing, or examples. Stay accurate and genuinely useful — do not distort facts just to be different.",
  ].join("\n");
  return { role: system.role, content: `${system.content}\n${steer}` };
}

// System prompt for a TEMPORARY (ghost) chat. The derived memory tier (facts, rolling
// summary, voted-style examples, semantic recall) is intentionally OMITTED: a ghost chat
// neither reads nor writes the user's memory, so the session is fully isolated. The model
// is also told the chat is ephemeral so it can set expectations honestly if asked.
// A ghost chat is a deliberately clean, identity-free session: it omits the derived memory
// tier AND the user's persona (#11). Personalization is opt-out here for the same reason
// memory is — a temp chat is where you go to ask something without your name/role/notes riding
// along. Persona applies to normal + regenerated turns only.
export function ephemeralSystemPrompt(): ChatMessage {
  return {
    role: "system",
    content: [
      "You are a7t.chat, a helpful, concise assistant running locally.",
      "This is a temporary chat: it is not saved and it does not read or update any memory about the user. Treat it as a clean, private session.",
    ].join("\n"),
  };
}

// Fire-and-forget after each turn. One small LLM pass that returns new facts + an updated
// summary. Failures are swallowed (memory is best-effort; the raw log is never at risk).
export async function updateMemory(userId: string, conversationId: string): Promise<void> {
  const recent = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(8)
    .all()
    .reverse();
  if (recent.length === 0) return;

  const existing = userFacts(userId, 60);
  const current = conversationSummary(userId, conversationId) ?? "";
  const transcript = recent.map((m) => `${m.role}: ${m.content}`).join("\n");

  const prompt = [
    "You maintain long-term memory about a user for an assistant.",
    "Given the recent conversation, the facts already known, and the current summary, respond with STRICT JSON only:",
    '{ "newFacts": string[], "summary": string }',
    "newFacts = durable, high-signal facts about the USER not already known (preferences, projects, identity, constraints, goals). Keep each short. Empty array if none.",
    "summary = an updated, concise rolling summary of THIS conversation (<= 80 words).",
    "",
    `Already known facts:\n${existing.map((f) => `- ${f}`).join("\n") || "(none)"}`,
    `Current summary: ${current || "(none)"}`,
    `Recent conversation:\n${transcript}`,
  ].join("\n");

  let raw: string;
  try {
    raw = await backend.complete({
      model: config.defaultModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });
  } catch {
    return;
  }

  const parsed = parseJson(raw);
  if (!parsed) return;

  const newFacts = Array.isArray(parsed.newFacts)
    ? (parsed.newFacts as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 10)
    : [];
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";

  const known = new Set(existing.map(normalize));
  for (const f of newFacts) {
    const t = f.trim();
    if (!t || known.has(normalize(t))) continue;
    known.add(normalize(t));
    db.insert(facts).values({ userId, content: t }).run();
  }

  if (summary) upsertConversationSummary(userId, conversationId, summary);
}

// The shared write for the conversation-scoped rolling summary (two-tier memory's tier 2). One row
// per (user, conversation); an existing row is updated in place. Factored out so both the per-turn
// memory refresh (updateMemory) and the compaction fold (summarizeForCompaction) write the SAME
// summary through ONE path — the machinery is never duplicated.
export function upsertConversationSummary(userId: string, conversationId: string, content: string): void {
  const existing = db
    .select({ id: summaries.id })
    .from(summaries)
    .where(
      and(
        eq(summaries.userId, userId),
        eq(summaries.scope, "conversation"),
        eq(summaries.conversationId, conversationId),
      ),
    )
    .get();
  if (existing) {
    db.update(summaries).set({ content, updatedAt: new Date() }).where(eq(summaries.id, existing.id)).run();
  } else {
    db.insert(summaries).values({ userId, scope: "conversation", conversationId, content }).run();
  }
}

// Compaction (#38): fold the OLDER turns of a conversation into its rolling summary so the model
// prompt can drop them and stay under the context window — WITHOUT deleting a single message (the
// verbatim `messages` log is the source of truth; see the schema note on `compactedThroughMessageId`).
// This REUSES the two-tier memory's rolling-summary storage (`upsertConversationSummary`) and the
// same best-effort LLM approach as updateMemory, folding the turns being dropped INTO the current
// summary. It follows the conversation OWNER (`userId`), never the prompter (memory always follows
// the owner). It DELIBERATELY does not extract durable facts or embeddings: compaction is a
// context-window construct, so it only ever touches THIS conversation's summary — the conversation
// the user is already looking at — never the durable, cross-conversation memory tier gated by
// `memory.enabled`. That is why an explicit, user-initiated compaction is allowed even when
// background memory is off. Returns the new summary, or null on any failure (the caller then leaves
// the conversation uncompacted — nothing was deleted, so declining is always safe).
export async function summarizeForCompaction(
  userId: string,
  conversationId: string,
  foldedTranscript: string,
): Promise<string | null> {
  const current = conversationSummary(userId, conversationId) ?? "";
  const prompt = [
    "You maintain a running summary of a conversation so its older turns can be dropped from the model's context window without losing the thread.",
    "Given the current summary and the older turns being folded away, respond with STRICT JSON only:",
    '{ "summary": string }',
    "summary = a single updated summary that folds the older turns INTO the current summary. Keep every durable decision, fact, name, preference, and still-open thread the later conversation may need. Concise but complete — favor completeness over brevity here (aim for under 200 words).",
    "",
    `Current summary: ${current || "(none)"}`,
    `Older turns being folded:\n${foldedTranscript}`,
  ].join("\n");

  let raw: string;
  try {
    raw = await backend.complete({
      model: config.defaultModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });
  } catch {
    return null;
  }
  const parsed = parseJson(raw);
  const summary = parsed && typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) return null;
  upsertConversationSummary(userId, conversationId, summary);
  return summary;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseJson(raw: string): Record<string, unknown> | null {
  const m = raw.match(/\{[\s\S]*\}/);
  const json = m?.[0];
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

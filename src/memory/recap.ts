import { and, asc, desc, eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { conversationRecaps, type Message, messages } from "../db/schema.ts";
import { backend } from "../jano/client.ts";
import { conversationSummary } from "./service.ts";

// Archivist: conversation recap on return (#37) - "where you left off". When you re-open a
// conversation you last touched long ago, the product already REMEMBERS it (rolling summary +
// verbatim log) but never shows it back at the moment it matters. This module derives a short,
// STRUCTURED recap (topic / progress / where it ended / next step) from THIS conversation's own
// message tail plus its existing rolling summary - never the owner's durable memory facts, so it
// works with memory opted out and reads identically for the owner and a collaborator. The recap
// is generated at most once per (conversation, last message) and CACHED; new activity moves the
// last-message id and re-derives it. Every model call is best-effort: a Jano failure or malformed
// output degrades silently to no recap, and the thread renders normally.

// Show a recap only for a conversation that's both STALE and SUBSTANTIAL - no recap on a fresh
// or trivial chat (the value is reconstructing lost context, which a short/recent thread has not
// lost). These are the two gates from the PRD.
export const RECAP_MIN_MESSAGES = 4;
export const RECAP_STALE_MS = 24 * 60 * 60 * 1000; // 24h since the last message

// The fixed-shape recap. Never a free-text blob: a stable object the card renders section by
// section. `nextStep` is optional (a wrapped-up thread may have none); the rest are required.
export interface Recap {
  topic: string;
  progress: string[];
  whereItEnded: string;
  nextStep?: string;
}

// The active-thread state we gate + key the cache on. `count` and `lastMessageId`/`lastAt` are
// read from the ACTIVE variants only (one message per slot), so a regeneration - which mints a
// new active variant with a new id + timestamp - naturally moves the key and invalidates the
// cache, exactly like a fresh turn does.
interface ThreadState {
  count: number;
  lastMessageId: string;
  lastAt: number; // ms since epoch of the most recent message
}

function threadState(conversationId: string): ThreadState | null {
  const rows = db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.variantActive, true)))
    .orderBy(asc(messages.createdAt))
    .all();
  const last = rows[rows.length - 1];
  if (!last) return null;
  return { count: rows.length, lastMessageId: last.id, lastAt: last.createdAt.getTime() };
}

// The most recent messages along the active thread, oldest-first - the tail we hand the model to
// summarize. Bounded (like updateMemory's window) so a long conversation can't blow up the prompt.
function conversationTail(conversationId: string, limit = 10): Message[] {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.variantActive, true)))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all()
    .reverse();
}

// Pure gate: is this conversation stale AND substantial enough to warrant a recap? Kept a plain
// function of (count, lastActivity) so it's trivially unit-testable and the route/service never
// re-implements the thresholds.
export function recapEligible(messageCount: number, lastActivityAt: number, now = Date.now()): boolean {
  return messageCount >= RECAP_MIN_MESSAGES && now - lastActivityAt >= RECAP_STALE_MS;
}

// Parse a model completion into a valid Recap, or null. Tolerant of prose around the JSON (grabs
// the first {...} like updateMemory does), and strict on the shape: a recap missing its topic,
// its "where it ended", or any progress point is treated as malformed → no recap (degrade
// silently rather than render a half-empty card). Bounds the progress list so a runaway response
// can't bloat the card. `nextStep` is optional and dropped when blank.
export function parseRecap(raw: string): Recap | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const topic = typeof obj.topic === "string" ? obj.topic.trim() : "";
  const whereItEnded = typeof obj.whereItEnded === "string" ? obj.whereItEnded.trim() : "";
  const progress = Array.isArray(obj.progress)
    ? (obj.progress as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, 6)
    : [];
  if (!topic || !whereItEnded || progress.length === 0) return null;
  const nextStep = typeof obj.nextStep === "string" ? obj.nextStep.trim() : "";
  const recap: Recap = { topic, progress, whereItEnded };
  if (nextStep) recap.nextStep = nextStep;
  return recap;
}

// One Jano call → a structured recap, or null on any failure. Reads the conversation's message
// tail plus its existing rolling summary (scoped to the OWNER, whom the summary follows). Never
// touches durable facts / voted examples / cross-conversation recall, so no private memory bleeds
// into a collaborator's view.
export async function generateRecap(conversationId: string, ownerId: string): Promise<Recap | null> {
  const tail = conversationTail(conversationId);
  if (tail.length === 0) return null;
  const summary = conversationSummary(ownerId, conversationId);
  const transcript = tail.map((m) => `${m.role}: ${m.content}`).join("\n");

  const prompt = [
    "You help a user pick a conversation back up after time away.",
    "Given the recent conversation and its running summary, respond with STRICT JSON only:",
    '{ "topic": string, "progress": string[], "whereItEnded": string, "nextStep": string }',
    "topic = one short line naming what this conversation is about.",
    "progress = 2 to 4 short bullet points of what was covered or decided, most important first.",
    "whereItEnded = one short line on the state of things when the conversation last stopped.",
    "nextStep = one short, concrete suggestion for how to resume (empty string if there is no obvious one).",
    "Keep every string tight and factual. Do not invent anything not present in the conversation.",
    "",
    `Running summary: ${summary || "(none)"}`,
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
    return null;
  }
  return parseRecap(raw);
}

// The cached recap for this exact (conversation, last message), or null when there's no row or
// the cache is STALE (the last-message id moved on). A stale cache is a cache miss - the caller
// regenerates. `dismissed` rides along so the caller can honor a dismissal without re-spending.
export function getCachedRecap(
  conversationId: string,
  lastMessageId: string,
): { recap: Recap; dismissed: boolean } | null {
  const row = db
    .select()
    .from(conversationRecaps)
    .where(eq(conversationRecaps.conversationId, conversationId))
    .get();
  if (!row || row.lastMessageId !== lastMessageId) return null;
  const recap = parseRecap(row.payload);
  if (!recap) return null;
  return { recap, dismissed: row.dismissed };
}

// Upsert the cache for a conversation, keyed to the current last message. Storing a fresh recap
// resets `dismissed` (new activity earns a new look). One row per conversation (unique index).
export function storeRecap(conversationId: string, lastMessageId: string, recap: Recap): void {
  const payload = JSON.stringify(recap);
  const existing = db
    .select({ id: conversationRecaps.id })
    .from(conversationRecaps)
    .where(eq(conversationRecaps.conversationId, conversationId))
    .get();
  if (existing) {
    db.update(conversationRecaps)
      .set({ lastMessageId, payload, dismissed: false, updatedAt: new Date() })
      .where(eq(conversationRecaps.id, existing.id))
      .run();
  } else {
    db.insert(conversationRecaps).values({ conversationId, lastMessageId, payload }).run();
  }
}

// Remember that the recap was dismissed for the conversation's CURRENT last message. Scoped to
// that (conversation, lastMessageId) pair, so a dismissal for a since-superseded recap is a clean
// no-op - new activity has already invalidated it and will mint a fresh, un-dismissed recap.
// Returns whether a matching cache row was marked (the route treats it as idempotent regardless).
export function dismissRecap(conversationId: string): boolean {
  const state = threadState(conversationId);
  if (!state) return false;
  const updated = db
    .update(conversationRecaps)
    .set({ dismissed: true, updatedAt: new Date() })
    .where(
      and(
        eq(conversationRecaps.conversationId, conversationId),
        eq(conversationRecaps.lastMessageId, state.lastMessageId),
      ),
    )
    .returning({ id: conversationRecaps.id })
    .all();
  return updated.length > 0;
}

// The one call the GET route makes: the recap to SHOW, or null when there's nothing to show -
//   - not eligible (fresh or under the message floor)           → null
//   - eligible + a fresh cache for this last message            → the cached recap, or null if dismissed
//   - eligible + a stale/absent cache                           → generate once, cache, return (null on model failure)
// `ownerId` is the conversation OWNER - recap follows the owner's rolling summary, never the
// caller's own memory, so it renders identically for the owner and a collaborator.
export async function resolveRecap(
  conversationId: string,
  ownerId: string,
  now = Date.now(),
): Promise<Recap | null> {
  const state = threadState(conversationId);
  if (!state) return null;
  if (!recapEligible(state.count, state.lastAt, now)) return null;

  const cached = getCachedRecap(conversationId, state.lastMessageId);
  if (cached) return cached.dismissed ? null : cached.recap;

  const recap = await generateRecap(conversationId, ownerId);
  if (!recap) return null;
  storeRecap(conversationId, state.lastMessageId, recap);
  return recap;
}

// The on-demand FORCE path behind the `/recap` command (#37, also the built-in test hook). Same
// derivation as resolveRecap - THIS conversation's tail + rolling summary, scoped to the OWNER,
// never durable memory - but bypasses ONLY the staleness gate: a substantial thread can be recapped
// on demand even seconds after the last message. The RECAP_MIN_MESSAGES floor stays as a CONTENT
// floor, so an empty/1-message thread degrades cleanly to null instead of a junk recap. Reuses +
// updates the SAME per-(conversation, lastMessageId) cache, so repeat /recap on an unchanged thread
// serves the stored recap without re-hitting Jano. Unlike resolveRecap it ignores a prior dismissal:
// an explicit command is a deliberate ask to see the recap again. This never widens WHO may see a
// recap - the route still resolves owner-or-collaborator access and passes the owner id.
export async function resolveRecapForced(conversationId: string, ownerId: string): Promise<Recap | null> {
  const state = threadState(conversationId);
  if (!state) return null;
  if (state.count < RECAP_MIN_MESSAGES) return null; // too thin to recap - degrade cleanly

  const cached = getCachedRecap(conversationId, state.lastMessageId);
  if (cached) return cached.recap; // serve the cache even if dismissed - the user explicitly asked

  const recap = await generateRecap(conversationId, ownerId);
  if (!recap) return null;
  storeRecap(conversationId, state.lastMessageId, recap);
  return recap;
}

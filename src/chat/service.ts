import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { AuthContext } from "../auth/middleware.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { type Conversation, conversations, type Message, messages, usageEvents } from "../db/schema.ts";
import { canSpendByokModel } from "../byok/backend.ts";
import { tierOf } from "../entitlements/index.ts";
import { backend } from "../jano/client.ts";
import type { ChatMessage, ModelInfo } from "../jano/types.ts";

export const DEFAULT_MODEL = config.defaultModel;

export class ChatError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

// In-memory concurrency counters. Account users are capped by their snapshotted
// maxConcurrency (default 1) so one account can't fan out parallel load; admin gets a small
// pool.
const inflight = new Map<string, number>();
export function acquireSlot(id: string, max: number): boolean {
  const n = inflight.get(id) ?? 0;
  if (n >= max) return false;
  inflight.set(id, n + 1);
  return true;
}
export function releaseSlot(id: string): void {
  const n = inflight.get(id) ?? 1;
  if (n <= 1) inflight.delete(id);
  else inflight.set(id, n - 1);
}

// Per-caller request limits, derived by TIER (never by auth role text). The privilege split is:
// admin tier → owner-unlimited; the email-login account tier → BOUNDED by the guardrails
// SNAPSHOTTED onto the user at invite redemption (config.freeTier defaults fill any null). This
// is the single place the routes consult, so an account user can never fall into the admin pool.
export interface CallerLimits {
  // Identity to bucket rate-limit + concurrency state under (the user id) — stable for the
  // life of the credential.
  limitId: string;
  maxPerMin: number; // request/minute cap
  maxConcurrency: number; // in-flight generations allowed
  keyId: string | null; // attribution for usage_events (always null now — keys are retired)
}

export function callerLimits(auth: AuthContext): CallerLimits {
  // Admin (the owner by handle, or the dev bootstrap #191) — unmetered pool. Unchanged from before.
  if (tierOf(auth) === "admin") {
    return {
      limitId: auth.user.id,
      maxPerMin: config.rateLimitPerMin * 6,
      maxConcurrency: 4,
      keyId: null,
    };
  }
  // Account tier (email-login): NORMAL rate, the user's snapshotted concurrency (freeTier
  // default when null), bucketed by + attributed to the user, no keyId. NEVER the admin pool.
  return {
    limitId: auth.user.id,
    maxPerMin: config.rateLimitPerMin,
    // Defense-in-depth: floor at 1 so a 0/negative snapshot can never disable the concurrency cap
    // (acquireSlot with max<1 would admit unbounded in-flight generations). Mint-time normalization
    // already prevents storing 0, but a hand-set/legacy row must not slip through.
    maxConcurrency: Math.max(1, auth.user.maxConcurrency ?? config.freeTier.maxConcurrency),
    keyId: null,
  };
}

// Admins see every live model; the account tier is bounded to its SNAPSHOTTED allowlist (the
// user's modelAllowlist, set at redemption), falling back to config.freeTier.models (or just
// the default model). NEVER hand a non-admin the unbounded live list. Enforced here in the app,
// never in Jano.
function freeTierModels(): string[] {
  const m = config.freeTier.models;
  return m.length > 0 ? m : [DEFAULT_MODEL];
}

// Parse a user's snapshotted model allowlist (stored as JSON or CSV). null/blank → the freeTier
// default. Tolerant of both forms so a hand-set value still works.
function userModels(user: AuthContext["user"]): string[] {
  const raw = user.modelAllowlist;
  if (!raw) return freeTierModels();
  const trimmed = raw.trim();
  if (!trimmed) return freeTierModels();
  let parsed: string[] | null = null;
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) parsed = arr.filter((m): m is string => typeof m === "string" && m.length > 0);
    } catch {
      // fall through to CSV
    }
  }
  if (!parsed) parsed = trimmed.split(",").map((m) => m.trim()).filter((m) => m.length > 0);
  return parsed.length > 0 ? parsed : freeTierModels();
}

export async function allowedModels(auth: AuthContext): Promise<string[]> {
  if (tierOf(auth) === "admin") {
    const live = await backend.listModels().catch(() => [] as ModelInfo[]);
    return live.map((m) => m.id);
  }
  return userModels(auth.user);
}

// Friendly display names (id -> label) from Jano, for the model picker. Labels aren't
// sensitive, so this is the full live set; the UI only shows labels for ids it displays.
export async function modelLabels(): Promise<Record<string, string>> {
  const live = await backend.listModels().catch(() => [] as ModelInfo[]);
  const map: Record<string, string> = {};
  for (const m of live) if (m.label && m.label !== m.id) map[m.id] = m.label;
  return map;
}

export function assertModelAllowed(auth: AuthContext, model: string): void {
  if (tierOf(auth) === "admin") return; // only the admin tier is unconstrained
  // Account user: the SNAPSHOTTED allowlist applies (freeTier default when unset).
  if (userModels(auth.user).includes(model)) return;
  // BYOK carve-out (#185): a `provider/model` the caller can actually spend — byok-entitled + a
  // stored key for that provider — is allowed even though it isn't in the local allowlist. It runs
  // on the caller's OWN key/cost via resolveTurnBackend, so it's not gated by the local snapshot;
  // this admits exactly the models the picker now surfaces, on the same fail-closed rule the runner
  // re-checks at spend time (so a picked BYOK model isn't a dead 403).
  if (canSpendByokModel(auth, model)) return;
  throw new ChatError(`model "${model}" is not available on your plan`, 403);
}

// Total tokens an account user has already spent — summed from usage_events (the account's
// budget is tracked there, not in a counter column). Counted ONLY from `usageResetAt` onward:
// the admin "top-up" lever bumps that instant to now(), so past usage stops counting (a reset
// without deleting history). null = count from the beginning of time (epoch 0). Fail-closed: a
// query error returns a number that's safe to compare (0) only if the query truly returned no
// rows; an exception bubbles to the caller.
export function accountTokensUsed(userId: string, usageResetAt: Date | null = null): number {
  // usage_events.created_at is a timestamp_ms column; compare against the reset instant (epoch
  // 0 when no reset has happened) so only post-reset spend is summed.
  const since = usageResetAt ?? new Date(0);
  const row = db
    .select({ total: sql<number>`coalesce(sum(${usageEvents.tokensIn} + ${usageEvents.tokensOut}), 0)` })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, since)))
    .get();
  return row?.total ?? 0;
}

// The effective token budget that bounds this caller, in tokens. 0 means UNMETERED: the admin
// tier is never metered, and an account whose (snapshotted or freeTier) budget is 0/negative has
// the cap disabled — exactly the semantics assertBudget's `budget > 0` guard already encoded. An
// account with no snapshot falls back to the freeTier default. This is the single source of truth
// both the budget gate below and the /api/me usage meter (src/settings/profile.ts) read, so the
// meter a user sees and the limit the server enforces can never drift apart.
export function tokenBudgetFor(auth: AuthContext): number {
  if (tierOf(auth) === "admin") return 0; // the admin tier is unmetered
  // Account user: the SNAPSHOTTED token budget (freeTier default when null).
  return auth.user.tokenBudget ?? config.freeTier.tokenBudget;
}

export function assertBudget(auth: AuthContext): void {
  // 0/negative = disabled/unlimited (admin, or an account with the cap off). Usage is summed live
  // from usage_events for this user, counting only from the account's usageResetAt (top-up lever).
  const budget = tokenBudgetFor(auth);
  if (budget > 0 && accountTokensUsed(auth.user.id, auth.user.usageResetAt) >= budget) {
    throw new ChatError("token budget exhausted", 402);
  }
}

// Create a fresh conversation owned by `userId`. Sending to an EXISTING conversation no
// longer flows through here — `POST /chat` resolves that path through `resolvePromptAccess`
// (owner OR a `prompt` collaborator, #46), so this only ever mints a new one.
export function createConversation(userId: string, model: string) {
  const created = db.insert(conversations).values({ userId, model }).returning().get();
  if (!created) throw new ChatError("failed to create conversation", 500);
  return created;
}

// Fork a conversation at `messageId` into a NEW conversation owned by `userId`, carrying the
// context up to (and including) that message — "branch a chat" (#72). The source must be the
// caller's OWN conversation (owner-scoped, like rename/delete): branching copies content into a
// fresh chat the caller owns, so we don't open a cross-account copy surface here. The fork point
// is a message anywhere on the ACTIVE thread path; we copy the active variant of every slot up to
// and including its slot — regeneration siblings are NOT duplicated, only the selected answer that
// was visible, so the branch is a clean linear snapshot of what the user saw. Derived memory
// (facts/summaries/embeddings) is deliberately NOT carried: the branch is a fresh thread that grows
// its own memory on the next turn (and owner-global facts already apply — same owner). Returns the
// new conversation, or null when the source isn't the caller's or the fork point isn't in it (the
// route surfaces null as a 404, so ownership is never an existence oracle).
export function branchConversation(userId: string, conversationId: string, messageId: string): Conversation | null {
  // Owner-scoped source lookup — a non-owner (or unknown id) is indistinguishable from "not found".
  const source = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .get();
  if (!source) return null;

  // Locate the fork point on the active thread. Match by ANY variant id in the slot (the client
  // sends the active/displayed message id, but a stale variant id still resolves to its slot), then
  // keep every slot up to and including it.
  const slots = thread(conversationId);
  const cut = slots.findIndex((s) => s.variants.some((v) => v.id === messageId));
  if (cut < 0) return null; // the fork point isn't a message in this conversation
  const kept = slots.slice(0, cut + 1);

  // Copy in one transaction so a partial branch can never surface. Stamp each copied message with a
  // strictly-increasing time anchored to the source slot's position (`slotAt`): this preserves the
  // real chronology whenever the source is already well-ordered (the common case) yet guarantees
  // distinct, ordered timestamps, so `thread()` lays the branch out deterministically even if two
  // source slots happened to share a millisecond (a regenerate can make `slotAt` collide).
  return db.transaction((tx) => {
    const created = tx
      .insert(conversations)
      // Inherit the source title (so the branch is recognizable in the sidebar) + model; the row's
      // own createdAt/updatedAt default to now(), so it sorts to the top as a brand-new chat.
      .values({ userId, title: source.title, model: source.model })
      .returning()
      .get();
    if (!created) throw new ChatError("failed to branch conversation", 500);

    let prev = 0;
    for (const slot of kept) {
      const at = Math.max(slot.slotAt, prev + 1);
      prev = at;
      const m = slot.active;
      tx.insert(messages)
        .values({
          conversationId: created.id,
          userId, // the new owner — every copied row is scoped to the caller
          role: m.role,
          content: m.content,
          model: m.model,
          // Attachment metadata (display-only, never bytes) rides along so the branched transcript
          // shows what was attached; the file ids belong to the same owner. Votes/token counts and
          // regeneration variants are intentionally reset — a branch starts clean.
          attachments: m.attachments,
          createdAt: new Date(at),
        })
        .run();
    }
    return created;
  });
}

// One position in the linear conversation. When an answer is regenerated, its slot
// holds several variants (the original + each retry); `active` is the selected one.
export interface ThreadSlot {
  active: Message;
  variants: Message[]; // all variants in the slot, oldest → newest
  slotAt: number; // root message's createdAt (ms) — the slot's stable position
}

// Collapse the raw message log into the linear thread of active variants. Regenerated
// siblings (variantOf set) fold into their root's slot; the slot is positioned by the
// root's creation time so a late retry doesn't jump ahead of later turns.
export function thread(conversationId: string): ThreadSlot[] {
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();

  const groups = new Map<string, Message[]>();
  for (const r of rows) {
    const key = r.variantOf ?? r.id; // slot key = the root message id
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const slots: ThreadSlot[] = [];
  for (const [key, variants] of groups) {
    variants.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const root = variants.find((v) => v.id === key) ?? variants[0];
    if (!root) continue; // unreachable: a group is only created with ≥1 member
    const active = variants.find((v) => v.variantActive) ?? variants[variants.length - 1] ?? root;
    slots.push({ active, variants, slotAt: root.createdAt.getTime() });
  }
  slots.sort((a, b) => a.slotAt - b.slotAt);
  return slots;
}

// The index of the first slot AFTER a compaction boundary (#38) — slots at/before it have been
// FOLDED into the rolling summary and are dropped from the model prompt. The boundary id is matched
// against ANY variant in a slot (so regenerating a folded answer still resolves its slot). A
// missing/absent/gone boundary returns 0 — fail-safe: we send the whole thread rather than risk
// dropping turns the summary might not cover. Compaction never deletes messages, so this only ever
// changes which turns the PROMPT carries, not what the transcript shows.
export function compactionStartIndex(slots: ThreadSlot[], compactedThroughMessageId: string | null | undefined): number {
  if (!compactedThroughMessageId) return 0;
  const idx = slots.findIndex((s) => s.variants.some((v) => v.id === compactedThroughMessageId));
  return idx < 0 ? 0 : idx + 1;
}

// Prior history (verbatim) along the active path, from the compaction boundary onward. Memory
// injection (facts + rolling summary + semantic recall) is layered into the system prompt
// separately — and after compaction the rolling summary is what REPRESENTS the folded pre-boundary
// turns, so dropping them here isn't lossy: the model still gets that context, compacted. Passing no
// boundary (or a stale one) sends the full thread.
export function history(conversationId: string, compactedThroughMessageId?: string | null): ChatMessage[] {
  const slots = thread(conversationId);
  const start = compactionStartIndex(slots, compactedThroughMessageId);
  return slots.slice(start).map((s) => ({ role: s.active.role, content: s.active.content }));
}

// Derive a short, ChatGPT-style title (a few words) for a fresh conversation from its
// first exchange. Best-effort: returns null on any failure so titling never breaks a
// turn — the conversation simply stays "Untitled" until the next attempt.
export async function generateTitle(
  userMessage: string,
  assistantReply: string,
): Promise<string | null> {
  const prompt = [
    "Write a short, specific title for this conversation: 3 to 6 words summarizing the topic.",
    "Respond with ONLY the title — no quotes, no surrounding punctuation, no preamble.",
    "",
    `User: ${userMessage.slice(0, 1000)}`,
    `Assistant: ${assistantReply.slice(0, 1000)}`,
  ].join("\n");

  let raw: string;
  try {
    raw = await backend.complete({
      model: config.defaultModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });
  } catch {
    return null;
  }
  return cleanTitle(raw);
}

// (Re)generate a title for an existing conversation from its first exchange — backs the
// manual "Generate title" menu action for when the automatic post-turn titling didn't
// take. Reuses the same earliest-user + earliest-assistant heuristic as the first turn,
// and returns null (so the caller can 422) when there's no exchange to summarize yet.
export async function regenerateConversationTitle(conversationId: string): Promise<string | null> {
  const slots = thread(conversationId);
  const userMessage = slots.find((s) => s.active.role === "user")?.active.content ?? "";
  const assistantReply = slots.find((s) => s.active.role === "assistant")?.active.content ?? "";
  if (!userMessage || !assistantReply) return null;
  return generateTitle(userMessage, assistantReply);
}

// Normalize a model's title output: first non-empty line, stripped of quotes, a leading
// "Title:" label and trailing sentence punctuation, then bounded to a few words' worth.
function cleanTitle(raw: string): string | null {
  let t = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  t = t.replace(/^title\s*[:\-]\s*/i, "");
  t = t.replace(/^["'`*_]+|["'`*_]+$/g, "").trim();
  t = t.replace(/[.!?,;:]+$/g, "").trim();
  t = t.replace(/\s+/g, " ");
  if (!t) return null;
  if (t.length > 70) t = t.slice(0, 70).trim();
  return t;
}


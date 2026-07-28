import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db/index.ts";
import { conversations, messages, usageEvents, users } from "../db/schema.ts";
import { config } from "../config.ts";
import {
  assertFeature,
  type EntitlementError,
  entitlementJson,
  requireFeature,
} from "../entitlements/index.ts";
import { resolveTurnBackend } from "../byok/backend.ts";
import { byokModelsFor } from "../byok/models.ts";
import type { MergedModel } from "../models/types.ts";
import {
  applyUserPartsToLast,
  attachmentsMeta,
  attachmentsPromptBlock,
  MAX_PROMPT_ATTACHMENTS,
  multimodalUserParts,
  parseStoredAttachments,
  type ResolvedAttachment,
  resolveAttachments,
} from "../files/prompt.ts";
import type { ChatMessage } from "../jano/types.ts";
import { modelAcceptsImages } from "../models/catalog.ts";
import { embedConversation, recall } from "../memory/recall.ts";
import { dismissRecap, resolveRecap, resolveRecapForced } from "../memory/recap.ts";
import {
  buildSystemPrompt,
  ephemeralSystemPrompt,
  memoryEnabledFor,
  summarizeForCompaction,
  updateMemory,
  withRegenerateSteering,
} from "../memory/service.ts";
import { planCompaction } from "./compaction.ts";
import { conversationContextUsage } from "./context.ts";
import { runWebSearch, searchAvailableFor } from "../search/index.ts";
import { parseStoredPreferences, personaSystemPrompt } from "../settings/preferences.ts";
import { parseCommand } from "./commands.ts";
import { beginLive, getLive, liveIdsFor, stopLive, streamLive } from "./live.ts";
import { acquireGenerationSlot } from "./queue.ts";
import { allowRequest } from "./ratelimit.ts";
import * as svc from "./service.ts";
import { createShare, deleteShare, getShareForConversation, shareUrl } from "./shares.ts";
import {
  canEditContent,
  isCollaboratorRole,
  inviteCollaborator,
  listCollaborators,
  listSharedWithUser,
  removeCollaborator,
  resolveConversationAccess,
  resolvePromptAccess,
  updateCollaboratorRole,
} from "./collaborators.ts";
import { toggleConversationTodo } from "./todos.ts";
import { track } from "../telemetry/index.ts";

const chat = new Hono();

// Models this caller may use. Jano's local list PLUS the caller's own BYOK models (#185) — each
// configured provider's models (id `provider/model`, its display label), so a stored key is
// pickable in the composer. `byokModelsFor` swallows per-provider failures; the `.catch` is a
// backstop so a BYOK hiccup can never drop the local models from the picker.
chat.get("/models", requireFeature("chat.send"), async (c) => {
  const auth = c.get("auth");
  const [models, labels, byok] = await Promise.all([
    svc.allowedModels(auth),
    svc.modelLabels(),
    byokModelsFor(auth).catch(() => [] as MergedModel[]),
  ]);
  const byokLabels: Record<string, string> = {};
  for (const m of byok) byokLabels[m.id] = m.displayName;
  return c.json({
    models: [...models, ...byok.map((m) => m.id)],
    labels: { ...labels, ...byokLabels },
    default: svc.DEFAULT_MODEL,
  });
});

// The caller's conversations (scoped). `generating` flags the ones with a live turn
// still streaming so the sidebar can show its crunching indicator after a refresh.
chat.get("/conversations", requireFeature("conversations.read"), (c) => {
  const auth = c.get("auth");
  const rows = db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, auth.user.id))
    .orderBy(desc(conversations.updatedAt))
    .all();
  const liveIds = liveIdsFor(auth.user.id);
  return c.json({ conversations: rows.map((r) => ({ ...r, generating: liveIds.has(r.id) })) });
});

// Conversations shared WITH the caller (the Share primitive's "shared with me"). These are
// other people's chats the caller was invited to collaborate on — identity-bound grants that
// surface in the invitee's own app. Each row carries the caller's role + the owner's display
// name (never the owner's email or other accounts). `generating` flags one streaming live so
// the list mirrors the owned-conversation sidebar.
chat.get("/shared-conversations", requireFeature("conversations.read"), (c) => {
  const auth = c.get("auth");
  const shared = listSharedWithUser(auth.user.id);
  return c.json({
    conversations: shared.map((s) => {
      const live = getLive(s.id);
      return { ...s, generating: !!live && live.status === "running" };
    }),
  });
});

// One conversation + its messages (scoped). Regenerated answers are folded into a
// single slot: the active variant is rendered inline, the full set is attached as
// `variants` so the client can offer the ◀ n/m ▶ navigation.
chat.get("/conversations/:id", requireFeature("conversations.read"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  // Owner OR collaborator: the Share primitive opens this read to any account the owner
  // invited (an identity-bound grant), resolved in one seam. null = no access at all → 404
  // (same response as before for a non-owner, so this never becomes an existence oracle).
  const access = resolveConversationAccess(auth.user.id, id);
  if (!access) return c.json({ error: "not found" }, 404);
  const conv = access.conversation;
  const slots = svc.thread(id);
  const msgs = slots.map((s) => {
    const m = s.active;
    const base = {
      id: m.id,
      role: m.role,
      content: m.content,
      // The persisted thinking (#68), so the collapsed "Reasoning" section survives a reload.
      reasoning: m.reasoning,
      model: m.model,
      vote: m.vote,
      createdAt: m.createdAt,
      // files-to-prompt (#128): the attachments this (user) message carried, for the transcript.
      attachments: parseStoredAttachments(m.attachments),
    };
    if (s.variants.length < 2) return base;
    return {
      ...base,
      variants: s.variants.map((v) => ({ id: v.id, content: v.content, vote: v.vote, reasoning: v.reasoning, model: v.model })),
      activeIndex: s.variants.findIndex((v) => v.id === m.id),
    };
  });
  // A turn is live for THIS conversation regardless of which collaborator owns the generation
  // (the owner runs it; a watcher sees it). Access is already resolved above, so it's safe to
  // report the live state to anyone admitted here.
  const live = getLive(id);
  const generating = !!live && live.status === "running";
  // Context-window usage (#38): the effective prompt size against the active model's window, so the
  // composer can show the usage meter and — near the limit — the "Compact" nudge. Owner-scoped
  // summary (memory follows the owner), so a collaborator reads the same value.
  const context = conversationContextUsage({
    slots,
    ownerId: conv.userId,
    conversationId: id,
    model: conv.model,
    compactedThroughMessageId: conv.compactedThroughMessageId,
  });
  // `access` tells the client the caller's role on this object ("owner" | a collaborator role)
  // so it can show the right affordances (owner-only controls, read-only banner for a watcher).
  return c.json({ conversation: { ...conv, generating, access: access.role, context }, messages: msgs });
});

// Reattach to a turn still generating for this conversation — used after a page refresh
// to resume the thinking indicator and streaming text. Streams the same
// meta/delta/done/error protocol as POST /chat, replaying whatever has been produced so
// far. 204 when nothing is generating right now (the client then reconciles from the
// persisted thread).
chat.get("/conversations/:id/stream", requireFeature("conversations.read"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  // Owner OR collaborator (the Share primitive) — a watcher reattaches to the SAME live turn the
  // owner is running, which is the real-time sync between collaborators. streamLive is read-only
  // (watchers are pure listeners — no stop/inject path), so admitting a collaborator here can
  // only ever forward output, never affect the generation.
  const access = resolveConversationAccess(auth.user.id, id);
  if (!access) return c.json({ error: "not found" }, 404);
  const live = getLive(id);
  if (!live) return c.body(null, 204);
  return streamLive(c, live);
});

// Stop the live turn for a conversation (the Stop button). The turn runs server-side
// independent of any one client, so aborting a local stream alone won't halt it.
chat.post("/conversations/:id/stop", requireFeature("chat.send"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  return c.json({ ok: stopLive(id, auth.user.id) });
});

// Update a conversation — rename and/or (un)star (scoped to the caller).
chat.patch("/conversations/:id", requireFeature("conversations.write"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; starred?: boolean };
  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, auth.user.id)))
    .get();
  if (!conv) return c.json({ error: "not found" }, 404);

  const updates: { title?: string; starred?: boolean } = {};
  if (typeof body.title === "string") {
    const title = body.title.trim();
    if (!title) return c.json({ error: "empty title" }, 400);
    updates.title = title.slice(0, 200);
  }
  if (typeof body.starred === "boolean") updates.starred = body.starred;
  if (Object.keys(updates).length === 0) return c.json({ error: "nothing to update" }, 400);

  db.update(conversations).set(updates).where(eq(conversations.id, id)).run();
  return c.json({ ok: true, ...updates });
});

// (Re)generate a conversation's title from its first exchange — backs the "Generate
// title" menu action for when the automatic post-turn titling didn't take. Unlike the
// automatic path this overwrites any existing title, since the user explicitly asked.
chat.post("/conversations/:id/title", requireFeature("conversations.write"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, auth.user.id)))
    .get();
  if (!conv) return c.json({ error: "not found" }, 404);
  const title = await svc.regenerateConversationTitle(id).catch(() => null);
  if (!title) return c.json({ error: "could not generate a title" }, 422);
  db.update(conversations).set({ title }).where(eq(conversations.id, id)).run();
  return c.json({ ok: true, title });
});

// Delete a conversation and its messages (scoped to the caller). Cascades clear
// messages/summaries; usage events keep their rows with conversation_id nulled.
chat.delete("/conversations/:id", requireFeature("conversations.write"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, auth.user.id)))
    .get();
  if (!conv) return c.json({ error: "not found" }, 404);
  db.delete(conversations).where(eq(conversations.id, id)).run();
  return c.json({ ok: true });
});

// Branch a conversation at a message into a NEW chat (#72) — fork the thread to explore a tangent
// without touching the main thread. Owner-scoped (svc.branchConversation only forks the caller's
// OWN conversation): the copy lands in a fresh chat the caller owns, so there's no cross-account
// surface. The body carries the fork-point `messageId`; the new conversation copies the active
// thread up to and including it. A missing/blank id is a 400; a source that isn't the caller's OR a
// fork point not in it is a 404 — the same response a stranger sees, so ownership is never an
// existence oracle. Gated on `conversations.write` (creating a conversation is a write action).
chat.post("/conversations/:id/branch", requireFeature("conversations.write"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { messageId?: unknown } | null;
  if (!body || typeof body.messageId !== "string" || body.messageId.length === 0) {
    return c.json({ error: "bad request" }, 400);
  }
  let created;
  try {
    created = svc.branchConversation(auth.user.id, id, body.messageId);
  } catch (e) {
    // The copy runs in one transaction (rolled back on failure); surface a clean JSON 500 rather
    // than a bare error, mirroring how the send path wraps createConversation.
    const err = e as svc.ChatError;
    return c.json({ error: err.message ?? "failed to branch conversation" }, (err.status ?? 500) as 500);
  }
  if (!created) return c.json({ error: "not found" }, 404);
  track({ type: "conversation.branch", userId: auth.user.id, conversationId: id, meta: { branchId: created.id } });
  return c.json({
    conversation: { id: created.id, title: created.title, model: created.model, starred: created.starred, updatedAt: created.updatedAt },
  });
});

// Tick/untick a TODO checkbox on a message in a conversation the caller may write to (#131) —
// the owner-side counterpart of the public share toggle (POST /api/share/:slug/todo). Same
// single-checkbox primitive (`toggleConversationTodo` → `setTaskItem`), but authorized through the
// normal auth gate + `resolveConversationAccess` (the ONE seam) instead of a share write token:
// the owner, or a collaborator whose role includes `edit` (canEditContent). A read-only
// collaborator (view/suggest) is a clean 403; no access at all is a 404 — the same response a
// stranger sees, so ownership is never an existence oracle. The toggle is scoped to a message in
// THIS conversation and flips a single checkbox — never arbitrary content, never another chat.
chat.post("/conversations/:id/todo", requireFeature("conversations.write"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");

  // Validate the payload shape first: a message id, a non-negative item index, and target state.
  const body = (await c.req.json().catch(() => null)) as
    | { messageId?: unknown; index?: unknown; done?: unknown }
    | null;
  if (
    !body ||
    typeof body.messageId !== "string" ||
    typeof body.index !== "number" ||
    typeof body.done !== "boolean"
  ) {
    return c.json({ error: "bad request" }, 400);
  }

  // Owner OR an edit/prompt collaborator may write; a read-only grant is a 403, no access a 404.
  const access = resolveConversationAccess(auth.user.id, id);
  if (!access) return c.json({ error: "not found" }, 404);
  if (access.role !== "owner" && !canEditContent(access.role)) {
    return c.json({ error: "you don't have permission to edit this conversation" }, 403);
  }

  // Apply the toggle, scoped to this conversation. A missing message or an out-of-range index is
  // a clean 404 no-op (no existence oracle, no partial write).
  const result = toggleConversationTodo(id, body.messageId, body.index, body.done);
  if (!result) return c.json({ error: "not found" }, 404);

  track({ type: "conversation.todo", userId: auth.user.id, conversationId: id, meta: { done: body.done } });
  return c.json({ ok: true, content: result.content });
});

// --- Compact conversation, context-aware (#38) ----------------------------------------
// Fold a conversation's OLDER turns into its rolling summary so the thread fits the active model's
// context window — WITHOUT deleting a single message. Compaction is a CONTEXT-WINDOW construct: the
// verbatim `messages` log stays intact, and this only stamps a boundary so `svc.history` replaces
// the pre-boundary turns with the summary when building later model prompts (the transcript still
// shows everything). Owner-only, ownership-checked like rename/delete/title (compaction writes the
// OWNER's rolling summary + a conversation-level boundary — memory always follows the owner); a
// non-owner / unknown id is a 404 (no existence oracle). Default behavior is PROMPT-to-compact: the
// client shows the near-limit nudge and calls this only on the user's tap — there is NO silent
// auto-compaction (that is a later opt-in). Gated on `conversations.write`, the same open
// owner-management seam as the LLM-spending title regeneration.
chat.post("/conversations/:id/compact", requireFeature("conversations.write"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, auth.user.id)))
    .get();
  if (!conv) return c.json({ error: "not found" }, 404);

  // Decide the boundary from the active thread: keep the recent turns verbatim, fold the rest.
  const slots = svc.thread(id);
  const activeTurns = slots.map((s) => ({ id: s.active.id, role: s.active.role, content: s.active.content }));
  const plan = planCompaction(activeTurns);
  // Nothing worth folding yet (a short thread) — a clean 422, mirroring the title route's "no
  // exchange to summarize".
  if (!plan) return c.json({ error: "not enough conversation to compact yet" }, 422);

  // Transcript of the turns being folded (up to and including the boundary), handed to the memory
  // service to fold INTO the rolling summary — reusing the two-tier memory machinery, never
  // extracting durable facts (see summarizeForCompaction). Follows the OWNER (== the caller here,
  // since this is owner-only).
  const foldedTranscript = slots
    .slice(0, plan.foldedCount)
    .map((s) => `${s.active.role}: ${s.active.content}`)
    .join("\n");
  const summary = await summarizeForCompaction(auth.user.id, id, foldedTranscript);
  // The summarizer failed (Jano down / malformed output): leave the conversation UNCOMPACTED rather
  // than fold turns with no summary to represent them. Nothing was written, so this is a safe no-op.
  if (!summary) return c.json({ error: "could not compact right now" }, 502);

  // Record the boundary. From here svc.history drops the folded turns from the model prompt and the
  // rolling summary stands in for them; every stored message is still there (nothing was deleted).
  db.update(conversations)
    .set({ compactedThroughMessageId: plan.boundaryId })
    .where(eq(conversations.id, id))
    .run();

  // The post-compaction usage snapshot (re-reads the fresh summary + the new boundary), so the
  // client updates its meter and hides the nudge without a refetch.
  const context = conversationContextUsage({
    slots,
    ownerId: conv.userId,
    conversationId: id,
    model: conv.model,
    compactedThroughMessageId: plan.boundaryId,
  });
  track({ type: "conversation.compact", userId: auth.user.id, conversationId: id, meta: { foldedCount: plan.foldedCount } });
  return c.json({ ok: true, foldedCount: plan.foldedCount, context });
});

// --- Archivist: conversation recap on return (#37) ------------------------------------
// "Where you left off." Re-opening a conversation whose last activity is >= 24h old and that has
// >= 4 messages returns a structured, dismissible recap (topic / progress / where it ended / next
// step). Derived ONCE per (conversation, last message) from THIS conversation's own message tail +
// its rolling summary (never the owner's durable memory), then cached; new activity re-derives it.
// Access-resolved like the read route (owner OR collaborator, via the ONE seam), so it renders
// identically for both and a stranger's/unknown id is a 404 (no existence oracle). NOT
// entitlement-walled: archivist is a core pillar, never a paywall (mirrors /api/memory). A Jano
// failure or malformed model output degrades silently to `recap: null` and the thread renders
// normally. No new capability marker; this is a UI surface, not a chat-stream artifact.
chat.get("/conversations/:id/recap", requireFeature("conversations.read"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const access = resolveConversationAccess(auth.user.id, id);
  if (!access) return c.json({ error: "not found" }, 404);
  // `?force=1` is the on-demand `/recap` command (#37): derive + show the recap now, bypassing ONLY
  // the 24h staleness gate - never the auth/owner-memory scoping, which stays exactly as the default
  // read. Same access resolution, same owner id, so a stranger is still a 404 (no existence oracle)
  // and a collaborator still sees the OWNER's recap and nothing more. Recap follows the conversation
  // OWNER's rolling summary (like every memory read), so no private memory bleeds across the share.
  const force = c.req.query("force") === "1";
  const recap = force
    ? await resolveRecapForced(id, access.conversation.userId)
    : await resolveRecap(id, access.conversation.userId);
  return c.json({ recap });
});

// Dismiss the recap for the conversation's CURRENT last message; remembered until new activity
// mints a fresh recap. Access-resolved the same way (a stranger/unknown id is a 404). Idempotent:
// a stale/absent cache row is a clean no-op.
chat.post("/conversations/:id/recap/dismiss", requireFeature("conversations.read"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const access = resolveConversationAccess(auth.user.id, id);
  if (!access) return c.json({ error: "not found" }, 404);
  dismissRecap(id);
  return c.json({ ok: true });
});

// --- Shareable-live-collab (opt-in public watch link) ---------------------------------
// Owner-side share management. The PUBLIC read/stream endpoints live under /api/share (no
// auth); these three are gated (the conversation must be the caller's) so only the owner can
// open, inspect, or revoke a share. `conversations.share` is the entitlement seam (open today,
// a tier lever later).

// Current share status for a conversation the caller owns (drives the share button's state).
chat.get("/conversations/:id/share", requireFeature("conversations.share"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, auth.user.id)))
    .get();
  if (!conv) return c.json({ error: "not found" }, 404);
  const existing = getShareForConversation(auth.user.id, id);
  if (!existing) return c.json({ shared: false, slug: null, url: null });
  return c.json({ shared: true, slug: existing.slug, url: shareUrl(existing.slug) });
});

// Opt in to sharing (idempotent: re-sharing returns the same stable link).
chat.post("/conversations/:id/share", requireFeature("conversations.share"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const created = createShare(auth.user.id, id);
  if (!created) return c.json({ error: "not found" }, 404);
  track({ type: "share.create", userId: auth.user.id, conversationId: id });
  return c.json({ shared: true, slug: created.slug, url: shareUrl(created.slug) });
});

// Stop sharing (deletes the link — the old slug dies immediately).
chat.delete("/conversations/:id/share", requireFeature("conversations.share"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, auth.user.id)))
    .get();
  if (!conv) return c.json({ error: "not found" }, 404);
  deleteShare(auth.user.id, id);
  return c.json({ ok: true, shared: false });
});

// --- Share primitive: identity-bound collaborators -------------------------------------
// The owner invites SPECIFIC accounts (by their public HANDLE, #189) to collaborate on the SAME
// conversation — distinct from the public watch link above (that's no-login + link-based). These
// four endpoints are owner-only: every helper re-checks the conversation is the caller's and 404s
// otherwise, so a non-owner can never enumerate or alter another chat's collaborators.
// `conversations.collaborate` is the entitlement seam (open today, a tier lever later).

// Who the caller has shared this conversation with (drives the "manage people" UI).
chat.get("/conversations/:id/collaborators", requireFeature("conversations.collaborate"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const list = listCollaborators(auth.user.id, id);
  if (list === null) return c.json({ error: "not found" }, 404);
  return c.json({ collaborators: list });
});

// Invite an existing account (by its public handle, #189) at a role. Idempotent: re-inviting
// updates the role. Resolving by handle (not email) is what lets a passkey account be invited (#177).
chat.post("/conversations/:id/collaborators", requireFeature("conversations.collaborate"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { handle?: string; role?: string };
  const handle = (body.handle ?? "").trim();
  if (!handle) return c.json({ error: "a handle is required" }, 400);
  // Default to the safest role (view) when unspecified; reject any unknown role value.
  const role = body.role ?? "view";
  if (!isCollaboratorRole(role)) return c.json({ error: "invalid role" }, 400);

  const result = inviteCollaborator(auth.user.id, id, handle, role);
  if (!result.ok) {
    // `reason` lets the client localize the message (no_account / self) while not_owner stays a
    // bare 404 — same response a stranger would see, so ownership is never an existence oracle.
    if (result.reason === "not_owner") return c.json({ error: "not found", reason: "not_owner" }, 404);
    if (result.reason === "self") return c.json({ error: "you already own this conversation", reason: "self" }, 400);
    return c.json({ error: "no account with that handle", reason: "no_account" }, 404);
  }
  track({ type: "collaborator.invite", userId: auth.user.id, conversationId: id, meta: { role } });
  return c.json({ ok: true, collaborator: { userId: result.collaborator.userId, role: result.collaborator.role } });
});

// Change a collaborator's role (owner-only).
chat.patch("/conversations/:id/collaborators/:userId", requireFeature("conversations.collaborate"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const collaboratorUserId = c.req.param("userId");
  const body = (await c.req.json().catch(() => ({}))) as { role?: string };
  if (!isCollaboratorRole(body.role)) return c.json({ error: "invalid role" }, 400);
  if (!updateCollaboratorRole(auth.user.id, id, collaboratorUserId, body.role)) {
    return c.json({ error: "not found" }, 404);
  }
  track({ type: "collaborator.role", userId: auth.user.id, conversationId: id, meta: { role: body.role } });
  return c.json({ ok: true, role: body.role });
});

// Revoke a collaborator (owner-only) — the grant is deleted, so access dies on their next call.
chat.delete("/conversations/:id/collaborators/:userId", requireFeature("conversations.collaborate"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const collaboratorUserId = c.req.param("userId");
  if (!removeCollaborator(auth.user.id, id, collaboratorUserId)) {
    return c.json({ error: "not found" }, 404);
  }
  track({ type: "collaborator.remove", userId: auth.user.id, conversationId: id });
  return c.json({ ok: true });
});

// Main turn. Handles `/model` commands inline (no LLM call); otherwise streams SSE.
chat.post("/chat", requireFeature("chat.send"), async (c) => {
  const auth = c.get("auth");

  // `temporary` marks a ghost chat: nothing is persisted and `history` carries the
  // prior turns (the client holds the transcript, since the server keeps no record).
  let body: {
    conversationId?: string;
    content?: string;
    model?: string;
    temporary?: boolean;
    search?: boolean;
    // Composer "Thinking" toggle (#68 follow-up): opt in to `enable_thinking` for this turn.
    thinking?: boolean;
    history?: { role?: string; content?: string }[];
    // files-to-prompt (#128): ids of the caller's uploaded files to deliver into this turn.
    fileIds?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const content = (body.content ?? "").trim();
  if (!content) return c.json({ error: "empty message" }, 400);

  // Web search ("Research"): honored only when the caller is actually entitled + a
  // provider is configured (defense in depth — never trust the client to have hidden the
  // toggle). When off, this whole path is skipped and the turn is a plain generation.
  const wantSearch = body.search === true && searchAvailableFor(auth);

  // Composer "Thinking" toggle (#68 follow-up): request reasoning from the model via
  // `enable_thinking` when the caller flipped it on. No entitlement/availability gate — the param
  // is best-effort and graceful (a model that ignores it just answers), so unlike Search there's
  // nothing to withhold. Off/absent ⇒ today's behavior. The always-on reasoning display (#68)
  // renders whatever reasoning the model emits either way; this only asks it to reason.
  const wantThinking = body.thinking === true;

  const conversationOf = (id: string) =>
    db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, auth.user.id)))
      .get();

  // --- /model commands (server-side, no generation) ---
  const cmd = parseCommand(content);
  if (cmd.kind === "model.list") {
    const conv = body.conversationId ? conversationOf(body.conversationId) : null;
    // Parity with the picker (#185): the `/model` list also carries the caller's BYOK model ids.
    const [allowed, byok] = await Promise.all([
      svc.allowedModels(auth),
      byokModelsFor(auth).catch(() => [] as MergedModel[]),
    ]);
    return c.json({
      type: "command",
      command: "model.list",
      models: [...allowed, ...byok.map((m) => m.id)],
      current: conv?.model ?? svc.DEFAULT_MODEL,
    });
  }
  if (cmd.kind === "model.set") {
    // Switching the conversation's model is its own gated feature; the per-key model
    // allowlist (assertModelAllowed) is a separate quota check on top.
    try {
      assertFeature(auth, "chat.model_switch");
    } catch (e) {
      return entitlementJson(c, e as EntitlementError);
    }
    try {
      svc.assertModelAllowed(auth, cmd.model);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }
    // A ghost chat has no conversation row to persist the choice on; the client tracks
    // the model and sends it with each turn, so just confirm the switch.
    if (body.temporary) return c.json({ type: "command", command: "model.set", model: cmd.model });
    if (!body.conversationId) return c.json({ error: "open a conversation first" }, 400);
    const conv = conversationOf(body.conversationId);
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    db.update(conversations).set({ model: cmd.model, updatedAt: new Date() }).where(eq(conversations.id, conv.id)).run();
    return c.json({ type: "command", command: "model.set", model: cmd.model });
  }

  // --- normal chat turn ---
  try {
    svc.assertBudget(auth);
  } catch (e) {
    const err = e as svc.ChatError;
    return c.json({ error: err.message }, err.status as 402);
  }

  // files-to-prompt (#128): normalize the requested attachment ids (strings only, de-duped +
  // bounded downstream), then — if any — gate on the `files` entitlement (delivering a file's
  // content is a files-entitled action, mirroring BYOK's re-check at spend) and resolve them SCOPED
  // to the caller. An id that isn't the caller's / doesn't exist is a generic 400 (never a 404 —
  // the client reserves 404 for "conversation gone → redirect home" — and never distinguishing
  // stranger-vs-missing, so it's no existence oracle), rejected BEFORE the slot/persist so an
  // invalid attachment is a clean no-op. Resolution runs for BOTH the ghost and persisted paths
  // below; the resolved text is inlined into the model context, the metadata persisted on the user
  // message (persisted turns only — a ghost chat stores nothing).
  const fileIds = Array.isArray(body.fileIds)
    ? body.fileIds.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, MAX_PROMPT_ATTACHMENTS)
    : [];
  let attachments: ResolvedAttachment[] = [];
  if (fileIds.length > 0) {
    try {
      assertFeature(auth, "files");
    } catch (e) {
      return entitlementJson(c, e as EntitlementError);
    }
    // Deliver attached images to the model as multimodal parts (#235) only when the turn's model can
    // read images (Omni). Resolve the SAME model the turn will actually run on: an explicit body.model,
    // else the conversation's stored model (an existing chat can be Omni while the request omits the
    // model), else the default - mirroring the ghost/persisted model resolution below so delivery never
    // silently no-ops on an Omni conversation. The client gates the attach affordance the same way; this
    // is the server-side re-check.
    const turnModel =
      body.model ?? (body.conversationId ? conversationOf(body.conversationId)?.model : null) ?? svc.DEFAULT_MODEL;
    const deliverImages = modelAcceptsImages(turnModel);
    const resolved = await resolveAttachments(auth.user.id, fileIds, undefined, { deliverImages });
    if (!resolved.ok) return c.json({ error: "one or more attached files are unavailable" }, 400);
    attachments = resolved.items;
  }
  const filesBlock = attachmentsPromptBlock(attachments);
  // The image parts for THIS turn's user message (null when no image was delivered). Used to attach
  // images to the user message in both the ghost path (constructed inline) and the persisted path
  // (the current user turn comes from the stored thread — see applyUserPartsToLast).
  const userParts = multimodalUserParts(content, attachments);

  // --- temporary (ghost) chat turn ---
  // Nothing is persisted: no conversation, no messages, no memory, no embeddings. The
  // client holds the transcript and replays it as `history`, so the server is stateless
  // for ghost chats. The model context is built from a clean system prompt (no memory is
  // read) and the request alone, and the upstream call is marked do-not-train. We still
  // enforce budget / rate limit / concurrency and tally tokens — those record counts only,
  // never any of the chat's content.
  if (body.temporary) {
    // Ephemeral "ghost" chat is its own feature (a tier could withhold it while still
    // allowing normal, persisted chat).
    try {
      assertFeature(auth, "chat.temporary");
    } catch (e) {
      return entitlementJson(c, e as EntitlementError);
    }
    const model = body.model ?? svc.DEFAULT_MODEL;
    try {
      svc.assertModelAllowed(auth, model);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 403);
    }

    const limits = svc.callerLimits(auth);
    if (!allowRequest(limits.limitId, limits.maxPerMin)) {
      return c.json({ error: "rate limit exceeded — slow down" }, 429);
    }

    const slotId = limits.limitId;
    if (!svc.acquireSlot(slotId, limits.maxConcurrency)) {
      return c.json({ error: "a generation is already in progress" }, 429);
    }

    // Replay the client-held transcript (bounded), then this turn's message. Memory
    // injection is deliberately skipped — a ghost chat is isolated from the user's memory.
    const priorHistory: ChatMessage[] = (Array.isArray(body.history) ? body.history : [])
      .filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0,
      )
      .slice(-40)
      .map((m) => ({ role: m.role, content: m.content }));
    // Temp chats are persona-free by design (see ephemeralSystemPrompt) — a clean, identity-
    // free session, so no preferences read here. Attached files (#128) are still delivered as a
    // context block (text inlined) — a ghost chat persists nothing, but the turn itself uses them.
    const filesBlockMsgs = filesBlock ? [filesBlock] : [];
    // Attach delivered images (#235) to this turn's user message; a text-only turn stays a plain string.
    const userMessage: ChatMessage = userParts ? { role: "user", content, parts: userParts } : { role: "user", content };
    let promptMessages: ChatMessage[] = [ephemeralSystemPrompt(), ...filesBlockMsgs, ...priorHistory, userMessage];

    // Stream tied to this request (no background live registry — there's nothing to
    // reattach to). A client disconnect (Stop) aborts the upstream generation.
    const signal = c.req.raw.signal;
    return streamSSE(c, async (stream) => {
      let assistant = "";
      let usage: { promptTokens?: number; completionTokens?: number } | undefined;
      let releaseQueue: (() => void) | null = null;
      try {
        await stream.writeSSE({ event: "meta", data: JSON.stringify({ conversationId: null, model, temporary: true }) });

        // Web search runs first (network I/O, no GPU): retrieve current context and inject
        // it before generation. Progress + sources stream to the client live.
        if (wantSearch) {
          const outcome = await runWebSearch(content, {
            onStage: (s) => stream.writeSSE({ event: "search", data: JSON.stringify(s) }),
            signal,
          }).catch(() => null);
          if (outcome) {
            await stream.writeSSE({ event: "sources", data: JSON.stringify({ sources: outcome.sources }) });
            promptMessages = [ephemeralSystemPrompt(), outcome.system, ...filesBlockMsgs, ...priorHistory, userMessage];
          }
        }
        // Ghost chats share the global generation queue too (one machine). Position is
        // streamed straight to this client; nothing is buffered (no live registry).
        releaseQueue = await acquireGenerationSlot((pos) => {
          void stream.writeSSE({ event: "queue", data: JSON.stringify({ position: pos }) });
        });
        // Route to the caller's BYOK frontier provider when this model + caller resolves to one
        // (their own key/cost); otherwise the shared local router. The upstream request uses the
        // stripped id; `model` (persisted/attributed below) keeps the full `provider/model` id.
        const turn = resolveTurnBackend(auth, model);
        for await (const chunk of turn.backend.chat({ model: turn.upstreamModel, messages: promptMessages, signal, noTrain: true, enableThinking: wantThinking })) {
          if (chunk.type === "delta") {
            assistant += chunk.text;
            await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: chunk.text }) });
          } else if (chunk.type === "reasoning") {
            // Stream the thinking (#68) live; a ghost chat persists nothing, so it's display-only.
            await stream.writeSSE({ event: "reasoning", data: JSON.stringify({ text: chunk.text }) });
          } else if (chunk.type === "done") {
            usage = chunk.usage;
          }
        }

        const tIn = usage?.promptTokens ?? null;
        const tOut = usage?.completionTokens ?? null;
        // Token accounting only — keeps account budgets honest (summed from usage_events) so a
        // ghost chat can't bypass the cap. No conversation/message content is written anywhere.
        db.insert(usageEvents).values({
          keyId: limits.keyId,
          userId: auth.user.id,
          conversationId: null,
          model,
          tokensIn: tIn ?? 0,
          tokensOut: tOut ?? 0,
        }).run();

        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ conversationId: null, model, temporary: true, usage: { promptTokens: tIn, completionTokens: tOut } }),
        });
      } catch (e) {
        // Stop (client disconnect): nothing was persisted, so just let the stream end.
        if (!signal.aborted) {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ message: (e as Error).message }) });
        }
      } finally {
        releaseQueue?.();
        svc.releaseSlot(slotId);
      }
    });
  }

  let conv;
  if (body.conversationId) {
    // Existing conversation: admit the OWNER, or a collaborator whose role includes `prompt`
    // (the Share primitive's collaborative send path, #46). A collaborator with read-only
    // access (view/suggest/edit) is a clean 403 — they can already see the chat, so this
    // leaks nothing; no access at all is a 404, the same response a stranger sees (no
    // existence oracle). The conversation resolved here belongs to its OWNER, which drives the
    // memory attribution below.
    const access = resolvePromptAccess(auth.user.id, body.conversationId);
    if (!access.ok) {
      return access.reason === "forbidden"
        ? c.json({ error: "you don't have permission to send messages in this conversation" }, 403)
        : c.json({ error: "conversation not found" }, 404);
    }
    conv = access.conversation;
  } else {
    // No id → a brand-new conversation owned by the caller.
    try {
      conv = svc.createConversation(auth.user.id, body.model ?? svc.DEFAULT_MODEL);
    } catch (e) {
      const err = e as svc.ChatError;
      return c.json({ error: err.message }, (err.status ?? 500) as 404);
    }
  }

  const model = body.model ?? conv.model ?? svc.DEFAULT_MODEL;
  try {
    svc.assertModelAllowed(auth, model);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 403);
  }

  // Rate limit + concurrency, derived by tier (admin → 6x / pool; guests → key bounds;
  // account users → free-tier defaults). See svc.callerLimits — never a `role !== "guest"`
  // branch, which would put account users in the admin pool.
  const limits = svc.callerLimits(auth);
  if (!allowRequest(limits.limitId, limits.maxPerMin)) {
    return c.json({ error: "rate limit exceeded — slow down" }, 429);
  }

  const slotId = limits.limitId;
  if (!svc.acquireSlot(slotId, limits.maxConcurrency)) {
    return c.json({ error: "a generation is already in progress" }, 429);
  }

  // A collaborator's turn (#46) runs on the OWNER's conversation. MEMORY always follows the
  // conversation OWNER — facts, rolling summary, semantic recall, and embeddings stay the
  // owner's, so one person's private memory never bleeds into another's chat in either
  // direction, and the conversation's context reads consistently no matter who sends the next
  // turn. BUDGET / rate limit / model allowlist / usage attribution stay with the PROMPTER
  // (`auth`) — they spend their own quota. For the owner's own turn these are one identity, so
  // nothing changes. The persisted messages belong to the conversation owner too, keeping the
  // owner's per-message controls (vote / regenerate / select) intact on their own chat.
  const ownerId = conv.userId;
  const isOwnerTurn = ownerId === auth.user.id;
  // Archivist opt-out (#27): memory always follows the conversation OWNER, so the OWNER's
  // `memory.enabled` preference gates it. When off, we neither read their durable memory into the
  // prompt nor write new facts/embeddings after the turn — for their own turns and a collaborator's
  // alike (a collaborator can't grow the owner's memory the owner has switched off).
  const ownerMemoryOn = memoryEnabledFor(ownerId);
  const ownerLogin = isOwnerTurn
    ? auth.user.login
    : db.select({ login: users.login }).from(users).where(eq(users.id, ownerId)).get()?.login ?? auth.user.login;

  // Persist the user message verbatim, then build the prompt from full history. Any attached files
  // (#128) are recorded as metadata JSON on this message so the transcript can show them on reload;
  // their text is inlined into the model context below, never stored on the row.
  db.insert(messages).values({
    conversationId: conv.id,
    userId: ownerId,
    role: "user",
    content,
    model,
    attachments: attachments.length > 0 ? JSON.stringify(attachmentsMeta(attachments)) : null,
  }).run();
  // Adopting a model as the conversation default is an OWNER action (model switch stays
  // owner-only). A collaborator's turn (#46) still RUNS on their chosen model — but on a
  // model-less conversation we don't let their pick stick as the owner's default.
  if (!conv.model && isOwnerTurn) {
    db.update(conversations).set({ model }).where(eq(conversations.id, conv.id)).run();
  }
  // Semantic recall + owner-global facts/votes seed the prompt from the owner's OTHER private
  // conversations. On a collaborative turn the prompter is NOT the owner, so withhold both —
  // the `prompt` grant on one conversation is not consent to read the owner's whole memory
  // back out through the model. The conversation summary (this thread, which the collaborator
  // can already read) still flows via buildSystemPrompt. See #46.
  // Owner memory is read only on the owner's own turn AND when the owner has memory enabled (#27).
  const ownerMemoryRead = isOwnerTurn && ownerMemoryOn;
  const recalled = ownerMemoryRead ? await recall(ownerId, content, conv.id).catch(() => [] as string[]) : [];
  // Persona (#11) is the PROMPTER's — the person driving this turn — rendered from their own
  // preferences, consistent with budget/usage following the prompter (never the owner's).
  const persona = personaSystemPrompt(parseStoredPreferences(auth.user.preferences));
  const systemPrompt = buildSystemPrompt(ownerId, conv.id, ownerLogin, recalled, persona, ownerMemoryRead);
  // Verbatim history from the compaction boundary onward (#38), incl. the just-saved user message.
  // When the conversation was compacted, the pre-boundary turns are dropped here and the rolling
  // summary (injected by buildSystemPrompt above) represents them — so the model prompt stays under
  // the context window while the stored transcript is untouched.
  // The current user turn is the last message of the stored thread; attach delivered images (#235)
  // to it so a multimodal model receives them (a no-op for a text-only turn).
  const priorTurns = applyUserPartsToLast(svc.history(conv.id, conv.compactedThroughMessageId), userParts);

  // Run the turn in the background, decoupled from this HTTP request, so a client
  // refresh (disconnect) doesn't kill it — it streams into a live registry that this
  // request, and any later reconnect via GET /conversations/:id/stream, subscribes to.
  // Stop now goes through POST /conversations/:id/stop, which aborts gen.controller.
  const gen = beginLive(conv.id, auth.user.id, model);
  void (async () => {
    let assistant = "";
    let reasoning = ""; // the model's thinking (#68), accumulated + persisted apart from the answer
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    let releaseQueue: (() => void) | null = null;
    try {
      // Web search ("Research") runs first (network I/O, before we hold the single GPU
      // slot): retrieve current context and inject it as a system block so the model
      // answers from fresh, cited sources. Progress + the resolved sources are buffered on
      // the live gen so a client reconnecting mid-turn replays them. A search failure is
      // surfaced and the turn proceeds without it (best-effort, never blocks the answer).
      // Attached files (#128) ride as a context block right after the system prompt (text inlined),
      // mirroring how search injects its sources block. Both can coexist on one turn.
      const filesBlockMsgs = filesBlock ? [filesBlock] : [];
      let promptMessages: ChatMessage[] = [systemPrompt, ...filesBlockMsgs, ...priorTurns];
      if (wantSearch) {
        const outcome = await runWebSearch(content, {
          onStage: (s) => gen.pushSearch(s),
          signal: gen.controller.signal,
        }).catch((e) => {
          gen.pushSearch({ stage: "error", message: (e as Error).message });
          return null;
        });
        if (outcome) {
          gen.pushSources(outcome.sources);
          promptMessages = [systemPrompt, outcome.system, ...filesBlockMsgs, ...priorTurns];
        }
      }

      // Wait for a global generation slot (one machine → serialized). While queued the
      // client receives position updates; once granted, generation begins.
      releaseQueue = await acquireGenerationSlot((pos) => gen.pushQueue(pos));
      // BYOK: run on the caller's own frontier key when this model + caller resolves to one, else
      // the shared local router. Upstream gets the stripped id; the full id stays on the record.
      const turn = resolveTurnBackend(auth, model);
      for await (const chunk of turn.backend.chat({ model: turn.upstreamModel, messages: promptMessages, signal: gen.controller.signal, enableThinking: wantThinking })) {
        if (chunk.type === "delta") {
          assistant += chunk.text;
          gen.pushDelta(chunk.text);
        } else if (chunk.type === "reasoning") {
          reasoning += chunk.text;
          gen.pushReasoning(chunk.text);
        } else if (chunk.type === "done") {
          usage = chunk.usage;
        }
      }

      const tIn = usage?.promptTokens ?? null;
      const tOut = usage?.completionTokens ?? null;
      const assistantRow = db.insert(messages).values({
        conversationId: conv.id,
        userId: ownerId, // messages belong to the conversation owner (see the memory note above)
        role: "assistant",
        content: assistant,
        reasoning: reasoning || null, // the thinking (#68); null when the model emitted none
        model,
        tokensIn: tIn,
        tokensOut: tOut,
      }).returning().get();
      db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conv.id)).run();

      // First turn of a fresh conversation: derive a short summary title from the
      // exchange (ChatGPT-style), replacing the "Untitled" placeholder. Awaited so the
      // client's post-stream refresh picks it up; the conditional update never clobbers
      // a title the user set manually mid-stream.
      if (!conv.title && assistant) {
        const title = await svc.generateTitle(content, assistant).catch(() => null);
        if (title) {
          db.update(conversations)
            .set({ title })
            .where(and(eq(conversations.id, conv.id), isNull(conversations.title)))
            .run();
        }
      }

      db.insert(usageEvents).values({
        keyId: limits.keyId,
        userId: auth.user.id,
        conversationId: conv.id,
        model,
        tokensIn: tIn ?? 0,
        tokensOut: tOut ?? 0,
      }).run();

      // Fire-and-forget: extract durable facts + refresh the summary, and embed the
      // new messages for semantic recall — attributed to the conversation OWNER (memory
      // follows the owner, never the prompter; see the note above). Skipped entirely when the
      // owner has switched memory off (#27) — nothing new is learned while it's disabled.
      if (ownerMemoryOn) {
        void updateMemory(ownerId, conv.id).catch(() => {});
        void embedConversation(ownerId, conv.id).catch(() => {});
      }

      // Context-window usage AFTER this turn (#38) — carried on the done frame so the composer's
      // meter + near-limit nudge update without a refetch. Best-effort: a failure here must never
      // break the turn (the answer is already persisted), so it degrades to no snapshot.
      let context;
      try {
        context = conversationContextUsage({
          slots: svc.thread(conv.id),
          ownerId,
          conversationId: conv.id,
          model: conv.model,
          compactedThroughMessageId: conv.compactedThroughMessageId,
        });
      } catch {
        context = undefined;
      }

      gen.finish({
        conversationId: conv.id,
        model,
        messageId: assistantRow?.id,
        usage: { promptTokens: tIn, completionTokens: tOut },
        context,
      });
    } catch (e) {
      // Stop aborts the controller: the partial answer is intentionally not persisted.
      // Anything else is surfaced to whoever is still subscribed.
      if (gen.controller.signal.aborted) gen.markAborted();
      else gen.fail((e as Error).message);
    } finally {
      releaseQueue?.();
      svc.releaseSlot(slotId);
    }
  })();

  return streamLive(c, gen);
});

// Regenerate an assistant answer in place. Unlike a normal turn this does NOT append
// a new user message: it re-runs the model against the history UP TO this answer and
// stores the result as a sibling variant of the original, which becomes the active one.
chat.post("/messages/:id/regenerate", requireFeature("chat.regenerate"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");

  const target = db
    .select()
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.userId, auth.user.id)))
    .get();
  if (!target || target.role !== "assistant") return c.json({ error: "not found" }, 404);

  const conv = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, target.conversationId), eq(conversations.userId, auth.user.id)))
    .get();
  if (!conv) return c.json({ error: "conversation not found" }, 404);

  try {
    svc.assertBudget(auth);
  } catch (e) {
    const err = e as svc.ChatError;
    return c.json({ error: err.message }, err.status as 402);
  }

  const model = conv.model ?? target.model ?? svc.DEFAULT_MODEL;
  try {
    svc.assertModelAllowed(auth, model);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 403);
  }

  // Tier-derived rate + concurrency (see svc.callerLimits) — same bounds as a normal turn.
  const limits = svc.callerLimits(auth);
  if (!allowRequest(limits.limitId, limits.maxPerMin)) {
    return c.json({ error: "rate limit exceeded — slow down" }, 429);
  }

  const slotId = limits.limitId;
  if (!svc.acquireSlot(slotId, limits.maxConcurrency)) {
    return c.json({ error: "a generation is already in progress" }, 429);
  }

  // Prompt = active path strictly before this answer's slot (the original prompt that
  // produced it), so we re-ask the same question without re-sending the user's message.
  const rootId = target.variantOf ?? target.id;
  const slots = svc.thread(conv.id);
  const slotIndex = slots.findIndex((s) => s.variants.some((v) => v.id === target.id));
  const prior = slotIndex >= 0 ? slots.slice(0, slotIndex) : slots;
  const lastUser = [...prior].reverse().find((s) => s.active.role === "user")?.active.content ?? "";
  // Regenerate runs on the owner's own message; gate memory read/write on their opt-out (#27).
  const memoryOn = memoryEnabledFor(auth.user.id);
  const recalled = memoryOn && lastUser ? await recall(auth.user.id, lastUser, conv.id).catch(() => [] as string[]) : [];

  // A retry must produce a genuinely different answer, not a near-duplicate. Feed the
  // model every answer already produced for this slot (the original + earlier retries) and
  // tell it to diverge, then sample hotter than a normal turn so it explores instead of
  // re-deriving the same text.
  const priorAnswers = (slotIndex >= 0 ? slots[slotIndex]?.variants ?? [] : []).map((v) => v.content);
  const persona = personaSystemPrompt(parseStoredPreferences(auth.user.preferences));
  const promptMessages = [
    withRegenerateSteering(
      buildSystemPrompt(auth.user.id, conv.id, auth.user.login, recalled, persona, memoryOn),
      priorAnswers,
    ),
    ...prior.map((s) => ({ role: s.active.role, content: s.active.content })),
  ];

  // Aborts when the client disconnects (Stop) so the regeneration halts upstream.
  const signal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    let assistant = "";
    let reasoning = ""; // the retry's thinking (#68), streamed + persisted apart from the answer
    let usage: { promptTokens?: number; completionTokens?: number } | undefined;
    try {
      await stream.writeSSE({ event: "meta", data: JSON.stringify({ conversationId: conv.id, model }) });
      // BYOK: a regenerate runs on the caller's own frontier key when the model resolves to one.
      const turn = resolveTurnBackend(auth, model);
      for await (const chunk of turn.backend.chat({ model: turn.upstreamModel, messages: promptMessages, signal, temperature: 0.95 })) {
        if (chunk.type === "delta") {
          assistant += chunk.text;
          await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: chunk.text }) });
        } else if (chunk.type === "reasoning") {
          reasoning += chunk.text;
          await stream.writeSSE({ event: "reasoning", data: JSON.stringify({ text: chunk.text }) });
        } else if (chunk.type === "done") {
          usage = chunk.usage;
        }
      }

      const tIn = usage?.promptTokens ?? null;
      const tOut = usage?.completionTokens ?? null;
      const variantRow = db
        .insert(messages)
        .values({
          conversationId: conv.id,
          userId: auth.user.id,
          role: "assistant",
          content: assistant,
          reasoning: reasoning || null,
          model,
          tokensIn: tIn,
          tokensOut: tOut,
          variantOf: rootId,
          variantActive: true,
        })
        .returning()
        .get();
      // The newcomer is now active; demote every other variant in the slot.
      db.update(messages)
        .set({ variantActive: false })
        .where(
          and(
            eq(messages.conversationId, conv.id),
            or(eq(messages.id, rootId), eq(messages.variantOf, rootId)),
            ne(messages.id, variantRow!.id),
          ),
        )
        .run();
      db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conv.id)).run();

      db.insert(usageEvents).values({
        keyId: limits.keyId,
        userId: auth.user.id,
        conversationId: conv.id,
        model,
        tokensIn: tIn ?? 0,
        tokensOut: tOut ?? 0,
      }).run();

      if (memoryOn) {
        void updateMemory(auth.user.id, conv.id).catch(() => {});
        void embedConversation(auth.user.id, conv.id).catch(() => {});
      }

      // Hand back the refreshed slot so the client can wire up the ◀ n/m ▶ navigator.
      const slot = svc.thread(conv.id).find((s) => s.variants.some((v) => v.id === variantRow!.id));
      const variants =
        slot?.variants.map((v) => ({ id: v.id, content: v.content, vote: v.vote, reasoning: v.reasoning })) ?? [];
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          conversationId: conv.id,
          model,
          messageId: variantRow?.id,
          variants,
          activeIndex: variants.findIndex((v) => v.id === variantRow?.id),
          usage: { promptTokens: tIn, completionTokens: tOut },
        }),
      });
    } catch (e) {
      // Stop (client disconnect): no variant is persisted and the stream is gone.
      if (!signal.aborted) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: (e as Error).message }) });
      }
    } finally {
      svc.releaseSlot(slotId);
    }
  });
});

// Select which variant of a regenerated answer is active — the choice persists, so the
// rest of the conversation (and the next turn's history) follows the selected branch.
chat.post("/messages/:id/select", requireFeature("chat.regenerate"), (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const msg = db
    .select()
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.userId, auth.user.id)))
    .get();
  if (!msg) return c.json({ error: "not found" }, 404);
  const rootId = msg.variantOf ?? msg.id;
  db.update(messages)
    .set({ variantActive: false })
    .where(and(eq(messages.conversationId, msg.conversationId), or(eq(messages.id, rootId), eq(messages.variantOf, rootId))))
    .run();
  db.update(messages).set({ variantActive: true }).where(eq(messages.id, id)).run();
  return c.json({ ok: true });
});

// Vote on an assistant reply (-1 / 0 / 1), scoped to the caller's own messages.
chat.post("/messages/:id/vote", requireFeature("chat.vote"), async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { vote?: number };
  const vote = body.vote === 1 ? 1 : body.vote === -1 ? -1 : 0;
  const msg = db
    .select()
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.userId, auth.user.id)))
    .get();
  if (!msg) return c.json({ error: "not found" }, 404);
  db.update(messages).set({ vote }).where(eq(messages.id, id)).run();
  return c.json({ ok: true, vote });
});

// Voice input: forward uploaded audio to the whisper service, return the transcript.
chat.post("/transcribe", requireFeature("chat.voice"), async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return c.json({ error: "no audio file" }, 400);
  const out = new FormData();
  out.append("file", file, file instanceof File ? file.name : "audio.webm");
  out.append("response_format", "json");
  const res = await fetch(`${config.whisperUrl}/v1/audio/transcriptions`, { method: "POST", body: out });
  if (!res.ok) return c.json({ error: `transcribe -> ${res.status}` }, 502);
  const data = (await res.json()) as { text?: string };
  return c.json({ text: data.text ?? "" });
});

export default chat;

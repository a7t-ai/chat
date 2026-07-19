import { Hono } from "hono";
import { db } from "../db/index.ts";
import { conversations } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { config } from "../config.ts";
import { getLive, streamLive } from "../chat/live.ts";
import { allowRequest } from "../chat/ratelimit.ts";
import { getShareBySlug, toggleSharedTodo } from "../chat/shares.ts";
import { thread } from "../chat/service.ts";
import { track } from "../telemetry/index.ts";
import { mintWriteToken, verifyWriteToken } from "./write-token.ts";

// PUBLIC, no-login share viewing — the "watch it build in real time" wedge. Mounted at
// /api/share and carved out of the auth gate (GET-only) in auth/middleware.ts, so these
// handlers run with NO `auth` context and MUST NOT read it. Access is bounded entirely by
// the slug: it resolves to exactly one conversation, and an unknown/revoked (deleted) slug
// 404s. Only the shared conversation's own content is ever exposed — no owner identity, no
// other conversations, no votes/memory — and the path is strictly read-only.

const share = new Hono();

// Read-only snapshot of a shared conversation: its title + the active message thread
// (regenerated answers collapse to the selected variant, same as the owner's own view).
// Deliberately omits owner identity (login/email/displayName), votes, and ids of anything
// but the messages — a watcher sees the conversation, not the account behind it.
share.get("/:slug", (c) => {
  const slug = c.req.param("slug");
  const found = getShareBySlug(slug);
  if (!found) return c.json({ error: "not found" }, 404);

  const conv = db.select().from(conversations).where(eq(conversations.id, found.conversationId)).get();
  // A share whose conversation vanished (cascade should remove the share, but be defensive).
  if (!conv) return c.json({ error: "not found" }, 404);

  const messages = thread(found.conversationId).map((s) => ({
    id: s.active.id,
    role: s.active.role,
    content: s.active.content,
    model: s.active.model,
    createdAt: s.active.createdAt,
  }));

  // A temporary, slug-bound write token so the (anonymous) viewer can tick a TODO checkbox —
  // the one write the public page allows (#45). It's owner-identity-free (an HMAC over the
  // slug), rate-limited on use, and expires; the page refreshes it on each snapshot poll.
  const { token, expiresAt } = mintWriteToken(slug);

  return c.json({
    conversation: { id: conv.id, title: conv.title },
    messages,
    writeToken: token,
    writeTokenExpiresAt: expiresAt,
  });
});

// Tick/untick a TODO checkbox on a shared page (#45) — the ONLY public write, carved out of the
// auth gate as a bounded sibling of the read path (POST /api/share/:slug/todo in
// auth/middleware.ts). It runs with NO auth context; the write token IS the capability. Order is
// deliberate: validate the token and the per-token rate limit BEFORE any DB access, so an
// invalid/expired token or a spamming holder is a true no-op that never touches storage. Only a
// valid token reaches the toggle, which is itself scoped to a single checkbox of a message in
// THIS share's conversation — never arbitrary content, never another conversation.
share.post("/:slug/todo", async (c) => {
  const slug = c.req.param("slug");
  const token = c.req.header("x-a7t-share-write");

  // 1. No valid token → reject with zero DB touch (the slug-bound HMAC verifies statelessly).
  if (!verifyWriteToken(slug, token)) return c.json({ error: "invalid token" }, 401);

  // 2. Per-token rate limit — a holder (or a leaked token) can't spam toggles. In-memory only.
  if (!allowRequest(`share-todo:${token}`, config.share.writeRateLimitPerMin)) {
    return c.json({ error: "rate limited" }, 429);
  }

  // 3. Validate the payload shape: a message id, a non-negative item index, and the target state.
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

  // 4. Resolve the slug now that the token checks out; a revoked/unknown slug 404s.
  const found = getShareBySlug(slug);
  if (!found) return c.json({ error: "not found" }, 404);

  // 5. Apply the toggle, scoped to this share's conversation. A missing message or an
  //    out-of-range index is a clean 404 no-op (no existence oracle, no partial write).
  const result = toggleSharedTodo(found.conversationId, body.messageId, body.index, body.done);
  if (!result) return c.json({ error: "not found" }, 404);

  track({ type: "share.todo", conversationId: found.conversationId, meta: { done: body.done } });
  return c.json({ ok: true, content: result.content });
});

// Live SSE for a shared conversation — the actual "watch it build" channel. Subscribes the
// (anonymous) watcher to the in-flight generation for this conversation, replaying the
// buffered text first, then forwarding deltas to completion. 204 when nothing is generating
// right now (the watcher reconciles from the snapshot and polls for the next turn). The
// watcher is a pure listener: streamLive only writes SSE out — there is no way to stop,
// inject, or otherwise affect the generation from here.
share.get("/:slug/stream", (c) => {
  const slug = c.req.param("slug");
  const found = getShareBySlug(slug);
  if (!found) return c.json({ error: "not found" }, 404);

  const live = getLive(found.conversationId);
  if (!live || live.status !== "running") return c.body(null, 204);
  return streamLive(c, live);
});

export default share;

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../auth/middleware.ts";
import { config } from "../config.ts";
import { clearByokModelsCache } from "../byok/models.ts";
import { setProviderKey } from "../byok/service.ts";
import { db } from "../db/index.ts";
import { conversationRecaps, conversations, facts, messages, providerKeys, summaries, usageEvents, users } from "../db/schema.ts";
import { embedder } from "../embed/client.ts";
import { createFile } from "../files/service.ts";
import { backend } from "../jano/client.ts";
import type { ChatChunk, ChatMessage } from "../jano/types.ts";
import { beginLive } from "./live.ts";
import chatRoutes from "./routes.ts";

// Integration tests for the chat router. We mount the real router behind a tiny app that
// injects a fake `auth` context (mirroring what authMiddleware would set), then drive it
// with app.request(...). The Jano backend + the embed service are STUBBED — these tests
// never touch the network. SSE endpoints are consumed and their frames asserted.

// ---- Jano + embedder stubs -------------------------------------------------------------
const realChat = backend.chat;
const realListModels = backend.listModels;
const realComplete = backend.complete;
const realEmbed = embedder.embed;

// Default streamed turn: one delta + a done frame carrying usage. Tests can swap in their
// own generator via `setChat`.
function defaultChat(): (req: unknown) => AsyncIterable<ChatChunk> {
  return async function* () {
    yield { type: "delta", text: "hello " } as ChatChunk;
    yield { type: "delta", text: "world" } as ChatChunk;
    yield { type: "done", usage: { promptTokens: 11, completionTokens: 7 } } as ChatChunk;
  };
}
function setChat(fn: (req: unknown) => AsyncIterable<ChatChunk>): void {
  backend.chat = fn as typeof backend.chat;
}

beforeEach(() => {
  setChat(defaultChat());
  backend.listModels = (async () => [
    { id: "qwen-chat", label: "Qwen Chat" },
    { id: "qwen-code", label: "Qwen Coder" },
  ]) as typeof backend.listModels;
  backend.complete = (async () => "Generated Title") as typeof backend.complete;
  // recall()/updateMemory() ride the embedder + complete; keep them from hitting the net.
  embedder.embed = (async () => [0, 0, 0]) as typeof embedder.embed;
});

const realFetch = globalThis.fetch;
afterEach(() => {
  backend.chat = realChat;
  backend.listModels = realListModels;
  backend.complete = realComplete;
  embedder.embed = realEmbed;
  globalThis.fetch = realFetch;
  clearByokModelsCache();
  db.delete(providerKeys).run();
});

// Stub the global fetch a provider `${base}/models` call rides (ok:false → that provider errors).
function stubProviderModels(data: { id: string; label?: string }[], ok = true): void {
  globalThis.fetch = (async () =>
    ok ? new Response(JSON.stringify({ data }), { status: 200 }) : new Response("nope", { status: 500 })) as unknown as typeof fetch;
}

// ---- fixtures --------------------------------------------------------------------------
function makeAdmin(): AuthContext {
  const u = db
    .insert(users)
    .values({ login: `admin-${Math.random()}`, role: "admin", displayName: "Leo" })
    .returning()
    .get();
  return { role: "admin", via: "owner", user: u, key: null };
}

// An email-login account user: role="account", key=null. Its limits come from the guardrails
// SNAPSHOTTED onto the user row at invite redemption (modelAllowlist / tokenBudget /
// maxConcurrency). It must be BOUNDED, never the admin pool. A null snapshot field falls back to
// the config.freeTier default. (The guest-key/Bearer tier was retired — `account` is the only
// non-admin tier now.)
function makeAccount(opts: Partial<{ modelAllowlist: string[] | null; tokenBudget: number | null; maxConcurrency: number | null }> = {}): AuthContext {
  const u = db
    .insert(users)
    .values({
      login: `acct-${Math.random()}`,
      role: "account",
      accessGrantedAt: new Date(),
      modelAllowlist: opts.modelAllowlist ? JSON.stringify(opts.modelAllowlist) : null,
      tokenBudget: opts.tokenBudget ?? null,
      maxConcurrency: opts.maxConcurrency ?? null,
    })
    .returning()
    .get();
  return { role: "account", via: "session", user: u, key: null, accessGranted: true };
}

// Mount the real router behind a fake-auth middleware. The returned helper sets `auth`.
function appFor(auth: AuthContext): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    return next();
  });
  app.route("/", chatRoutes);
  return app;
}

function makeConversation(userId: string, fields: Partial<{ title: string; model: string; starred: boolean }> = {}): string {
  return db.insert(conversations).values({ userId, ...fields }).returning().get().id;
}
function addMessage(
  userId: string,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  extra: Partial<{ variantOf: string; variantActive: boolean; vote: number; model: string }> = {},
): string {
  return db.insert(messages).values({ conversationId, userId, role, content, ...extra }).returning().get().id;
}

// Parse an SSE response body into ordered { event, data } frames.
async function readFrames(res: Response): Promise<{ event: string; data: unknown }[]> {
  const text = await res.text();
  const frames: { event: string; data: unknown }[] = [];
  for (const block of text.split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // leave raw
    }
    frames.push({ event, data });
  }
  return frames;
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
// Same body, but for routes mounted on a non-POST verb (PATCH). Keep the json() default
// for the common POST case; this avoids the method-override footgun of spreading json().
const jsonWith = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---- GET /models -----------------------------------------------------------------------
describe("GET /models", () => {
  test("admin sees the live model ids + labels + default", async () => {
    const res = await appFor(makeAdmin()).request("/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: string[]; labels: Record<string, string>; default: string };
    expect(body.models).toEqual(["qwen-chat", "qwen-code"]);
    expect(body.labels).toMatchObject({ "qwen-chat": "Qwen Chat" });
    expect(body.default).toBe("qwen-chat");
  });

  test("account sees only its snapshotted allowlist", async () => {
    const res = await appFor(makeAccount({ modelAllowlist: ["qwen-chat"] })).request("/models");
    const body = (await res.json()) as { models: string[] };
    expect(body.models).toEqual(["qwen-chat"]);
  });

  // An account with a null snapshot is BOUNDED to the free-tier default, NOT the admin live list.
  test("account user sees only the free-tier allowlist (default model), not the live list", async () => {
    const res = await appFor(makeAccount()).request("/models");
    const body = (await res.json()) as { models: string[] };
    // free-tier models is empty in tests → just the default model. Admins would see both
    // qwen-chat AND qwen-code (the stubbed live list); the account must NOT.
    expect(body.models).toEqual([config.defaultModel]);
    expect(body.models).not.toContain("qwen-code");
  });

  // #185: the caller's configured-BYOK-provider models are appended (id + label) to the local list.
  test("appends the caller's BYOK model ids + labels after the local ones", async () => {
    const admin = makeAdmin();
    setProviderKey(admin.user.id, "openai", "sk-live-abcd");
    stubProviderModels([{ id: "gpt-4o", label: "GPT-4o" }]);
    const res = await appFor(admin).request("/models");
    const body = (await res.json()) as { models: string[]; labels: Record<string, string> };
    expect(body.models).toEqual(["qwen-chat", "qwen-code", "openai/gpt-4o"]);
    expect(body.labels["openai/gpt-4o"]).toBe("GPT-4o");
    expect(body.labels["qwen-chat"]).toBe("Qwen Chat"); // local labels untouched
  });

  // GRACEFUL: a BYOK provider erroring must never drop the local models.
  test("keeps the local models when a BYOK provider's /models errors", async () => {
    const admin = makeAdmin();
    setProviderKey(admin.user.id, "openai", "sk-live-abcd");
    stubProviderModels([], false); // openai /models -> 500
    const res = await appFor(admin).request("/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: string[] };
    expect(body.models).toEqual(["qwen-chat", "qwen-code"]); // local intact, no BYOK
  });
});

// ---- GET /conversations ---------------------------------------------------------------
describe("GET /conversations", () => {
  test("returns the caller's conversations, newest first, scoped", async () => {
    const auth = makeAdmin();
    makeConversation(auth.user.id, { title: "A" });
    makeConversation(auth.user.id, { title: "B" });
    makeConversation(makeAdmin().user.id, { title: "OTHER" }); // a different user

    const res = await appFor(auth).request("/conversations");
    const body = (await res.json()) as { conversations: { title: string; generating: boolean }[] };
    expect(body.conversations.map((c) => c.title).sort()).toEqual(["A", "B"]);
    expect(body.conversations.every((c) => c.generating === false)).toBe(true);
  });
});

// ---- GET /conversations/:id -----------------------------------------------------------
describe("GET /conversations/:id", () => {
  test("404 for a conversation the caller doesn't own", async () => {
    const other = makeAdmin();
    const conv = makeConversation(other.user.id);
    const res = await appFor(makeAdmin()).request(`/conversations/${conv}`);
    expect(res.status).toBe(404);
  });

  test("returns the thread with a plain message (no variants)", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id, { title: "T" });
    addMessage(auth.user.id, conv, "user", "hi");
    addMessage(auth.user.id, conv, "assistant", "yo");
    const res = await appFor(auth).request(`/conversations/${conv}`);
    const body = (await res.json()) as { conversation: { id: string }; messages: { role: string; content: string; variants?: unknown }[] };
    expect(body.conversation.id).toBe(conv);
    expect(body.messages.map((m) => m.content)).toEqual(["hi", "yo"]);
    expect(body.messages[1]?.variants).toBeUndefined();
  });

  test("folds regenerated variants into one slot with activeIndex", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    addMessage(auth.user.id, conv, "user", "q");
    const root = addMessage(auth.user.id, conv, "assistant", "answer-1", { variantActive: false });
    addMessage(auth.user.id, conv, "assistant", "answer-2", { variantOf: root, variantActive: true });
    const res = await appFor(auth).request(`/conversations/${conv}`);
    const body = (await res.json()) as { messages: { content: string; variants?: { content: string }[]; activeIndex?: number }[] };
    const assistant = body.messages.find((m) => m.variants);
    expect(assistant?.variants?.map((v) => v.content)).toEqual(["answer-1", "answer-2"]);
    expect(assistant?.content).toBe("answer-2"); // the active variant is rendered inline
    expect(assistant?.activeIndex).toBe(1);
  });

  // Context-window usage (#38): the read carries the effective prompt-size snapshot so the composer
  // can render the meter + the near-limit compact nudge.
  test("carries the context-window usage snapshot", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id, { model: "qwen-chat" });
    addMessage(auth.user.id, conv, "user", "hi");
    addMessage(auth.user.id, conv, "assistant", "yo");
    const res = await appFor(auth).request(`/conversations/${conv}`);
    const body = (await res.json()) as { conversation: { context?: { windowTokens: number; shouldPrompt: boolean; showMeter: boolean } } };
    expect(body.conversation.context?.windowTokens).toBe(32768);
    expect(body.conversation.context?.shouldPrompt).toBe(false); // a short thread
    expect(body.conversation.context?.showMeter).toBe(false);
  });
});

// ---- POST /conversations/:id/compact (#38) --------------------------------------------
describe("POST /conversations/:id/compact", () => {
  const realComplete = backend.complete;
  afterEach(() => {
    backend.complete = realComplete;
  });
  // Stub the summarizer to return a valid summary JSON (the default beforeEach stub returns a plain
  // title string, which summarizeForCompaction correctly treats as malformed → 502).
  function stubSummary(summary = "a folded recap"): void {
    backend.complete = (async () => `{ "summary": "${summary}" }`) as typeof backend.complete;
  }
  // Seed a long enough thread that compaction actually folds (>6 recent kept + >=2 folded).
  function seedLongThread(userId: string): { conv: string; ids: string[] } {
    const conv = makeConversation(userId, { model: "qwen-chat" });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(addMessage(userId, conv, i % 2 === 0 ? "user" : "assistant", `message ${i}`));
    return { conv, ids };
  }

  test("404 for a non-owner / unknown conversation (no existence oracle)", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    stubSummary();
    expect((await appFor(makeAccount()).request(`/conversations/${conv}/compact`, json({}))).status).toBe(404);
    expect((await appFor(owner).request(`/conversations/does-not-exist/compact`, json({}))).status).toBe(404);
  });

  test("422 when there's not enough conversation to compact yet", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    addMessage(auth.user.id, conv, "user", "hi");
    addMessage(auth.user.id, conv, "assistant", "yo");
    stubSummary();
    const res = await appFor(auth).request(`/conversations/${conv}/compact`, json({}));
    expect(res.status).toBe(422);
  });

  test("folds older turns, records the boundary, and NEVER deletes a message", async () => {
    const auth = makeAdmin();
    const { conv, ids } = seedLongThread(auth.user.id);
    stubSummary("folded recap of the early turns");

    const res = await appFor(auth).request(`/conversations/${conv}/compact`, json({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; foldedCount: number; context: { usedTokens: number } };
    expect(body.ok).toBe(true);
    expect(body.foldedCount).toBe(10 - 6); // KEEP_RECENT_TURNS = 6

    // The boundary was stamped on the conversation (points at the last folded message).
    const row = db.select().from(conversations).where(eq(conversations.id, conv)).get();
    expect(row?.compactedThroughMessageId).toBe(ids[body.foldedCount - 1]!);

    // CRITICAL: the transcript is intact — compaction is a context-window construct, not a delete.
    const remaining = db.select().from(messages).where(eq(messages.conversationId, conv)).all();
    expect(remaining).toHaveLength(10);

    // The rolling summary now represents the folded turns (reused two-tier memory machinery).
    const sum = db.select().from(summaries).where(eq(summaries.conversationId, conv)).get();
    expect(sum?.content).toBe("folded recap of the early turns");
  });

  test("a compacted conversation still returns the FULL transcript on read", async () => {
    const auth = makeAdmin();
    const { conv } = seedLongThread(auth.user.id);
    stubSummary();
    await appFor(auth).request(`/conversations/${conv}/compact`, json({}));
    const res = await appFor(auth).request(`/conversations/${conv}`);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(10); // every message is still shown
  });

  test("502 (uncompacted) when the summarizer fails — nothing is written", async () => {
    const auth = makeAdmin();
    const { conv } = seedLongThread(auth.user.id);
    backend.complete = (async () => {
      throw new Error("jano down");
    }) as typeof backend.complete;
    const res = await appFor(auth).request(`/conversations/${conv}/compact`, json({}));
    expect(res.status).toBe(502);
    // No boundary stamped, no summary written — the conversation is untouched.
    const row = db.select().from(conversations).where(eq(conversations.id, conv)).get();
    expect(row?.compactedThroughMessageId).toBeNull();
    expect(db.select().from(summaries).where(eq(summaries.conversationId, conv)).get()).toBeUndefined();
  });
});

// ---- PATCH /conversations/:id ---------------------------------------------------------
describe("PATCH /conversations/:id", () => {
  test("renames + stars", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id, { title: "old" });
    const res = await appFor(auth).request(`/conversations/${conv}`, jsonWith("PATCH", { title: "  New Title  ", starred: true }));
    expect(res.status).toBe(200);
    const row = db.select().from(conversations).where(eq(conversations.id, conv)).get();
    expect(row?.title).toBe("New Title");
    expect(row?.starred).toBe(true);
  });

  test("empty title → 400", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const res = await appFor(auth).request(`/conversations/${conv}`, jsonWith("PATCH", { title: "   " }));
    expect(res.status).toBe(400);
  });

  test("nothing to update → 400", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const res = await appFor(auth).request(`/conversations/${conv}`, jsonWith("PATCH", {}));
    expect(res.status).toBe(400);
  });

  test("404 when not owned", async () => {
    const conv = makeConversation(makeAdmin().user.id);
    const res = await appFor(makeAdmin()).request(`/conversations/${conv}`, jsonWith("PATCH", { starred: true }));
    expect(res.status).toBe(404);
  });
});

// ---- POST /conversations/:id/title ----------------------------------------------------
describe("POST /conversations/:id/title", () => {
  test("regenerates a title from the first exchange", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    addMessage(auth.user.id, conv, "user", "tell me about lisbon");
    addMessage(auth.user.id, conv, "assistant", "lisbon is the capital of portugal");
    const res = await appFor(auth).request(`/conversations/${conv}/title`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("Generated Title");
    expect(db.select().from(conversations).where(eq(conversations.id, conv)).get()?.title).toBe("Generated Title");
  });

  test("422 when there's no exchange to summarize", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    addMessage(auth.user.id, conv, "user", "lonely message"); // no assistant reply
    const res = await appFor(auth).request(`/conversations/${conv}/title`, { method: "POST" });
    expect(res.status).toBe(422);
  });

  test("404 when not owned", async () => {
    const conv = makeConversation(makeAdmin().user.id);
    const res = await appFor(makeAdmin()).request(`/conversations/${conv}/title`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ---- DELETE /conversations/:id --------------------------------------------------------
describe("DELETE /conversations/:id", () => {
  test("deletes the conversation + cascades its messages", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    addMessage(auth.user.id, conv, "user", "x");
    const res = await appFor(auth).request(`/conversations/${conv}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(db.select().from(conversations).where(eq(conversations.id, conv)).get()).toBeUndefined();
    expect(db.select().from(messages).where(eq(messages.conversationId, conv)).all().length).toBe(0);
  });

  test("404 when not owned", async () => {
    const conv = makeConversation(makeAdmin().user.id);
    const res = await appFor(makeAdmin()).request(`/conversations/${conv}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ---- POST /conversations/:id/branch (#72) ---------------------------------------------
describe("POST /conversations/:id/branch", () => {
  test("forks at a message into a new owned conversation carrying the context up to it", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id, { title: "Trip", model: "qwen-code" });
    addMessage(auth.user.id, conv, "user", "plan a trip");
    const a1 = addMessage(auth.user.id, conv, "assistant", "sure, where to?");
    addMessage(auth.user.id, conv, "user", "Lisbon");
    addMessage(auth.user.id, conv, "assistant", "great choice");
    const app = appFor(auth);

    const res = await app.request(`/conversations/${conv}/branch`, json({ messageId: a1 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: string; title: string | null; model: string | null } };
    expect(body.conversation.id).not.toBe(conv);
    expect(body.conversation.title).toBe("Trip");
    expect(body.conversation.model).toBe("qwen-code");

    // The new conversation is the caller's and carries only the first exchange.
    const branched = db.select().from(conversations).where(eq(conversations.id, body.conversation.id)).get();
    expect(branched?.userId).toBe(auth.user.id);
    const copied = db.select().from(messages).where(eq(messages.conversationId, body.conversation.id)).all();
    expect(copied.map((m) => m.content)).toEqual(["plan a trip", "sure, where to?"]);
    // The source conversation is untouched.
    expect(db.select().from(messages).where(eq(messages.conversationId, conv)).all()).toHaveLength(4);
  });

  test("400 when messageId is missing or blank", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    addMessage(auth.user.id, conv, "user", "x");
    const app = appFor(auth);
    expect((await app.request(`/conversations/${conv}/branch`, json({}))).status).toBe(400);
    expect((await app.request(`/conversations/${conv}/branch`, json({ messageId: "" }))).status).toBe(400);
    expect((await app.request(`/conversations/${conv}/branch`, json({ messageId: 42 }))).status).toBe(400);
  });

  test("404 for an unknown conversation id", async () => {
    const res = await appFor(makeAdmin()).request(`/conversations/nope/branch`, json({ messageId: "m" }));
    expect(res.status).toBe(404);
  });

  test("404 when the conversation isn't the caller's (no cross-account fork, no existence oracle)", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    const m = addMessage(owner.user.id, conv, "user", "secret");
    // A different caller may not fork it — same 404 a stranger sees.
    const res = await appFor(makeAccount()).request(`/conversations/${conv}/branch`, json({ messageId: m }));
    expect(res.status).toBe(404);
    // Nothing was copied into the stranger's account.
    expect(db.select().from(conversations).where(eq(conversations.userId, conv)).all()).toHaveLength(0);
  });

  test("404 when the fork point isn't a message in this conversation", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    addMessage(auth.user.id, conv, "user", "here");
    const otherConv = makeConversation(auth.user.id);
    const foreignMsg = addMessage(auth.user.id, otherConv, "user", "elsewhere");
    const res = await appFor(auth).request(`/conversations/${conv}/branch`, json({ messageId: foreignMsg }));
    expect(res.status).toBe(404);
  });
});

// ---- POST /messages/:id/vote ----------------------------------------------------------
describe("POST /messages/:id/vote", () => {
  test("records an upvote / downvote / clamps to 0", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const m = addMessage(auth.user.id, conv, "assistant", "a");
    const app = appFor(auth);

    let res = await app.request(`/messages/${m}/vote`, json({ vote: 1 }));
    expect((await res.json()) as { vote: number }).toMatchObject({ vote: 1 });
    expect(db.select().from(messages).where(eq(messages.id, m)).get()?.vote).toBe(1);

    res = await app.request(`/messages/${m}/vote`, json({ vote: -1 }));
    expect(db.select().from(messages).where(eq(messages.id, m)).get()?.vote).toBe(-1);

    res = await app.request(`/messages/${m}/vote`, json({ vote: 99 })); // out of range → 0
    expect(db.select().from(messages).where(eq(messages.id, m)).get()?.vote).toBe(0);
  });

  test("404 for a message the caller doesn't own", async () => {
    const other = makeAdmin();
    const conv = makeConversation(other.user.id);
    const m = addMessage(other.user.id, conv, "assistant", "a");
    const res = await appFor(makeAdmin()).request(`/messages/${m}/vote`, json({ vote: 1 }));
    expect(res.status).toBe(404);
  });
});

// ---- POST /messages/:id/select --------------------------------------------------------
describe("POST /messages/:id/select", () => {
  test("activates the chosen variant + demotes its siblings", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    addMessage(auth.user.id, conv, "user", "q");
    const root = addMessage(auth.user.id, conv, "assistant", "v1", { variantActive: true });
    const v2 = addMessage(auth.user.id, conv, "assistant", "v2", { variantOf: root, variantActive: false });

    const res = await appFor(auth).request(`/messages/${v2}/select`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(db.select().from(messages).where(eq(messages.id, v2)).get()?.variantActive).toBe(true);
    expect(db.select().from(messages).where(eq(messages.id, root)).get()?.variantActive).toBe(false);
  });

  test("404 when not owned", async () => {
    const other = makeAdmin();
    const conv = makeConversation(other.user.id);
    const m = addMessage(other.user.id, conv, "assistant", "a");
    const res = await appFor(makeAdmin()).request(`/messages/${m}/select`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ---- POST /conversations/:id/stop -----------------------------------------------------
describe("POST /conversations/:id/stop", () => {
  test("returns ok:false when nothing is live", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const res = await appFor(auth).request(`/conversations/${conv}/stop`, { method: "POST" });
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: false });
  });
});

// ---- REMOVED: the email-me-when-done reminder route is gone (#169) --------------------
describe("POST /conversations/:id/remind (removed, #169)", () => {
  test("the reminder route no longer exists → 404", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const res = await appFor(auth).request(`/conversations/${conv}/remind`, json({ email: "leo@a7t.ai" }));
    expect(res.status).toBe(404);
  });
});

// ---- POST /chat — validation + /model commands ----------------------------------------
describe("POST /chat — guards + commands", () => {
  test("invalid json → 400", async () => {
    const res = await appFor(makeAdmin()).request("/chat", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
  });

  test("empty message → 400", async () => {
    const res = await appFor(makeAdmin()).request("/chat", json({ content: "   " }));
    expect(res.status).toBe(400);
  });

  test("/model lists allowed models + current", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id, { model: "qwen-code" });
    const res = await appFor(auth).request("/chat", json({ content: "/model", conversationId: conv }));
    const body = (await res.json()) as { command: string; models: string[]; current: string };
    expect(body.command).toBe("model.list");
    expect(body.current).toBe("qwen-code");
    expect(body.models).toContain("qwen-chat");
  });

  test("/model <name> switches a conversation's model (admin)", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id, { model: "qwen-chat" });
    const res = await appFor(auth).request("/chat", json({ content: "/model qwen-code", conversationId: conv }));
    const body = (await res.json()) as { command: string; model: string };
    expect(body).toMatchObject({ command: "model.set", model: "qwen-code" });
    expect(db.select().from(conversations).where(eq(conversations.id, conv)).get()?.model).toBe("qwen-code");
  });

  test("/model <name> rejected when the model isn't on an account's snapshotted allowlist → 403", async () => {
    const auth = makeAccount({ modelAllowlist: ["qwen-chat"] });
    const conv = makeConversation(auth.user.id);
    const res = await appFor(auth).request("/chat", json({ content: "/model qwen-code", conversationId: conv }));
    expect(res.status).toBe(403);
  });

  test("/model <name> with no conversation (non-temporary) → 400", async () => {
    const auth = makeAdmin();
    const res = await appFor(auth).request("/chat", json({ content: "/model qwen-code" }));
    expect(res.status).toBe(400);
  });

  test("/model <name> on a temporary chat just confirms the switch", async () => {
    const auth = makeAdmin();
    const res = await appFor(auth).request("/chat", json({ content: "/model qwen-code", temporary: true }));
    const body = (await res.json()) as { command: string; model: string };
    expect(body).toMatchObject({ command: "model.set", model: "qwen-code" });
  });

  test("budget-exhausted account → 402", async () => {
    const auth = makeAccount({ tokenBudget: 100 });
    db.insert(usageEvents).values({ userId: auth.user.id, tokensIn: 100, tokensOut: 0 }).run();
    const conv = makeConversation(auth.user.id);
    const res = await appFor(auth).request("/chat", json({ content: "hello", conversationId: conv, model: "qwen-chat" }));
    expect(res.status).toBe(402);
  });

  // An account is bounded to its snapshotted allowlist — a model off it → 403 (it must NOT be
  // waved through as if it were an admin).
  test("account user requesting a non-free-tier model → 403", async () => {
    const auth = makeAccount();
    const conv = makeConversation(auth.user.id);
    const res = await appFor(auth).request("/chat", json({ content: "hi", conversationId: conv, model: "qwen-code" }));
    expect(res.status).toBe(403);
  });

  // FIX 1: an account user's free-tier token budget is enforced from usage_events → 402.
  test("account user over the free-tier token budget → 402", async () => {
    const auth = makeAccount();
    // Burn the whole free-tier budget via a prior usage_events row for this user.
    db.insert(usageEvents).values({ userId: auth.user.id, tokensIn: config.freeTier.tokenBudget, tokensOut: 0 }).run();
    const conv = makeConversation(auth.user.id);
    const res = await appFor(auth).request("/chat", json({ content: "hi", conversationId: conv, model: "qwen-chat" }));
    expect(res.status).toBe(402);
  });

  test("conversation not found → 404", async () => {
    const auth = makeAdmin();
    const res = await appFor(auth).request("/chat", json({ content: "hi", conversationId: "missing" }));
    expect(res.status).toBe(404);
  });
});

// ---- POST /chat — full persisted turn (SSE → live registry) ---------------------------
describe("POST /chat — persisted streaming turn", () => {
  test("streams meta/delta/done, persists the user + assistant messages, tallies usage, titles", async () => {
    const auth = makeAdmin();
    const res = await appFor(auth).request("/chat", json({ content: "hi there", model: "qwen-chat" }));
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    const events = frames.map((f) => f.event);
    expect(events[0]).toBe("meta");
    expect(events).toContain("delta");
    expect(events.at(-1)).toBe("done");
    const deltaText = frames.filter((f) => f.event === "delta").map((f) => (f.data as { text: string }).text).join("");
    expect(deltaText).toBe("hello world");

    const done = frames.at(-1)?.data as { conversationId: string; usage: { promptTokens: number } };
    const conv = done.conversationId;
    const rows = db.select().from(messages).where(eq(messages.conversationId, conv)).all();
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows.find((r) => r.role === "assistant")?.content).toBe("hello world");
    // usage event recorded
    expect(db.select().from(usageEvents).where(eq(usageEvents.conversationId, conv)).all().length).toBe(1);
    // a fresh conversation gets an auto-title
    expect(db.select().from(conversations).where(eq(conversations.id, conv)).get()?.title).toBe("Generated Title");
  });

  // Reasoning (#68): a model that emits thinking has it streamed on its own `reasoning` frame,
  // persisted on the assistant row apart from the answer, and re-read by GET /conversations/:id.
  test("streams + persists model reasoning apart from the answer, and reads it back", async () => {
    const auth = makeAdmin();
    setChat((() =>
      (async function* () {
        yield { type: "reasoning", text: "let me think" } as ChatChunk;
        yield { type: "delta", text: "the answer" } as ChatChunk;
        yield { type: "done", usage: { promptTokens: 3, completionTokens: 4 } } as ChatChunk;
      })()) as never);
    const frames = await readFrames(await appFor(auth).request("/chat", json({ content: "hi", model: "qwen-chat" })));
    // The reasoning rides its own frame, never folded into the answer deltas.
    expect(frames.some((f) => f.event === "reasoning" && (f.data as { text: string }).text === "let me think")).toBe(true);
    const deltaText = frames.filter((f) => f.event === "delta").map((f) => (f.data as { text: string }).text).join("");
    expect(deltaText).toBe("the answer");

    const conv = (frames.at(-1)?.data as { conversationId: string }).conversationId;
    const assistant = db.select().from(messages).where(and(eq(messages.conversationId, conv), eq(messages.role, "assistant"))).get();
    expect(assistant?.content).toBe("the answer"); // answer stays clean
    expect(assistant?.reasoning).toBe("let me think"); // thinking persisted separately

    const read = (await (await appFor(auth).request(`/conversations/${conv}`)).json()) as {
      messages: { role: string; reasoning?: string | null }[];
    };
    expect(read.messages.find((m) => m.role === "assistant")?.reasoning).toBe("let me think");
  });

  // A non-reasoning reply persists a null reasoning (graceful degradation → no section shown).
  test("a reply with no thinking persists null reasoning", async () => {
    const auth = makeAdmin();
    const frames = await readFrames(await appFor(auth).request("/chat", json({ content: "hi", model: "qwen-chat" })));
    expect(frames.some((f) => f.event === "reasoning")).toBe(false);
    const conv = (frames.at(-1)?.data as { conversationId: string }).conversationId;
    const assistant = db.select().from(messages).where(and(eq(messages.conversationId, conv), eq(messages.role, "assistant"))).get();
    expect(assistant?.reasoning).toBeNull();
  });

  // Thinking toggle (#68 follow-up): body.thinking flows to the backend call as enableThinking,
  // so the model is asked to reason via enable_thinking. Off/absent ⇒ enableThinking false (today).
  test("body.thinking plumbs enableThinking through to the backend call", async () => {
    const auth = makeAdmin();
    let seen: { enableThinking?: boolean } | undefined;
    setChat(((req: { enableThinking?: boolean }) => {
      seen = req;
      return (async function* () {
        yield { type: "delta", text: "ok" } as ChatChunk;
        yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } } as ChatChunk;
      })();
    }) as never);
    await readFrames(await appFor(auth).request("/chat", json({ content: "hi", model: "qwen-chat", thinking: true })));
    expect(seen?.enableThinking).toBe(true);

    // Absent thinking ⇒ enableThinking false (unchanged behavior).
    await readFrames(await appFor(auth).request("/chat", json({ content: "again", model: "qwen-chat" })));
    expect(seen?.enableThinking).toBe(false);
  });

  // An account turn is attributed to the USER with keyId null (keys are retired), and the
  // tokens land in usage_events where the account's budget is summed from.
  test("account turn records a usage event attributed to the user, keyId null", async () => {
    const auth = makeAccount();
    const res = await appFor(auth).request("/chat", json({ content: "hi", model: "qwen-chat" }));
    await readFrames(res); // drain
    const ev = db.select().from(usageEvents).where(eq(usageEvents.userId, auth.user.id)).get();
    expect(ev).toBeDefined();
    expect(ev?.keyId).toBeNull(); // unattributed to any key — account users have none
    expect((ev?.tokensIn ?? 0) + (ev?.tokensOut ?? 0)).toBe(18); // 11 + 7 from the stub
  });

  test("an existing conversation's title is not overwritten", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id, { title: "Kept Title", model: "qwen-chat" });
    const res = await appFor(auth).request("/chat", json({ content: "another turn", conversationId: conv }));
    await readFrames(res);
    expect(db.select().from(conversations).where(eq(conversations.id, conv)).get()?.title).toBe("Kept Title");
  });

  test("a backend failure surfaces an error frame (turn not persisted as an answer)", async () => {
    const auth = makeAdmin();
    setChat((() =>
      (async function* () {
        yield { type: "delta", text: "partial" } as ChatChunk;
        throw new Error("jano blew up");
      })()) as never);
    const res = await appFor(auth).request("/chat", json({ content: "boom", model: "qwen-chat" }));
    const frames = await readFrames(res);
    expect(frames.at(-1)).toMatchObject({ event: "error", data: { message: "jano blew up" } });
  });
});

// ---- POST /chat — archivist opt-out (#27) ---------------------------------------------
describe("POST /chat — memory opt-out (#27)", () => {
  // Record the system prompt the runner sends upstream so we can see whether the owner's durable
  // facts were injected. (The write path — updateMemory/embedConversation — is stubbed to no-ops
  // above, so the observable behavior of the gate is what reaches the model.)
  function captureSystem(sink: { text: string }): void {
    setChat(((req: { messages: ChatMessage[] }) => {
      sink.text = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      return (async function* () {
        yield { type: "delta", text: "ok" } as ChatChunk;
        yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } } as ChatChunk;
      })();
    }) as never);
  }
  function setMemoryEnabled(userId: string, enabled: boolean): void {
    db.update(users).set({ preferences: JSON.stringify({ memory: { enabled } }) }).where(eq(users.id, userId)).run();
  }

  test("with memory ON (default), the owner's remembered facts ride the system prompt", async () => {
    const auth = makeAccount();
    db.insert(facts).values({ userId: auth.user.id, content: "the user loves espresso" }).run();
    const sink = { text: "" };
    captureSystem(sink);
    await readFrames(await appFor(auth).request("/chat", json({ content: "hi", model: "qwen-chat" })));
    expect(sink.text).toContain("the user loves espresso");
  });

  test("with memory OFF, the owner's facts are NOT injected", async () => {
    const auth = makeAccount();
    db.insert(facts).values({ userId: auth.user.id, content: "the user loves espresso" }).run();
    setMemoryEnabled(auth.user.id, false);
    const sink = { text: "" };
    captureSystem(sink);
    await readFrames(await appFor(auth).request("/chat", json({ content: "hi", model: "qwen-chat" })));
    expect(sink.text).not.toContain("the user loves espresso");
    expect(sink.text).not.toContain("What you remember about");
  });
});

// ---- POST /chat — files-to-prompt attachments (#128) ----------------------------------
describe("POST /chat — attachments (files-to-prompt)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  // Swap in a chat stub that records the messages the runner sent upstream, so we can assert the
  // inlined file text reached the model context.
  function captureChat(sink: { messages: ChatMessage[]; called: boolean }): void {
    setChat(((req: { messages: ChatMessage[] }) => {
      sink.messages = req.messages;
      sink.called = true;
      return (async function* () {
        yield { type: "delta", text: "ok" } as ChatChunk;
        yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } } as ChatChunk;
      })();
    }) as never);
  }

  test("inlines the attached file's text into the turn, persists the association, returns it on read", async () => {
    const auth = makeAdmin();
    const file = await createFile(auth.user.id, { filename: "notes.txt", contentType: "text/plain", bytes: enc("buy oat milk") });
    const sink = { messages: [] as ChatMessage[], called: false };
    captureChat(sink);

    const res = await appFor(auth).request("/chat", json({ content: "summarize my notes", model: "qwen-chat", fileIds: [file.id] }));
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    const done = frames.at(-1)?.data as { conversationId: string };

    // The file text reached the model as a system block, tagged with its name.
    const systemText = sink.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(systemText).toContain("buy oat milk");
    expect(systemText).toContain("notes.txt");

    // The association is persisted on the user message as metadata (never the bytes).
    const userRow = db.select().from(messages).where(eq(messages.conversationId, done.conversationId)).all().find((r) => r.role === "user");
    expect(userRow?.attachments).toBeTruthy();
    const stored = JSON.parse(userRow!.attachments!) as { id: string; name: string; contentType: string; size: number }[];
    expect(stored).toEqual([{ id: file.id, name: "notes.txt", contentType: "text/plain", size: 12 }]);

    // And it comes back on the conversation read for the transcript.
    const read = await appFor(auth).request(`/conversations/${done.conversationId}`);
    const payload = (await read.json()) as {
      messages: { role: string; attachments?: { id: string; name: string; contentType: string; size: number }[] }[];
    };
    const readUser = payload.messages.find((m) => m.role === "user");
    expect(readUser?.attachments).toEqual([{ id: file.id, name: "notes.txt", contentType: "text/plain", size: 12 }]);
  });

  test("a non-text attachment is persisted + shown but its bytes are not inlined", async () => {
    const auth = makeAdmin();
    const file = await createFile(auth.user.id, { filename: "pic.png", contentType: "image/png", bytes: enc("\x89PNGdata") });
    const sink = { messages: [] as ChatMessage[], called: false };
    captureChat(sink);

    const res = await appFor(auth).request("/chat", json({ content: "what is this", model: "qwen-chat", fileIds: [file.id] }));
    const frames = await readFrames(res);
    const done = frames.at(-1)?.data as { conversationId: string };
    const systemText = sink.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    // The image is named for the model but its bytes never appear inline.
    expect(systemText).toContain("pic.png");
    expect(systemText).not.toContain("PNGdata");
    // Still persisted so the transcript shows it.
    const userRow = db.select().from(messages).where(eq(messages.conversationId, done.conversationId)).all().find((r) => r.role === "user");
    expect(userRow?.attachments).toContain("pic.png");
  });

  test("rejects a stranger's file id with 404 and never starts the turn", async () => {
    const owner = makeAdmin();
    const stranger = makeAccount();
    const file = await createFile(owner.user.id, { filename: "secret.txt", contentType: "text/plain", bytes: enc("top secret") });
    const sink = { messages: [] as ChatMessage[], called: false };
    captureChat(sink);

    const res = await appFor(stranger).request("/chat", json({ content: "leak it", model: "qwen-chat", fileIds: [file.id] }));
    // A 400 (generic — no existence oracle), NOT a 404: a 404 would make the client redirect home.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unavailable");
    // No turn ran: the backend was never called and nothing was persisted for the stranger.
    expect(sink.called).toBe(false);
    expect(db.select().from(conversations).where(eq(conversations.userId, stranger.user.id)).all()).toHaveLength(0);
  });

  test("an unknown file id is a 400 (no existence oracle, not a redirect-home 404)", async () => {
    const auth = makeAccount();
    const res = await appFor(auth).request("/chat", json({ content: "hi", model: "qwen-chat", fileIds: ["nope-not-real"] }));
    expect(res.status).toBe(400);
  });

  test("a turn with no fileIds is unaffected (no attachments persisted)", async () => {
    const auth = makeAdmin();
    const res = await appFor(auth).request("/chat", json({ content: "plain turn", model: "qwen-chat" }));
    const frames = await readFrames(res);
    const done = frames.at(-1)?.data as { conversationId: string };
    const userRow = db.select().from(messages).where(eq(messages.conversationId, done.conversationId)).all().find((r) => r.role === "user");
    expect(userRow?.attachments).toBeNull();
  });

  test("delivers file text into a temporary (ghost) turn without persisting anything", async () => {
    const auth = makeAdmin();
    const file = await createFile(auth.user.id, { filename: "ghost.txt", contentType: "text/plain", bytes: enc("ephemeral context") });
    const sink = { messages: [] as ChatMessage[], called: false };
    captureChat(sink);

    const res = await appFor(auth).request("/chat", json({ content: "use my file", model: "qwen-chat", temporary: true, fileIds: [file.id] }));
    await readFrames(res);
    const systemText = sink.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(systemText).toContain("ephemeral context");
    // Ghost chat persists nothing — no conversation, no message rows.
    expect(db.select().from(conversations).where(eq(conversations.userId, auth.user.id)).all()).toHaveLength(0);
  });
});

// ---- POST /chat — temporary (ghost) turn ----------------------------------------------
describe("POST /chat — temporary (ghost) turn", () => {
  test("streams but persists NOTHING (no conversation, no messages) for this user", async () => {
    const auth = makeAdmin(); // a fresh user → its conversation/message counts start at 0
    const res = await appFor(auth).request("/chat", json({ content: "ghost", temporary: true, model: "qwen-chat", history: [{ role: "user", content: "earlier" }] }));
    const frames = await readFrames(res);
    const meta = frames[0]?.data as { temporary: boolean; conversationId: null };
    expect(meta.temporary).toBe(true);
    expect(meta.conversationId).toBeNull();
    expect(frames.at(-1)?.event).toBe("done");
    // Nothing was persisted for this user (a ghost chat is stateless).
    expect(db.select().from(conversations).where(eq(conversations.userId, auth.user.id)).all().length).toBe(0);
    expect(db.select().from(messages).where(eq(messages.userId, auth.user.id)).all().length).toBe(0);
  });

  test("a ghost turn still records a usage event (token accounting only)", async () => {
    const auth = makeAdmin();
    const before = db.select().from(usageEvents).all().length;
    const res = await appFor(auth).request("/chat", json({ content: "ghost", temporary: true, model: "qwen-chat" }));
    await readFrames(res);
    expect(db.select().from(usageEvents).all().length).toBe(before + 1);
  });

  test("a ghost turn with a disallowed model → 403", async () => {
    const auth = makeAccount({ modelAllowlist: ["qwen-chat"] });
    const res = await appFor(auth).request("/chat", json({ content: "ghost", temporary: true, model: "qwen-code" }));
    expect(res.status).toBe(403);
  });
});

// ---- POST /messages/:id/regenerate ----------------------------------------------------
describe("POST /messages/:id/regenerate", () => {
  test("streams a new variant, persists it active, demotes the original", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id, { model: "qwen-chat" });
    addMessage(auth.user.id, conv, "user", "what is 2+2?");
    const original = addMessage(auth.user.id, conv, "assistant", "four", { model: "qwen-chat", variantActive: true });

    const res = await appFor(auth).request(`/messages/${original}/regenerate`, { method: "POST" });
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    expect(frames[0]?.event).toBe("meta");
    const done = frames.at(-1)?.data as { variants: { content: string }[]; activeIndex: number; messageId: string };
    expect(done.variants.map((v) => v.content)).toEqual(["four", "hello world"]);
    expect(done.activeIndex).toBe(1);

    // The new variant is active; the original is demoted.
    const variantRows = db.select().from(messages).where(eq(messages.conversationId, conv)).all().filter((r) => r.role === "assistant");
    const active = variantRows.find((r) => r.variantActive);
    expect(active?.content).toBe("hello world");
    expect(db.select().from(messages).where(eq(messages.id, original)).get()?.variantActive).toBe(false);
  });

  test("404 for a non-assistant target message", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const userMsg = addMessage(auth.user.id, conv, "user", "hi");
    const res = await appFor(auth).request(`/messages/${userMsg}/regenerate`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("budget-exhausted account → 402", async () => {
    const auth = makeAccount({ tokenBudget: 50 });
    db.insert(usageEvents).values({ userId: auth.user.id, tokensIn: 50, tokensOut: 0 }).run();
    const conv = makeConversation(auth.user.id, { model: "qwen-chat" });
    addMessage(auth.user.id, conv, "user", "q");
    const m = addMessage(auth.user.id, conv, "assistant", "a", { model: "qwen-chat" });
    const res = await appFor(auth).request(`/messages/${m}/regenerate`, { method: "POST" });
    expect(res.status).toBe(402);
  });
});

// ---- POST /transcribe -----------------------------------------------------------------
describe("POST /transcribe", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("no audio file → 400", async () => {
    const auth = makeAdmin();
    const res = await appFor(auth).request("/transcribe", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
  });

  test("forwards audio to whisper + returns the transcript", async () => {
    const auth = makeAdmin();
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify({ text: "hello from whisper" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const form = new FormData();
    form.append("file", new Blob(["audio-bytes"], { type: "audio/webm" }), "clip.webm");
    const res = await appFor(auth).request("/transcribe", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect((await res.json()) as { text: string }).toEqual({ text: "hello from whisper" });
    expect(calledUrl).toContain("/v1/audio/transcriptions");
  });

  test("non-2xx from whisper → 502", async () => {
    const auth = makeAdmin();
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const form = new FormData();
    form.append("file", new Blob(["x"], { type: "audio/webm" }), "clip.webm");
    const res = await appFor(auth).request("/transcribe", { method: "POST", body: form });
    expect(res.status).toBe(502);
  });
});

// ---- owner share management (the public read path lives in src/share) ------------------
describe("conversation share endpoints", () => {
  test("GET share status: not shared, then shared after POST", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const before = await appFor(auth).request(`/conversations/${conv}/share`);
    expect(before.status).toBe(200);
    expect((await before.json()) as { shared: boolean }).toMatchObject({ shared: false, slug: null });

    const created = await appFor(auth).request(`/conversations/${conv}/share`, { method: "POST" });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { shared: boolean; slug: string; url: string };
    expect(body.shared).toBe(true);
    expect(body.slug.length).toBeGreaterThan(0);
    expect(body.url).toContain(`/s/${body.slug}`);

    const after = await appFor(auth).request(`/conversations/${conv}/share`);
    expect((await after.json()) as { slug: string }).toMatchObject({ shared: true, slug: body.slug });
  });

  test("POST share is idempotent — same slug on repeat", async () => {
    const auth = makeAccount();
    const conv = makeConversation(auth.user.id);
    const a = (await (await appFor(auth).request(`/conversations/${conv}/share`, { method: "POST" })).json()) as { slug: string };
    const b = (await (await appFor(auth).request(`/conversations/${conv}/share`, { method: "POST" })).json()) as { slug: string };
    expect(a.slug).toBe(b.slug);
  });

  test("DELETE unshares (status flips back to false)", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    await appFor(auth).request(`/conversations/${conv}/share`, { method: "POST" });
    const del = await appFor(auth).request(`/conversations/${conv}/share`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()) as { shared: boolean }).toMatchObject({ ok: true, shared: false });
    const after = await appFor(auth).request(`/conversations/${conv}/share`);
    expect((await after.json()) as { shared: boolean }).toMatchObject({ shared: false });
  });

  test("a conversation owned by someone else is 404 on every share verb", async () => {
    const owner = makeAdmin();
    const intruder = makeAccount();
    const conv = makeConversation(owner.user.id);
    expect((await appFor(intruder).request(`/conversations/${conv}/share`)).status).toBe(404);
    expect((await appFor(intruder).request(`/conversations/${conv}/share`, { method: "POST" })).status).toBe(404);
    expect((await appFor(intruder).request(`/conversations/${conv}/share`, { method: "DELETE" })).status).toBe(404);
  });

  test("POST on an unknown conversation is 404", async () => {
    const auth = makeAdmin();
    expect((await appFor(auth).request(`/conversations/missing/share`, { method: "POST" })).status).toBe(404);
  });
});

// ---- Share primitive: identity-bound collaborators -------------------------------------
// An account WITH a public handle set (#189) — the invitable identity the owner shares to (#177).
let acctSeq = 0;
function makeAccountWithHandle(handle: string): AuthContext {
  acctSeq++;
  const u = db
    .insert(users)
    .values({ login: `acct-${acctSeq}-${Math.random()}`, role: "account", accessGrantedAt: new Date(), handle })
    .returning()
    .get();
  return { role: "account", via: "session", user: u, key: null, accessGranted: true };
}

describe("collaborator endpoints (owner side)", () => {
  test("POST invites an existing account, then GET lists them", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_a");
    const conv = makeConversation(owner.user.id);

    const res = await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_a", role: "view" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { collaborator: { userId: string; role: string } }).toMatchObject({
      ok: true,
      collaborator: { userId: invitee.user.id, role: "view" },
    });

    const list = await appFor(owner).request(`/conversations/${conv}/collaborators`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { collaborators: { userId: string; handle: string; role: string }[] };
    expect(body.collaborators).toHaveLength(1);
    expect(body.collaborators[0]).toMatchObject({ userId: invitee.user.id, handle: "collab_a", role: "view" });
  });

  test("POST defaults to the 'view' role when none is given", async () => {
    const owner = makeAdmin();
    makeAccountWithHandle("collab_default");
    const conv = makeConversation(owner.user.id);
    const res = await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_default" }));
    expect((await res.json()) as { collaborator: { role: string } }).toMatchObject({ collaborator: { role: "view" } });
  });

  test("POST rejects a missing handle (400) and an invalid role (400)", async () => {
    const owner = makeAdmin();
    makeAccountWithHandle("collab_b");
    const conv = makeConversation(owner.user.id);
    expect((await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ role: "view" }))).status).toBe(400);
    expect((await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_b", role: "owner" }))).status).toBe(400);
  });

  test("POST is 404 for a handle with no account", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    const res = await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "ghost", role: "view" }));
    expect(res.status).toBe(404);
  });

  test("POST is 400 when inviting yourself", async () => {
    const owner = makeAccountWithHandle("collab_self");
    const conv = makeConversation(owner.user.id);
    const res = await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_self", role: "view" }));
    expect(res.status).toBe(400);
  });

  test("every collaborator verb is 404 on a conversation owned by someone else", async () => {
    const owner = makeAdmin();
    const intruder = makeAccount();
    const victim = makeAccountWithHandle("collab_victim");
    const conv = makeConversation(owner.user.id);
    expect((await appFor(intruder).request(`/conversations/${conv}/collaborators`)).status).toBe(404);
    expect((await appFor(intruder).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_victim", role: "view" }))).status).toBe(404);
    expect((await appFor(intruder).request(`/conversations/${conv}/collaborators/${victim.user.id}`, jsonWith("PATCH", { role: "edit" }))).status).toBe(404);
    expect((await appFor(intruder).request(`/conversations/${conv}/collaborators/${victim.user.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("PATCH changes a role; DELETE revokes the grant", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_c");
    const conv = makeConversation(owner.user.id);
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_c", role: "view" }));

    const patch = await appFor(owner).request(`/conversations/${conv}/collaborators/${invitee.user.id}`, jsonWith("PATCH", { role: "prompt" }));
    expect(patch.status).toBe(200);
    expect((await patch.json()) as { role: string }).toMatchObject({ ok: true, role: "prompt" });

    const del = await appFor(owner).request(`/conversations/${conv}/collaborators/${invitee.user.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    // Revoked: it no longer appears in the list.
    const list = (await (await appFor(owner).request(`/conversations/${conv}/collaborators`)).json()) as { collaborators: unknown[] };
    expect(list.collaborators).toHaveLength(0);
  });

  test("PATCH rejects an invalid role (400) and 404s an unknown target", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    expect((await appFor(owner).request(`/conversations/${conv}/collaborators/whoever`, jsonWith("PATCH", { role: "nope" }))).status).toBe(400);
    expect((await appFor(owner).request(`/conversations/${conv}/collaborators/whoever`, jsonWith("PATCH", { role: "edit" }))).status).toBe(404);
  });

  test("DELETE 404s a target who isn't a collaborator", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    expect((await appFor(owner).request(`/conversations/${conv}/collaborators/whoever`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("collaborator access to the shared conversation", () => {
  test("GET /conversations/:id is readable by a collaborator with their access role", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_read");
    const conv = makeConversation(owner.user.id, { title: "Shared" });
    addMessage(owner.user.id, conv, "user", "hi");
    addMessage(owner.user.id, conv, "assistant", "hello there");
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_read", role: "view" }));

    const res = await appFor(invitee).request(`/conversations/${conv}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { access: string }; messages: { content: string }[] };
    expect(body.conversation.access).toBe("view");
    expect(body.messages.map((m) => m.content)).toEqual(["hi", "hello there"]);
  });

  test("GET /conversations/:id reports the owner's own access as 'owner'", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    const res = await appFor(owner).request(`/conversations/${conv}`);
    expect((await res.json()) as { conversation: { access: string } }).toMatchObject({ conversation: { access: "owner" } });
  });

  test("a stranger still gets 404 on the conversation and its stream", async () => {
    const owner = makeAdmin();
    const stranger = makeAccount();
    const conv = makeConversation(owner.user.id);
    expect((await appFor(stranger).request(`/conversations/${conv}`)).status).toBe(404);
    expect((await appFor(stranger).request(`/conversations/${conv}/stream`)).status).toBe(404);
  });

  test("a collaborator reattaches to the owner's live turn over the stream", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_watch");
    const conv = makeConversation(owner.user.id);
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_watch", role: "view" }));
    // A live turn the OWNER is running (userId = owner). Buffer some text, then finish it so the
    // stream replays the buffered delta + terminal frame and closes (no open-ended SSE to hang on).
    const gen = beginLive(conv, owner.user.id, "qwen-chat");
    gen.pushDelta("partial answer");
    gen.finish({ conversationId: conv, model: "qwen-chat", usage: { promptTokens: 1, completionTokens: 1 } });

    const res = await appFor(invitee).request(`/conversations/${conv}/stream`);
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    expect(frames.some((f) => f.event === "delta" && (f.data as { text: string }).text === "partial answer")).toBe(true);
    expect(frames.some((f) => f.event === "done")).toBe(true);
  });

  test("GET stream is 204 when the shared conversation has nothing generating", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_idle");
    const conv = makeConversation(owner.user.id);
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_idle", role: "view" }));
    expect((await appFor(invitee).request(`/conversations/${conv}/stream`)).status).toBe(204);
  });
});

// ---- Archivist: conversation recap on return (#37) ------------------------------------
describe("conversation recap endpoints", () => {
  const RECAP = {
    topic: "Planning a trip to Lisbon",
    progress: ["Chose dates in May", "Shortlisted three neighborhoods"],
    whereItEnded: "Comparing hotels in Alfama",
    nextStep: "Pick one hotel and check availability",
  };
  // A stale (>24h), substantial (>=4 messages) thread: the recap gate. Timestamps are set old so
  // eligibility fires regardless of when the test runs.
  function seedStale(ownerId: string, conversationId: string, n = 4): void {
    const base = Date.now() - 3 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < n; i++) {
      db.insert(messages)
        .values({
          conversationId,
          userId: ownerId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}`,
          createdAt: new Date(base + i * 1000),
        })
        .run();
    }
  }

  test("401-equivalent aside, GET returns a recap for a stale, substantial owned conversation", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    seedStale(owner.user.id, conv);
    backend.complete = (async () => JSON.stringify(RECAP)) as typeof backend.complete;
    const res = await appFor(owner).request(`/conversations/${conv}/recap`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { recap: unknown }).toEqual({ recap: RECAP });
  });

  test("GET returns recap:null for a fresh conversation (recent activity)", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    addMessage(owner.user.id, conv, "user", "hi");
    addMessage(owner.user.id, conv, "assistant", "hello");
    addMessage(owner.user.id, conv, "user", "more");
    addMessage(owner.user.id, conv, "assistant", "sure"); // 4 msgs but all just now
    let called = false;
    backend.complete = (async () => {
      called = true;
      return JSON.stringify(RECAP);
    }) as typeof backend.complete;
    const res = await appFor(owner).request(`/conversations/${conv}/recap`);
    expect((await res.json()) as { recap: unknown }).toEqual({ recap: null });
    expect(called).toBe(false); // not eligible → no model spend
  });

  test("a collaborator sees the SAME recap as the owner (identical, no memory bleed)", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_recap");
    const conv = makeConversation(owner.user.id);
    seedStale(owner.user.id, conv);
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_recap", role: "view" }));
    backend.complete = (async () => JSON.stringify(RECAP)) as typeof backend.complete;

    const ownerRes = await appFor(owner).request(`/conversations/${conv}/recap`);
    const collabRes = await appFor(invitee).request(`/conversations/${conv}/recap`);
    expect(collabRes.status).toBe(200);
    expect((await collabRes.json()) as { recap: unknown }).toEqual((await ownerRes.json()) as { recap: unknown });
  });

  test("GET 404s a stranger and an unknown id (no existence oracle)", async () => {
    const owner = makeAdmin();
    const stranger = makeAccount();
    const conv = makeConversation(owner.user.id);
    seedStale(owner.user.id, conv);
    expect((await appFor(stranger).request(`/conversations/${conv}/recap`)).status).toBe(404);
    expect((await appFor(owner).request(`/conversations/does-not-exist/recap`)).status).toBe(404);
  });

  test("recap is generated once, then served from cache on re-open", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    seedStale(owner.user.id, conv);
    let calls = 0;
    backend.complete = (async () => {
      calls++;
      return JSON.stringify(RECAP);
    }) as typeof backend.complete;
    await appFor(owner).request(`/conversations/${conv}/recap`);
    await appFor(owner).request(`/conversations/${conv}/recap`);
    expect(calls).toBe(1);
  });

  test("dismiss hides the recap until new activity; 404s a stranger", async () => {
    const owner = makeAdmin();
    const stranger = makeAccount();
    const conv = makeConversation(owner.user.id);
    seedStale(owner.user.id, conv);
    backend.complete = (async () => JSON.stringify(RECAP)) as typeof backend.complete;
    await appFor(owner).request(`/conversations/${conv}/recap`); // cache it

    expect((await appFor(stranger).request(`/conversations/${conv}/recap/dismiss`, { method: "POST" })).status).toBe(404);

    const dismiss = await appFor(owner).request(`/conversations/${conv}/recap/dismiss`, { method: "POST" });
    expect(dismiss.status).toBe(200);
    // Dismissed → the GET now returns null.
    expect((await (await appFor(owner).request(`/conversations/${conv}/recap`)).json()) as { recap: unknown }).toEqual({ recap: null });

    // New activity (a fresh message, newer than the seeds but still >24h old) moves the
    // last-message id → the cache is stale → the recap shows again.
    db.insert(messages)
      .values({ conversationId: conv, userId: owner.user.id, role: "user", content: "back", createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .run();
    expect((await (await appFor(owner).request(`/conversations/${conv}/recap`)).json()) as { recap: unknown }).toEqual({ recap: RECAP });
  });

  test("a Jano failure degrades to recap:null (thread still renders)", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    seedStale(owner.user.id, conv);
    backend.complete = (async () => {
      throw new Error("jano down");
    }) as typeof backend.complete;
    const res = await appFor(owner).request(`/conversations/${conv}/recap`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { recap: unknown }).toEqual({ recap: null });
    expect(db.select().from(conversationRecaps).where(eq(conversationRecaps.conversationId, conv)).all()).toHaveLength(0);
  });

  // The `/recap` command force path (#37): GET .../recap?force=1 bypasses ONLY the 24h staleness
  // gate, never the auth/owner-memory scoping. Seed FRESH, substantial threads (recent activity)
  // so the default gate would reject them - only ?force=1 should recap.
  function seedFresh(ownerId: string, conversationId: string, n = 4): void {
    for (let i = 0; i < n; i++) {
      addMessage(ownerId, conversationId, i % 2 === 0 ? "user" : "assistant", `m${i}`);
    }
  }

  test("force=1 recaps a FRESH, substantial owned conversation the default gate rejects", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    seedFresh(owner.user.id, conv);
    backend.complete = (async () => JSON.stringify(RECAP)) as typeof backend.complete;
    // The default (non-force) read returns null for a fresh thread...
    expect((await (await appFor(owner).request(`/conversations/${conv}/recap`)).json()) as { recap: unknown }).toEqual({ recap: null });
    // ...but the force path surfaces it.
    const res = await appFor(owner).request(`/conversations/${conv}/recap?force=1`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { recap: unknown }).toEqual({ recap: RECAP });
  });

  test("force=1 still 404s a stranger and an unknown id (no existence oracle)", async () => {
    const owner = makeAdmin();
    const stranger = makeAccount();
    const conv = makeConversation(owner.user.id);
    seedFresh(owner.user.id, conv);
    expect((await appFor(stranger).request(`/conversations/${conv}/recap?force=1`)).status).toBe(404);
    expect((await appFor(owner).request(`/conversations/does-not-exist/recap?force=1`)).status).toBe(404);
  });

  test("force=1: a collaborator sees the SAME recap as the owner (no memory bleed)", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_force");
    const conv = makeConversation(owner.user.id);
    seedFresh(owner.user.id, conv);
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_force", role: "view" }));
    backend.complete = (async () => JSON.stringify(RECAP)) as typeof backend.complete;

    const ownerRes = await appFor(owner).request(`/conversations/${conv}/recap?force=1`);
    const collabRes = await appFor(invitee).request(`/conversations/${conv}/recap?force=1`);
    expect(collabRes.status).toBe(200);
    expect((await collabRes.json()) as { recap: unknown }).toEqual((await ownerRes.json()) as { recap: unknown });
  });

  test("force=1 returns recap:null for a too-thin thread (under the content floor)", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id);
    addMessage(owner.user.id, conv, "user", "just one message"); // 1 message < the floor
    let called = false;
    backend.complete = (async () => {
      called = true;
      return JSON.stringify(RECAP);
    }) as typeof backend.complete;
    const res = await appFor(owner).request(`/conversations/${conv}/recap?force=1`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { recap: unknown }).toEqual({ recap: null });
    expect(called).toBe(false); // too thin → no model spend
  });
});

// ---- POST /chat — collaborative send (#46) --------------------------------------------
// A collaborator whose role includes `prompt` can start a turn on the OWNER's conversation.
// The turn's messages belong to the owner (so the owner keeps their per-message controls),
// but budget / usage is charged to the collaborator who ran it. Lower roles + strangers are
// rejected before any write.
describe("POST /chat — collaborative send (#46)", () => {
  test("a 'prompt' collaborator sends a turn; messages persist under the OWNER, usage charged to the collaborator", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_send");
    const conv = makeConversation(owner.user.id, { title: "Kept", model: "qwen-chat" });
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_send", role: "prompt" }));

    const res = await appFor(invitee).request("/chat", json({ content: "hi from collab", conversationId: conv, model: "qwen-chat" }));
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    expect(frames.at(-1)?.event).toBe("done");
    const deltaText = frames.filter((f) => f.event === "delta").map((f) => (f.data as { text: string }).text).join("");
    expect(deltaText).toBe("hello world");

    // Messages belong to the conversation OWNER — memory + the owner's per-message controls
    // (vote / regenerate / select) stay intact on their own chat.
    const rows = db.select().from(messages).where(eq(messages.conversationId, conv)).all();
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows.every((r) => r.userId === owner.user.id)).toBe(true);
    // Usage is attributed to the PROMPTER (the collaborator spends their OWN quota), never the owner.
    const usage = db.select().from(usageEvents).where(eq(usageEvents.conversationId, conv)).all();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.userId).toBe(invitee.user.id);
    expect(db.select().from(usageEvents).where(eq(usageEvents.userId, owner.user.id)).all()).toHaveLength(0);
    // The owner's existing title is untouched.
    expect(db.select().from(conversations).where(eq(conversations.id, conv)).get()?.title).toBe("Kept");
  });

  test("a collaborator's turn is NOT seeded with the owner's private cross-conversation memory", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_mem");
    const conv = makeConversation(owner.user.id, { title: "Shared", model: "qwen-chat" });
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_mem", role: "prompt" }));
    // The owner has private durable facts + a voted example from their OTHER chats. Granting
    // `prompt` on THIS conversation is not consent to read those back out through the model.
    db.insert(facts).values({ userId: owner.user.id, content: "owner secret: banking password hint" }).run();
    addMessage(owner.user.id, makeConversation(owner.user.id), "assistant", "a liked private answer", { vote: 1 });

    let captured = "";
    setChat((req) => {
      const sys = (req as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "system");
      captured = sys?.content ?? "";
      return defaultChat()(req);
    });

    const res = await appFor(invitee).request("/chat", json({ content: "what do you remember about the owner?", conversationId: conv, model: "qwen-chat" }));
    await readFrames(res);
    expect(captured).not.toContain("owner secret");
    expect(captured).not.toContain("What you remember about");
    expect(captured).not.toContain("a liked private answer");
    expect(captured).not.toContain("Relevant context from earlier conversations");
  });

  test("the OWNER's own turn still gets their durable facts", async () => {
    const owner = makeAdmin();
    const conv = makeConversation(owner.user.id, { title: "Mine", model: "qwen-chat" });
    db.insert(facts).values({ userId: owner.user.id, content: "prefers concise answers" }).run();

    let captured = "";
    setChat((req) => {
      const sys = (req as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "system");
      captured = sys?.content ?? "";
      return defaultChat()(req);
    });

    const res = await appFor(owner).request("/chat", json({ content: "hi", conversationId: conv, model: "qwen-chat" }));
    await readFrames(res);
    expect(captured).toContain("What you remember about");
    expect(captured).toContain("prefers concise answers");
  });

  test("a collaborator's pick does NOT stick as the owner's model on a model-less conversation", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_model");
    const conv = makeConversation(owner.user.id, { title: "No model yet" }); // model is null
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_model", role: "prompt" }));

    const res = await appFor(invitee).request("/chat", json({ content: "run on my model", conversationId: conv, model: "qwen-chat" }));
    expect(res.status).toBe(200);
    await readFrames(res);
    // The turn ran, but the collaborator's model choice never became the owner's default.
    expect(db.select().from(conversations).where(eq(conversations.id, conv)).get()?.model).toBeNull();
  });

  test("a read-only collaborator (view) cannot send — 403, no message written", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_ro");
    const conv = makeConversation(owner.user.id, { model: "qwen-chat" });
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_ro", role: "view" }));

    const res = await appFor(invitee).request("/chat", json({ content: "let me in", conversationId: conv, model: "qwen-chat" }));
    expect(res.status).toBe(403);
    expect(db.select().from(messages).where(eq(messages.conversationId, conv)).all()).toHaveLength(0);
  });

  test("a stranger sending to someone else's conversation gets 404 (no existence oracle), no write", async () => {
    const owner = makeAdmin();
    const stranger = makeAccount();
    const conv = makeConversation(owner.user.id, { model: "qwen-chat" });
    const res = await appFor(stranger).request("/chat", json({ content: "hi", conversationId: conv, model: "qwen-chat" }));
    expect(res.status).toBe(404);
    expect(db.select().from(messages).where(eq(messages.conversationId, conv)).all()).toHaveLength(0);
  });
});

// ---- POST /conversations/:id/todo — owner-side TODO toggle (#131) ----------------------
// The owner (or an edit/prompt collaborator) ticks a shared shopping-list / task-list checkbox
// in their OWN conversation. Authorized by the auth gate + resolveConversationAccess; scoped to a
// single checkbox of a message in THAT conversation. A read-only collaborator is a 403, a stranger
// a 404 (no existence oracle), and every rejection leaves the message content untouched.
describe("POST /conversations/:id/todo", () => {
  const CONTENT = "- [ ] eggs\n- [ ] flour";
  const contentOf = (mid: string) => db.select().from(messages).where(eq(messages.id, mid)).get()?.content;

  test("owner ticks a checkbox → 200, content persisted", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const mid = addMessage(auth.user.id, conv, "assistant", CONTENT);
    const res = await appFor(auth).request(`/conversations/${conv}/todo`, json({ messageId: mid, index: 1, done: true }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { content: string }).toMatchObject({ ok: true, content: "- [ ] eggs\n- [x] flour" });
    expect(contentOf(mid)).toBe("- [ ] eggs\n- [x] flour");
  });

  test("owner unticks a checkbox → 200, content persisted", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const mid = addMessage(auth.user.id, conv, "assistant", "- [x] eggs");
    const res = await appFor(auth).request(`/conversations/${conv}/todo`, json({ messageId: mid, index: 0, done: false }));
    expect(res.status).toBe(200);
    expect(contentOf(mid)).toBe("- [ ] eggs");
  });

  test("a malformed body (missing/typed-wrong fields) → 400", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const mid = addMessage(auth.user.id, conv, "assistant", CONTENT);
    const app = appFor(auth);
    expect((await app.request(`/conversations/${conv}/todo`, json({ index: 0, done: true }))).status).toBe(400); // no messageId
    expect((await app.request(`/conversations/${conv}/todo`, json({ messageId: mid, index: "0", done: true }))).status).toBe(400); // index not a number
    expect((await app.request(`/conversations/${conv}/todo`, json({ messageId: mid, index: 0, done: "yes" }))).status).toBe(400); // done not a bool
    expect(contentOf(mid)).toBe(CONTENT); // no write on any rejection
  });

  test("an out-of-range index → 404, no write", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const mid = addMessage(auth.user.id, conv, "assistant", CONTENT);
    const res = await appFor(auth).request(`/conversations/${conv}/todo`, json({ messageId: mid, index: 9, done: true }));
    expect(res.status).toBe(404);
    expect(contentOf(mid)).toBe(CONTENT);
  });

  test("a message from ANOTHER conversation → 404, no write (scoping guard)", async () => {
    const auth = makeAdmin();
    const conv = makeConversation(auth.user.id);
    const other = makeConversation(auth.user.id);
    const mid = addMessage(auth.user.id, other, "assistant", CONTENT); // message lives in `other`, not `conv`
    const res = await appFor(auth).request(`/conversations/${conv}/todo`, json({ messageId: mid, index: 0, done: true }));
    expect(res.status).toBe(404);
    expect(contentOf(mid)).toBe(CONTENT);
  });

  test("a stranger's conversation → 404 (no existence oracle), no write", async () => {
    const owner = makeAdmin();
    const stranger = makeAccount();
    const conv = makeConversation(owner.user.id);
    const mid = addMessage(owner.user.id, conv, "assistant", CONTENT);
    const res = await appFor(stranger).request(`/conversations/${conv}/todo`, json({ messageId: mid, index: 0, done: true }));
    expect(res.status).toBe(404);
    expect(contentOf(mid)).toBe(CONTENT);
  });

  test("an unknown conversation id → 404", async () => {
    const auth = makeAdmin();
    const res = await appFor(auth).request(`/conversations/missing/todo`, json({ messageId: "m", index: 0, done: true }));
    expect(res.status).toBe(404);
  });

  test("a read-only collaborator (view) → 403, no write", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("todo_ro");
    const conv = makeConversation(owner.user.id);
    const mid = addMessage(owner.user.id, conv, "assistant", CONTENT);
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "todo_ro", role: "view" }));
    const res = await appFor(invitee).request(`/conversations/${conv}/todo`, json({ messageId: mid, index: 0, done: true }));
    expect(res.status).toBe(403);
    expect(contentOf(mid)).toBe(CONTENT);
  });

  test("an edit collaborator ticks a checkbox → 200, content persisted (rides resolveConversationAccess)", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("todo_edit");
    const conv = makeConversation(owner.user.id);
    const mid = addMessage(owner.user.id, conv, "assistant", CONTENT);
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "todo_edit", role: "edit" }));
    const res = await appFor(invitee).request(`/conversations/${conv}/todo`, json({ messageId: mid, index: 0, done: true }));
    expect(res.status).toBe(200);
    expect(contentOf(mid)).toBe("- [x] eggs\n- [ ] flour");
  });
});

describe("GET /shared-conversations", () => {
  test("lists the conversations shared WITH the caller (with owner name + role)", async () => {
    const owner = makeAdmin();
    const invitee = makeAccountWithHandle("collab_list");
    const conv = makeConversation(owner.user.id, { title: "Owner's chat" });
    await appFor(owner).request(`/conversations/${conv}/collaborators`, json({ handle: "collab_list", role: "edit" }));

    const res = await appFor(invitee).request(`/shared-conversations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: { id: string; title: string; role: string; ownerName: string; generating: boolean }[] };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({ id: conv, title: "Owner's chat", role: "edit", ownerName: "Leo", generating: false });
  });

  test("is empty for a caller no one has shared with", async () => {
    const loner = makeAccount();
    const res = await appFor(loner).request(`/shared-conversations`);
    expect((await res.json()) as { conversations: unknown[] }).toEqual({ conversations: [] });
  });
});

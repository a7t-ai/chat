import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index.ts";
import { conversations, messages, users } from "../db/schema.ts";
import { beginLive } from "../chat/live.ts";
import { createShare } from "../chat/shares.ts";
import shareRoutes from "./routes.ts";
import { mintWriteToken } from "./write-token.ts";

// The PUBLIC share read path: snapshot + live stream, reachable with NO auth. We mount the
// real router with no auth middleware (mirroring the GET-only carve-out in server.ts), then
// drive it with app.request(...). Backend/Jano are never touched — the live stream is fed by
// driving a `beginLive` registry entry directly.

function app(): Hono {
  const a = new Hono();
  a.route("/", shareRoutes);
  return a;
}

function makeOwner(): { id: string; email: string; login: string } {
  const u = db
    .insert(users)
    .values({ login: `owner-${Math.random()}`, role: "account", email: `e${Math.random()}@x.test`, displayName: "Secret Owner" })
    .returning()
    .get();
  return { id: u.id, email: u.email!, login: u.login };
}
function makeConversation(userId: string, title?: string): string {
  return db.insert(conversations).values({ userId, title: title ?? null }).returning().get().id;
}
function addMessage(userId: string, conversationId: string, role: "user" | "assistant", content: string): void {
  db.insert(messages).values({ conversationId, userId, role, content, model: "qwen-chat", vote: 1 }).run();
}
function addTodoMessage(userId: string, conversationId: string, content: string): string {
  return db
    .insert(messages)
    .values({ conversationId, userId, role: "assistant", content, model: "qwen-chat" })
    .returning()
    .get().id;
}
function contentOf(messageId: string): string | undefined {
  return db.select({ content: messages.content }).from(messages).where(eq(messages.id, messageId)).get()?.content;
}

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
    let data: unknown = dataLines.join("\n");
    try {
      data = JSON.parse(data as string);
    } catch {
      /* leave raw */
    }
    frames.push({ event, data });
  }
  return frames;
}

describe("GET /:slug (snapshot)", () => {
  test("returns the shared conversation title + active thread", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id, "Trip to Japan");
    addMessage(owner.id, conv, "user", "plan a trip");
    addMessage(owner.id, conv, "assistant", "here is a plan");
    const share = createShare(owner.id, conv)!;

    const res = await app().request(`/${share.slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: string; title: string | null };
      messages: { role: string; content: string }[];
    };
    expect(body.conversation.title).toBe("Trip to Japan");
    expect(body.messages.map((m) => m.content)).toEqual(["plan a trip", "here is a plan"]);
  });

  test("never leaks owner identity or votes", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id, "Private-ish");
    addMessage(owner.id, conv, "user", "hi");
    const share = createShare(owner.id, conv)!;

    const res = await app().request(`/${share.slug}`);
    const raw = await res.text();
    expect(raw).not.toContain(owner.email);
    expect(raw).not.toContain(owner.login);
    expect(raw).not.toContain(owner.id);
    // votes are an owner-private signal — not in the public payload
    const body = JSON.parse(raw) as { messages: Record<string, unknown>[] };
    expect(body.messages[0]).not.toHaveProperty("vote");
  });

  test("404s an unknown slug", async () => {
    const res = await app().request("/totally-unknown");
    expect(res.status).toBe(404);
  });

  test("includes a write token so the viewer can tick TODOs, but no owner identity", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id, "Recipe");
    addMessage(owner.id, conv, "assistant", "- [ ] eggs");
    const share = createShare(owner.id, conv)!;

    const res = await app().request(`/${share.slug}`);
    const body = (await res.json()) as { writeToken?: string; writeTokenExpiresAt?: number };
    expect(typeof body.writeToken).toBe("string");
    expect(body.writeToken!.length).toBeGreaterThan(0);
    expect(body.writeTokenExpiresAt).toBeGreaterThan(0);
  });
});

describe("POST /:slug/todo (public TODO toggle)", () => {
  function post(slug: string, token: string | null, body: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers["x-a7t-share-write"] = token;
    return app().request(`/${slug}/todo`, { method: "POST", headers, body: JSON.stringify(body) });
  }

  test("ticks a checkbox with a valid token and persists it", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id);
    const mid = addTodoMessage(owner.id, conv, "- [ ] eggs\n- [ ] flour");
    const share = createShare(owner.id, conv)!;
    const { token } = mintWriteToken(share.slug);

    const res = await post(share.slug, token, { messageId: mid, index: 1, done: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; content: string };
    expect(body.ok).toBe(true);
    expect(body.content).toBe("- [ ] eggs\n- [x] flour");
    expect(contentOf(mid)).toBe("- [ ] eggs\n- [x] flour");
  });

  test("without a token it is a rejected no-op (401, content untouched)", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id);
    const mid = addTodoMessage(owner.id, conv, "- [ ] eggs");
    const share = createShare(owner.id, conv)!;

    const res = await post(share.slug, null, { messageId: mid, index: 0, done: true });
    expect(res.status).toBe(401);
    expect(contentOf(mid)).toBe("- [ ] eggs"); // no write happened
  });

  test("an invalid/forged token is a rejected no-op (401)", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id);
    const mid = addTodoMessage(owner.id, conv, "- [ ] eggs");
    const share = createShare(owner.id, conv)!;

    const res = await post(share.slug, "9999999999999.deadbeef", { messageId: mid, index: 0, done: true });
    expect(res.status).toBe(401);
    expect(contentOf(mid)).toBe("- [ ] eggs");
  });

  test("a token minted for another slug cannot write here (slug-bound)", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id);
    const mid = addTodoMessage(owner.id, conv, "- [ ] eggs");
    const share = createShare(owner.id, conv)!;
    const foreignToken = mintWriteToken("some-other-slug").token;

    const res = await post(share.slug, foreignToken, { messageId: mid, index: 0, done: true });
    expect(res.status).toBe(401);
    expect(contentOf(mid)).toBe("- [ ] eggs");
  });

  test("rejects a malformed body (400)", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id);
    const share = createShare(owner.id, conv)!;
    const { token } = mintWriteToken(share.slug);

    const res = await post(share.slug, token, { messageId: 123, index: "nope" });
    expect(res.status).toBe(400);
  });

  test("404s a revoked/unknown slug even with a (slug-matching) token", async () => {
    // Token is bound to the slug string, so it 'verifies' shape-wise; the share lookup then 404s.
    const { token } = mintWriteToken("ghost-slug");
    const res = await post("ghost-slug", token, { messageId: "x", index: 0, done: true });
    expect(res.status).toBe(404);
  });

  test("404s an out-of-range index (no partial write, no existence oracle)", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id);
    const mid = addTodoMessage(owner.id, conv, "- [ ] only one");
    const share = createShare(owner.id, conv)!;
    const { token } = mintWriteToken(share.slug);

    const res = await post(share.slug, token, { messageId: mid, index: 9, done: true });
    expect(res.status).toBe(404);
    expect(contentOf(mid)).toBe("- [ ] only one");
  });

  test("per-token rate limit kicks in after the cap (429)", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id);
    const mid = addTodoMessage(owner.id, conv, "- [ ] a\n- [ ] b");
    const share = createShare(owner.id, conv)!;
    const { token } = mintWriteToken(share.slug);

    const cap = 30; // config.share.writeRateLimitPerMin default
    let sawLimit = false;
    for (let i = 0; i < cap + 5; i++) {
      const res = await post(share.slug, token, { messageId: mid, index: 0, done: i % 2 === 0 });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});

describe("GET /:slug/stream (live watch)", () => {
  test("404s an unknown slug", async () => {
    const res = await app().request("/nope/stream");
    expect(res.status).toBe(404);
  });

  test("204s when nothing is generating right now", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id);
    const share = createShare(owner.id, conv)!;
    const res = await app().request(`/${share.slug}/stream`);
    expect(res.status).toBe(204);
  });

  test("streams the in-flight generation to an anonymous watcher", async () => {
    const owner = makeOwner();
    const conv = makeConversation(owner.id);
    const share = createShare(owner.id, conv)!;

    // Simulate a turn running for this conversation, decoupled from any request.
    const gen = beginLive(conv, owner.id, "qwen-chat");
    gen.pushDelta("hello ");
    gen.pushDelta("world");

    const resP = app().request(`/${share.slug}/stream`);
    // Let the SSE handler subscribe, then finish the turn so the stream ends deterministically.
    await new Promise((r) => setTimeout(r, 10));
    gen.finish({ conversationId: conv, model: "qwen-chat", usage: { promptTokens: 1, completionTokens: 2 } });

    const res = await resP;
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    const delta = frames.filter((f) => f.event === "delta").map((f) => (f.data as { text: string }).text).join("");
    expect(delta).toContain("hello world");
    expect(frames.some((f) => f.event === "done")).toBe(true);
  });
});

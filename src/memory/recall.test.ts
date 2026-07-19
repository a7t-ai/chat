import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { conversations, memoryChunks, messages, users } from "../db/schema.ts";
import { embedder } from "../embed/client.ts";
import { embedConversation, recall } from "./recall.ts";

// Tier-3 semantic recall. The embed service is STUBBED — these tests never hit the network.
// We swap embedder.embed for a deterministic fake so cosine math + the read/write paths are
// fully covered. (jano is not used by recall.ts; only the embedder is.)

const realEmbed = embedder.embed.bind(embedder);
afterEach(() => {
  embedder.embed = realEmbed;
});

// Stub: map a string to a fixed-dim vector. Default keys content by its first char so we
// can craft "near" vs "far" embeddings deterministically.
function stubEmbed(fn: (text: string) => number[]): void {
  embedder.embed = (async (text: string) => fn(text)) as typeof embedder.embed;
}
function stubThrows(): void {
  embedder.embed = (async () => {
    throw new Error("embed service down");
  }) as typeof embedder.embed;
}

function makeUser(): string {
  return db.insert(users).values({ login: `u-${Math.random()}`, role: "guest" }).returning().get().id;
}
function makeConversation(userId: string): string {
  return db.insert(conversations).values({ userId, title: "C" }).returning().get().id;
}
function addMessage(userId: string, conversationId: string, role: "system" | "user" | "assistant", content: string): string {
  return db.insert(messages).values({ conversationId, userId, role, content }).returning().get().id;
}

describe("embedConversation (WRITE)", () => {
  test("embeds user + assistant messages, skips system + blank", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    addMessage(u, c, "system", "you are a bot");
    addMessage(u, c, "user", "hello world");
    addMessage(u, c, "assistant", "hi there");
    addMessage(u, c, "user", "   "); // blank → skipped
    stubEmbed(() => [1, 0, 0]);

    await embedConversation(u, c);

    const chunks = db.select().from(memoryChunks).where(eq(memoryChunks.userId, u)).all();
    expect(chunks.length).toBe(2); // system + blank excluded
    expect(chunks.map((ch) => ch.content).sort()).toEqual(["hello world", "hi there"]);
    expect(chunks[0]?.embeddingModel).toBe("bge-m3");
    expect(chunks[0]?.embeddedAt).toBeInstanceOf(Date);
    expect(chunks[0]?.embedding).toBeInstanceOf(Uint8Array);
  });

  test("stores embeddings as Float32 blobs that round-trip", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    addMessage(u, c, "user", "round trip");
    stubEmbed(() => [0.5, -0.25, 2]);
    await embedConversation(u, c);
    const chunk = db.select().from(memoryChunks).where(eq(memoryChunks.userId, u)).get();
    const f32 = new Float32Array(new Uint8Array(chunk!.embedding as Uint8Array).buffer);
    expect(Array.from(f32)).toEqual([0.5, -0.25, 2]);
  });

  test("does not re-embed already-embedded messages (idempotent)", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    addMessage(u, c, "user", "once");
    let calls = 0;
    stubEmbed(() => {
      calls++;
      return [1, 0];
    });
    await embedConversation(u, c);
    await embedConversation(u, c); // second pass should embed nothing new
    expect(calls).toBe(1);
    expect(db.select().from(memoryChunks).where(eq(memoryChunks.userId, u)).all().length).toBe(1);
  });

  test("embed failure is swallowed (best-effort) — no chunk written, no throw", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    addMessage(u, c, "user", "will fail");
    stubThrows();
    await embedConversation(u, c); // returns on the throw
    expect(db.select().from(memoryChunks).where(eq(memoryChunks.userId, u)).all().length).toBe(0);
  });

  test("no messages → no-op", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    stubEmbed(() => [1]);
    await embedConversation(u, c);
    expect(db.select().from(memoryChunks).where(eq(memoryChunks.userId, u)).all().length).toBe(0);
  });
});

describe("recall (READ)", () => {
  // Seed a user with embedded chunks across two conversations.
  async function seed(): Promise<{ userId: string; current: string; other: string }> {
    const u = makeUser();
    const current = makeConversation(u);
    const other = makeConversation(u);
    // "near" message in the OTHER conversation (vector aligned with the query).
    const m1 = addMessage(u, other, "user", "lisbon trip notes");
    // "far" message (orthogonal vector → cosine ~0, below minScore).
    const m2 = addMessage(u, other, "assistant", "unrelated cooking");
    // a message in the CURRENT conversation (must be excluded from recall).
    const m3 = addMessage(u, current, "user", "current convo");

    const put = (mid: string, v: number[]) =>
      db.insert(memoryChunks).values({
        userId: u,
        messageId: mid,
        content: db.select().from(messages).where(eq(messages.id, mid)).get()!.content,
        embedding: Buffer.from(new Float32Array(v).buffer),
        embeddingModel: "bge-m3",
        embeddedAt: new Date(),
      }).run();
    put(m1, [1, 0, 0]); // aligned with query [1,0,0]
    put(m2, [0, 1, 0]); // orthogonal → score 0
    put(m3, [1, 0, 0]); // aligned but in current convo → excluded
    return { userId: u, current, other };
  }

  test("empty query short-circuits to [] (no embed call)", async () => {
    let called = false;
    stubEmbed(() => {
      called = true;
      return [1];
    });
    expect(await recall(makeUser(), "   ", null)).toEqual([]);
    expect(called).toBe(false);
  });

  test("returns the relevant chunk from OTHER conversations, excludes the current one", async () => {
    const { userId, current } = await seed();
    stubEmbed(() => [1, 0, 0]); // query vector aligned with the 'near' chunk
    const out = await recall(userId, "lisbon", current, 4, 0.4);
    expect(out).toEqual(["lisbon trip notes"]); // far chunk below minScore, current excluded
  });

  test("excludeConversationId = null returns nothing extra (no current to drop) but still cross-scopes", async () => {
    const { userId } = await seed();
    stubEmbed(() => [1, 0, 0]);
    const out = await recall(userId, "lisbon", null, 4, 0.4);
    // With no exclusion, both aligned chunks (other + current) qualify above minScore.
    expect(out).toContain("lisbon trip notes");
    expect(out).toContain("current convo");
    expect(out).not.toContain("unrelated cooking"); // still below minScore
  });

  test("minScore filters out weak matches", async () => {
    const { userId, current } = await seed();
    stubEmbed(() => [0, 1, 0]); // aligns only with the 'far' (cooking) chunk
    // The cooking chunk now scores ~1, but lisbon scores 0. With a high minScore the
    // cooking chunk passes; with the query orthogonal to lisbon it's excluded.
    const out = await recall(userId, "cooking", current, 4, 0.5);
    expect(out).toEqual(["unrelated cooking"]);
  });

  test("k caps the number of results", async () => {
    const u = makeUser();
    const current = makeConversation(u);
    const other = makeConversation(u);
    for (let i = 0; i < 5; i++) {
      const mid = addMessage(u, other, "user", `note ${i}`);
      db.insert(memoryChunks).values({
        userId: u,
        messageId: mid,
        content: `note ${i}`,
        embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer),
        embeddingModel: "bge-m3",
        embeddedAt: new Date(),
      }).run();
    }
    stubEmbed(() => [1, 0, 0]);
    const out = await recall(u, "q", current, 2, 0.4);
    expect(out.length).toBe(2);
  });

  test("embed failure on the query → [] (best-effort, no throw)", async () => {
    const { userId, current } = await seed();
    stubThrows();
    expect(await recall(userId, "lisbon", current)).toEqual([]);
  });

  test("no embedded chunks at all → []", async () => {
    const u = makeUser();
    stubEmbed(() => [1, 0, 0]);
    expect(await recall(u, "anything", null)).toEqual([]);
  });
});

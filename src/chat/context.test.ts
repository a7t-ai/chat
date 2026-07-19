import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { conversations, messages, summaries, users } from "../db/schema.ts";
import { estimateTokens, estimateTurnsTokens, FALLBACK_CONTEXT_WINDOW } from "./compaction.ts";
import { conversationContextUsage } from "./context.ts";
import { thread } from "./service.ts";

afterEach(() => {
  db.delete(messages).run();
  db.delete(summaries).run();
  db.delete(conversations).run();
  db.delete(users).run();
});

function seed(contents: string[]): { userId: string; convId: string; ids: string[] } {
  const userId = db.insert(users).values({ login: `u-${Math.random()}`, role: "account" }).returning().get().id;
  const convId = db.insert(conversations).values({ userId }).returning().get().id;
  const ids: string[] = [];
  contents.forEach((content, i) => {
    const id = db
      .insert(messages)
      .values({ conversationId: convId, userId, role: i % 2 === 0 ? "user" : "assistant", content, createdAt: new Date(1000 + i) })
      .returning()
      .get().id;
    ids.push(id);
  });
  return { userId, convId, ids };
}

describe("conversationContextUsage (#38)", () => {
  test("meters the full thread against the catalog window (qwen-chat = 32768)", () => {
    const { userId, convId } = seed(["hello", "there", "friend"]);
    const usage = conversationContextUsage({
      slots: thread(convId),
      ownerId: userId,
      conversationId: convId,
      model: "qwen-chat",
      compactedThroughMessageId: null,
    });
    expect(usage.windowTokens).toBe(32768);
    expect(usage.usedTokens).toBe(estimateTurnsTokens([{ content: "hello" }, { content: "there" }, { content: "friend" }]));
    expect(usage.shouldPrompt).toBe(false);
    expect(usage.showMeter).toBe(false);
  });

  test("an unknown model degrades fail-safe to the conservative window", () => {
    const { userId, convId } = seed(["a", "b"]);
    const usage = conversationContextUsage({
      slots: thread(convId),
      ownerId: userId,
      conversationId: convId,
      model: "mystery/model",
      compactedThroughMessageId: null,
    });
    expect(usage.windowTokens).toBe(FALLBACK_CONTEXT_WINDOW);
  });

  test("null model falls back to the default model's window", () => {
    const { userId, convId } = seed(["a", "b"]);
    const usage = conversationContextUsage({
      slots: thread(convId),
      ownerId: userId,
      conversationId: convId,
      model: null,
      compactedThroughMessageId: null,
    });
    expect(usage.windowTokens).toBe(32768); // default model qwen-chat
  });

  test("a compaction boundary shrinks the metered usage + folds in the summary", () => {
    const { userId, convId, ids } = seed(["m0", "m1", "m2", "m3"]);
    db.insert(summaries).values({ userId, scope: "conversation", conversationId: convId, content: "the fold" }).run();
    // Fold through m1 → only m2, m3 count verbatim, plus the summary.
    const usage = conversationContextUsage({
      slots: thread(convId),
      ownerId: userId,
      conversationId: convId,
      model: "qwen-chat",
      compactedThroughMessageId: ids[1]!,
    });
    const expected = estimateTurnsTokens([{ content: "m2" }, { content: "m3" }]) + estimateTokens("the fold");
    expect(usage.usedTokens).toBe(expected);
  });

  test("a long thread crosses the prompt threshold and lights the meter", () => {
    // ~26k tokens > 0.75 * 32768: one big user message (chars/4 heuristic).
    const big = "x".repeat(105_000);
    const { userId, convId } = seed([big]);
    const usage = conversationContextUsage({
      slots: thread(convId),
      ownerId: userId,
      conversationId: convId,
      model: "qwen-chat",
      compactedThroughMessageId: null,
    });
    expect(usage.shouldPrompt).toBe(true);
    expect(usage.showMeter).toBe(true);
    expect(usage.ratio).toBeGreaterThanOrEqual(0.75);
  });
});

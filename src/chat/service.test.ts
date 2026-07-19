import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { AuthContext } from "../auth/middleware.ts";
import { setProviderKey } from "../byok/service.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { conversations, messages, providerKeys, usageEvents, users } from "../db/schema.ts";
import { allowedModels, callerLimits } from "./service.ts";
import { acquireSlot, assertBudget, assertModelAllowed, branchConversation, ChatError, compactionStartIndex, history, releaseSlot, thread } from "./service.ts";

const admin = { role: "admin", via: "owner", user: {}, key: null } as unknown as AuthContext;

// An email-login account user: role="account" (tierOf → "guest" entitlement tier), key=null.
// Its limits come from the guardrails SNAPSHOTTED onto the user row at invite redemption
// (modelAllowlist / tokenBudget / maxConcurrency) — never the admin pool. assertBudget reads
// usage_events by user id, so back the fixture with a real user row.
function makeAccount(snap: Partial<{ modelAllowlist: string[] | null; tokenBudget: number | null; maxConcurrency: number | null }> = {}): AuthContext {
  const u = db
    .insert(users)
    .values({
      login: `acct-${Math.random()}`,
      role: "account",
      modelAllowlist: snap.modelAllowlist === undefined ? null : snap.modelAllowlist ? JSON.stringify(snap.modelAllowlist) : null,
      tokenBudget: snap.tokenBudget === undefined ? null : snap.tokenBudget,
      maxConcurrency: snap.maxConcurrency === undefined ? null : snap.maxConcurrency,
    })
    .returning()
    .get();
  return { role: "account", via: "session", user: u, key: null, accessGranted: true } as unknown as AuthContext;
}

afterEach(() => {
  db.delete(providerKeys).run();
  db.delete(usageEvents).run();
  db.delete(messages).run();
  db.delete(conversations).run();
  db.delete(users).run();
});

describe("acquireSlot / releaseSlot", () => {
  test("caps concurrency at max, frees on release", () => {
    const id = `t-${Math.random()}`;
    expect(acquireSlot(id, 1)).toBe(true); // first in
    expect(acquireSlot(id, 1)).toBe(false); // at cap
    releaseSlot(id);
    expect(acquireSlot(id, 1)).toBe(true); // freed
    releaseSlot(id);
  });
});

describe("assertModelAllowed", () => {
  test("admin may use any model", () => {
    expect(() => assertModelAllowed(admin, "anything")).not.toThrow();
  });
  test("account allowed within its snapshotted allowlist, 403 otherwise", () => {
    const acct = makeAccount({ modelAllowlist: ["qwen-chat"] });
    expect(() => assertModelAllowed(acct, "qwen-chat")).not.toThrow();
    try {
      assertModelAllowed(acct, "qwen-code");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ChatError);
      expect((e as ChatError).status).toBe(403);
    }
  });

  // #185: a picked BYOK model isn't in the local allowlist — it's admitted on the SAME fail-closed
  // rule the runner spends on (byok-entitled + a stored key), so the picker never surfaces a dead 403.
  test("account may use a BYOK model it can actually spend (entitled + stored key)", () => {
    const acct = makeAccount({ modelAllowlist: ["qwen-chat"] }); // default plan ultra → BYOK-entitled
    setProviderKey(acct.user.id, "openai", "sk-live-abcd");
    expect(() => assertModelAllowed(acct, "openai/gpt-4o")).not.toThrow();
  });

  test("account is still 403'd for a BYOK model with NO stored key for that provider", () => {
    const acct = makeAccount({ modelAllowlist: ["qwen-chat"] });
    setProviderKey(acct.user.id, "openai", "sk-live-abcd");
    try {
      assertModelAllowed(acct, "anthropic/claude-3.5"); // no anthropic key
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ChatError);
      expect((e as ChatError).status).toBe(403);
    }
  });
});

describe("assertBudget", () => {
  test("admin is unmetered", () => {
    expect(() => assertBudget(admin)).not.toThrow();
  });
  test("account under its snapshotted budget passes; exhausted → 402", () => {
    const acct = makeAccount({ tokenBudget: 1000 });
    expect(() => assertBudget(acct)).not.toThrow(); // no usage yet
    db.insert(usageEvents).values({ userId: acct.user.id, tokensIn: 10, tokensOut: 0 }).run();
    expect(() => assertBudget(acct)).not.toThrow(); // 10 < 1000
    db.insert(usageEvents).values({ userId: acct.user.id, tokensIn: 990, tokensOut: 0 }).run();
    try {
      assertBudget(acct); // 1000 >= 1000
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ChatError);
      expect((e as ChatError).status).toBe(402);
    }
  });
  test("a null/zero snapshotted budget falls back to the freeTier budget", () => {
    const acct = makeAccount({ tokenBudget: null });
    db.insert(usageEvents).values({ userId: acct.user.id, tokensIn: config.freeTier.tokenBudget, tokensOut: 0 }).run();
    try {
      assertBudget(acct);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ChatError).status).toBe(402);
    }
  });
});

// --- SECURITY: the account tier is bounded by its snapshot, never the admin pool ----------
describe("account user (role=account, key=null) is bounded by its snapshot, NOT admin", () => {
  test("allowedModels: a null allowlist falls back to the free-tier default model, not the live list", async () => {
    const account = makeAccount(); // null modelAllowlist → freeTier default
    // config.freeTier.models is empty in tests → falls back to [DEFAULT_MODEL].
    const models = await allowedModels(account);
    expect(models).toEqual([config.defaultModel]);
    expect(models).not.toContain("some-live-only-model");
  });

  test("allowedModels: a snapshotted allowlist is honored verbatim", async () => {
    const account = makeAccount({ modelAllowlist: ["qwen-chat", "qwen-code"] });
    expect(await allowedModels(account)).toEqual(["qwen-chat", "qwen-code"]);
  });

  test("assertModelAllowed: account may use a snapshotted model, is 403'd off the allowlist", () => {
    const account = makeAccount(); // null → freeTier default ([DEFAULT_MODEL] in tests)
    expect(() => assertModelAllowed(account, config.defaultModel)).not.toThrow();
    try {
      assertModelAllowed(account, "gpt-ultra-not-free");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ChatError);
      expect((e as ChatError).status).toBe(403);
    }
  });

  test("assertBudget: account passes under the free-tier budget fallback, 402 once usage_events exhaust it", () => {
    const account = makeAccount(); // null budget → freeTier fallback
    expect(() => assertBudget(account)).not.toThrow();
    db.insert(usageEvents).values({ userId: account.user.id, tokensIn: config.freeTier.tokenBudget - 1, tokensOut: 0 }).run();
    expect(() => assertBudget(account)).not.toThrow();
    db.insert(usageEvents).values({ userId: account.user.id, tokensIn: 5, tokensOut: 0 }).run();
    try {
      assertBudget(account);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ChatError);
      expect((e as ChatError).status).toBe(402);
    }
  });

  test("callerLimits: account gets NORMAL rate + snapshotted concurrency + keyId null (not the admin pool)", () => {
    const account = makeAccount({ maxConcurrency: 3 });
    const lim = callerLimits(account);
    expect(lim.maxPerMin).toBe(config.rateLimitPerMin); // NOT 6x
    expect(lim.maxConcurrency).toBe(3); // the snapshotted value
    expect(lim.keyId).toBeNull(); // no key
    expect(lim.limitId).toBe(account.user.id); // bucketed by the user
  });

  test("callerLimits: a null snapshotted concurrency falls back to the freeTier default", () => {
    const account = makeAccount({ maxConcurrency: null });
    const lim = callerLimits(account);
    expect(lim.maxConcurrency).toBe(config.freeTier.maxConcurrency);
  });

  // FIX 3 (defense-in-depth): a 0/negative snapshotted concurrency must NOT disable the cap
  // (acquireSlot with max<1 would admit unbounded in-flight generations). Floor it at 1.
  test("callerLimits: a 0/negative snapshotted concurrency is floored to 1 (cap never disabled)", () => {
    expect(callerLimits(makeAccount({ maxConcurrency: 0 })).maxConcurrency).toBe(1);
    expect(callerLimits(makeAccount({ maxConcurrency: -5 })).maxConcurrency).toBe(1);
    // And the floor actually caps in-flight: with max=1, the second acquire is rejected.
    const account = makeAccount({ maxConcurrency: 0 });
    const { maxConcurrency, limitId } = callerLimits(account);
    expect(acquireSlot(limitId, maxConcurrency)).toBe(true);
    expect(acquireSlot(limitId, maxConcurrency)).toBe(false); // floored to 1 → capped
    releaseSlot(limitId);
  });
});

describe("callerLimits: admin stays unlimited", () => {
  test("admin gets the 6x rate + the pool concurrency", () => {
    const lim = callerLimits(admin);
    expect(lim.maxPerMin).toBe(config.rateLimitPerMin * 6);
    expect(lim.maxConcurrency).toBe(4);
    expect(lim.keyId).toBeNull();
  });
});

describe("branchConversation (#72)", () => {
  // A user + a conversation with a linear exchange, oldest → newest via explicit createdAt so the
  // thread order is deterministic. Returns the ids of every persisted message in order.
  function seedConversation(fields: Partial<{ title: string; model: string }> = {}) {
    const user = db.insert(users).values({ login: `u-${Math.random()}`, role: "account" }).returning().get();
    const conv = db.insert(conversations).values({ userId: user.id, title: fields.title ?? "Main thread", model: fields.model ?? "qwen-chat" }).returning().get();
    const ids: string[] = [];
    const rows: [("user" | "assistant"), string][] = [
      ["user", "what's the capital of France?"],
      ["assistant", "Paris."],
      ["user", "and of Spain?"],
      ["assistant", "Madrid."],
    ];
    let t = 1000;
    for (const [role, content] of rows) {
      const m = db.insert(messages).values({ conversationId: conv.id, userId: user.id, role, content, model: "qwen-chat", createdAt: new Date((t += 1000)) }).returning().get();
      ids.push(m.id);
    }
    return { user, conv, ids };
  }

  test("forks at an assistant message: copies the active thread up to and including it into a new owned conversation", () => {
    const { user, conv, ids } = seedConversation({ title: "Geography", model: "qwen-code" });
    // Fork at the FIRST assistant answer (ids[1]) — carry the first exchange only.
    const branched = branchConversation(user.id, conv.id, ids[1]!);
    expect(branched).not.toBeNull();
    expect(branched!.id).not.toBe(conv.id);
    expect(branched!.userId).toBe(user.id);
    expect(branched!.title).toBe("Geography"); // inherits the source title
    expect(branched!.model).toBe("qwen-code"); // inherits the source model

    const copied = thread(branched!.id).map((s) => [s.active.role, s.active.content]);
    expect(copied).toEqual([
      ["user", "what's the capital of France?"],
      ["assistant", "Paris."],
    ]);
    // Every copied row is owned by the caller (the new owner), fresh (no variants), vote reset.
    for (const s of thread(branched!.id)) {
      expect(s.active.userId).toBe(user.id);
      expect(s.active.variantOf).toBeNull();
      expect(s.active.vote).toBe(0);
    }
    // The source conversation is untouched — still four messages.
    expect(thread(conv.id)).toHaveLength(4);
  });

  test("forks at a user message: carries context up to and including that question", () => {
    const { user, conv, ids } = seedConversation();
    const branched = branchConversation(user.id, conv.id, ids[2]!); // the second user turn
    const copied = thread(branched!.id).map((s) => s.active.content);
    expect(copied).toEqual(["what's the capital of France?", "Paris.", "and of Spain?"]);
  });

  test("forks at the very first message: copies just that one", () => {
    const { user, conv, ids } = seedConversation();
    const branched = branchConversation(user.id, conv.id, ids[0]!);
    expect(thread(branched!.id).map((s) => s.active.content)).toEqual(["what's the capital of France?"]);
  });

  test("copies the ACTIVE regenerated variant (not siblings), and only one message per slot", () => {
    const { user, conv, ids } = seedConversation();
    // Regenerate the first assistant answer (ids[1]): add a sibling variant that becomes active.
    db.update(messages).set({ variantActive: false }).where(eq(messages.id, ids[1]!)).run();
    db.insert(messages)
      .values({ conversationId: conv.id, userId: user.id, role: "assistant", content: "Paris, France.", model: "qwen-chat", variantOf: ids[1]!, variantActive: true, createdAt: new Date(2500) })
      .run();
    // Fork at the (now-regenerated) first exchange by the original root id — resolves to the slot.
    const branched = branchConversation(user.id, conv.id, ids[1]!);
    const copied = thread(branched!.id).map((s) => s.active.content);
    // The ACTIVE variant's text is carried; the slot copies exactly ONE message (no sibling).
    expect(copied).toEqual(["what's the capital of France?", "Paris, France."]);
  });

  test("branched messages carry strictly-increasing, distinct timestamps even when source slots collide", () => {
    const user = db.insert(users).values({ login: `u-${Math.random()}`, role: "account" }).returning().get();
    const conv = db.insert(conversations).values({ userId: user.id }).returning().get();
    // Two roots sharing the SAME createdAt ms — the tie that would make thread() ordering unstable.
    db.insert(messages).values({ conversationId: conv.id, userId: user.id, role: "user", content: "first", createdAt: new Date(5000) }).run();
    db.insert(messages).values({ conversationId: conv.id, userId: user.id, role: "assistant", content: "second", createdAt: new Date(5000) }).run();
    // Fork at the LAST slot's active id so both colliding messages are copied.
    const sourceSlots = thread(conv.id);
    const branched = branchConversation(user.id, conv.id, sourceSlots[sourceSlots.length - 1]!.active.id);
    const branchedSlots = thread(branched!.id);
    const times = branchedSlots.map((s) => s.active.createdAt.getTime());
    expect(times[0]!).toBeLessThan(times[1]!); // strictly increasing → deterministic order, no tie
    // Both messages are carried (source order under the tie is itself ambiguous, so assert as a set).
    expect(branchedSlots.map((s) => s.active.content).sort()).toEqual(["first", "second"]);
  });

  test("returns null when the source isn't the caller's conversation (no cross-account fork)", () => {
    const { conv, ids } = seedConversation();
    const stranger = db.insert(users).values({ login: `s-${Math.random()}`, role: "account" }).returning().get();
    expect(branchConversation(stranger.id, conv.id, ids[1]!)).toBeNull();
    // Nothing was created for the stranger.
    expect(db.select().from(conversations).where(eq(conversations.userId, stranger.id)).all()).toHaveLength(0);
  });

  test("returns null for an unknown conversation id", () => {
    const { user } = seedConversation();
    expect(branchConversation(user.id, "does-not-exist", "whatever")).toBeNull();
  });

  test("returns null when the fork-point message isn't in the conversation", () => {
    const { user, conv } = seedConversation();
    const other = seedConversation();
    // A real message id, but from a DIFFERENT conversation — not a valid fork point here.
    expect(branchConversation(user.id, conv.id, other.ids[0]!)).toBeNull();
  });
});

describe("compaction boundary in history (#38)", () => {
  // Seed a linear thread of `n` messages (user/assistant alternating) with strictly increasing
  // timestamps, returning their ids in order.
  function seedThread(n: number): { userId: string; convId: string; ids: string[] } {
    const userId = db.insert(users).values({ login: `u-${Math.random()}`, role: "account" }).returning().get().id;
    const convId = db.insert(conversations).values({ userId }).returning().get().id;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = db
        .insert(messages)
        .values({ conversationId: convId, userId, role: i % 2 === 0 ? "user" : "assistant", content: `m${i}`, createdAt: new Date(1000 + i) })
        .returning()
        .get().id;
      ids.push(id);
    }
    return { userId, convId, ids };
  }

  test("no boundary → full verbatim history", () => {
    const { convId } = seedThread(4);
    expect(history(convId).map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(history(convId, null).map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3"]);
  });

  test("boundary drops every turn up to and including it, keeps the rest", () => {
    const { convId, ids } = seedThread(6);
    // Fold through m2 (index 2): the prompt keeps m3, m4, m5.
    expect(history(convId, ids[2]).map((m) => m.content)).toEqual(["m3", "m4", "m5"]);
  });

  test("a stale/unknown boundary id degrades fail-safe to the full thread", () => {
    const { convId } = seedThread(4);
    expect(history(convId, "not-a-real-id").map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3"]);
  });

  test("compactionStartIndex resolves the slot after the boundary, or 0 when absent/unknown", () => {
    const { convId, ids } = seedThread(4);
    const slots = thread(convId);
    expect(compactionStartIndex(slots, null)).toBe(0);
    expect(compactionStartIndex(slots, ids[1])).toBe(2); // slot AFTER the boundary
    expect(compactionStartIndex(slots, "ghost")).toBe(0);
  });
});

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { conversationRecaps, conversations, messages, summaries, users } from "../db/schema.ts";
import { backend } from "../jano/client.ts";
import {
  dismissRecap,
  generateRecap,
  getCachedRecap,
  parseRecap,
  RECAP_MIN_MESSAGES,
  RECAP_STALE_MS,
  type Recap,
  recapEligible,
  resolveRecap,
  resolveRecapForced,
  storeRecap,
} from "./recap.ts";

// Archivist recap (#37). The pure gate + parser + cache are exercised directly; generateRecap /
// resolveRecap hit the jano backend, which we STUB (never the network) to cover the parse →
// cache → serve path and every silent-degrade branch.

function makeUser(): string {
  return db.insert(users).values({ login: `u-${Math.random()}`, role: "account" }).returning().get().id;
}
function makeConversation(userId: string): string {
  return db.insert(conversations).values({ userId, title: "C" }).returning().get().id;
}
// Seed `n` alternating messages, the last one `ageMs` old (so eligibility can be steered).
function seedThread(userId: string, conversationId: string, n: number, ageMs = RECAP_STALE_MS + 1_000): string {
  let lastId = "";
  const base = Date.now() - ageMs;
  for (let i = 0; i < n; i++) {
    lastId = db
      .insert(messages)
      .values({
        conversationId,
        userId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
        // Spread timestamps so the newest is exactly `ageMs` old (the eligibility clock).
        createdAt: new Date(base + i * 1_000 - (n - 1) * 1_000),
      })
      .returning()
      .get().id;
  }
  return lastId;
}

const VALID: Recap = {
  topic: "Planning a trip to Lisbon",
  progress: ["Chose dates in May", "Shortlisted three neighborhoods"],
  whereItEnded: "Comparing hotels in Alfama",
  nextStep: "Pick one hotel and check availability",
};

afterEach(() => {
  db.delete(conversationRecaps).run();
  db.delete(messages).run();
  db.delete(summaries).run();
  db.delete(conversations).run();
  db.delete(users).run();
});

describe("recapEligible", () => {
  test("true when stale AND at/above the message floor", () => {
    expect(recapEligible(RECAP_MIN_MESSAGES, Date.now() - RECAP_STALE_MS - 1)).toBe(true);
  });
  test("false when too few messages, even if stale", () => {
    expect(recapEligible(RECAP_MIN_MESSAGES - 1, Date.now() - RECAP_STALE_MS - 1)).toBe(false);
  });
  test("false when recent, even with enough messages", () => {
    expect(recapEligible(RECAP_MIN_MESSAGES + 5, Date.now() - 1_000)).toBe(false);
  });
  test("boundary: exactly 24h old + exactly the floor is eligible", () => {
    const now = 10_000_000_000_000;
    expect(recapEligible(RECAP_MIN_MESSAGES, now - RECAP_STALE_MS, now)).toBe(true);
  });
});

describe("parseRecap", () => {
  test("parses a well-formed object (prose around the JSON is tolerated)", () => {
    const raw = `Sure! Here it is:\n${JSON.stringify(VALID)}\nHope that helps.`;
    expect(parseRecap(raw)).toEqual(VALID);
  });
  test("drops a blank nextStep to undefined", () => {
    const raw = JSON.stringify({ ...VALID, nextStep: "  " });
    const parsed = parseRecap(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.nextStep).toBeUndefined();
  });
  test("filters blank/non-string progress entries and caps at 6", () => {
    const raw = JSON.stringify({
      ...VALID,
      progress: ["a", "  ", 3, "b", "c", "d", "e", "f", "g"],
    });
    expect(parseRecap(raw)!.progress).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
  test("null when there is no JSON object at all", () => {
    expect(parseRecap("I can't help with that.")).toBeNull();
  });
  test("null on invalid JSON inside braces", () => {
    expect(parseRecap("{ not: valid, json }")).toBeNull();
  });
  test("null when topic / whereItEnded / progress are missing (malformed → no card)", () => {
    expect(parseRecap(JSON.stringify({ topic: "t", whereItEnded: "e", progress: [] }))).toBeNull();
    expect(parseRecap(JSON.stringify({ topic: "", whereItEnded: "e", progress: ["p"] }))).toBeNull();
    expect(parseRecap(JSON.stringify({ topic: "t", whereItEnded: "", progress: ["p"] }))).toBeNull();
  });
});

describe("generateRecap (jano stubbed)", () => {
  const realComplete = backend.complete.bind(backend);
  afterEach(() => {
    backend.complete = realComplete;
  });
  function stub(fn: () => Promise<string>): void {
    backend.complete = fn as typeof backend.complete;
  }

  test("returns a parsed recap from the model output", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4);
    stub(async () => JSON.stringify(VALID));
    expect(await generateRecap(c, u)).toEqual(VALID);
  });

  test("feeds the rolling summary into the prompt when present", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4);
    db.insert(summaries).values({ userId: u, scope: "conversation", conversationId: c, content: "the running gist" }).run();
    let seen = "";
    backend.complete = (async (req: { messages: { content: string }[] }) => {
      seen = req.messages[0]!.content;
      return JSON.stringify(VALID);
    }) as typeof backend.complete;
    await generateRecap(c, u);
    expect(seen).toContain("the running gist");
  });

  test("no messages → null without calling the backend", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    let called = false;
    stub(async () => {
      called = true;
      return JSON.stringify(VALID);
    });
    expect(await generateRecap(c, u)).toBeNull();
    expect(called).toBe(false);
  });

  test("backend throwing degrades to null", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4);
    stub(async () => {
      throw new Error("jano down");
    });
    expect(await generateRecap(c, u)).toBeNull();
  });

  test("malformed model output degrades to null", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4);
    stub(async () => "sorry, no");
    expect(await generateRecap(c, u)).toBeNull();
  });
});

describe("recap cache", () => {
  test("store then get by the same last-message id returns the recap (not dismissed)", () => {
    const c = makeConversation(makeUser());
    storeRecap(c, "msg-1", VALID);
    expect(getCachedRecap(c, "msg-1")).toEqual({ recap: VALID, dismissed: false });
  });

  test("a moved last-message id is a cache miss (stale → regenerate)", () => {
    const c = makeConversation(makeUser());
    storeRecap(c, "msg-1", VALID);
    expect(getCachedRecap(c, "msg-2")).toBeNull();
  });

  test("re-storing keeps one row per conversation and resets dismissed", () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4); // gives dismissRecap a real last message to target
    const lastId = db.select({ id: messages.id }).from(messages).orderBy(messages.createdAt).all().at(-1)!.id;
    storeRecap(c, lastId, VALID);
    expect(dismissRecap(c)).toBe(true);
    expect(getCachedRecap(c, lastId)!.dismissed).toBe(true);
    // A fresh recap for the same key clears the dismissal.
    storeRecap(c, lastId, VALID);
    expect(getCachedRecap(c, lastId)!.dismissed).toBe(false);
    expect(db.select().from(conversationRecaps).where(eq(conversationRecaps.conversationId, c)).all()).toHaveLength(1);
  });

  test("dismiss only marks the row when the last-message id still matches", () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4);
    const lastId = db.select({ id: messages.id }).from(messages).orderBy(messages.createdAt).all().at(-1)!.id;
    // Cache was built for an OLD last message; the thread has since moved on.
    storeRecap(c, "an-older-message", VALID);
    expect(dismissRecap(c)).toBe(false);
    expect(getCachedRecap(c, "an-older-message")!.dismissed).toBe(false);
    // Now cache the current last message → dismiss lands.
    storeRecap(c, lastId, VALID);
    expect(dismissRecap(c)).toBe(true);
  });

  test("dismiss on a conversation with no messages is a no-op false", () => {
    const c = makeConversation(makeUser());
    expect(dismissRecap(c)).toBe(false);
  });
});

describe("resolveRecap (jano stubbed)", () => {
  const realComplete = backend.complete.bind(backend);
  afterEach(() => {
    backend.complete = realComplete;
  });
  function stub(fn: () => Promise<string>): void {
    backend.complete = fn as typeof backend.complete;
  }

  test("null for a fresh conversation (not stale) - backend never called", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 6, 1_000); // recent
    let called = false;
    stub(async () => {
      called = true;
      return JSON.stringify(VALID);
    });
    expect(await resolveRecap(c, u)).toBeNull();
    expect(called).toBe(false);
  });

  test("null for a short conversation (under the message floor)", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, RECAP_MIN_MESSAGES - 1); // stale but too short
    let called = false;
    stub(async () => {
      called = true;
      return JSON.stringify(VALID);
    });
    expect(await resolveRecap(c, u)).toBeNull();
    expect(called).toBe(false);
  });

  test("generates + caches once, then serves the cache without re-spending", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4);
    let calls = 0;
    stub(async () => {
      calls++;
      return JSON.stringify(VALID);
    });
    expect(await resolveRecap(c, u)).toEqual(VALID);
    expect(await resolveRecap(c, u)).toEqual(VALID);
    expect(calls).toBe(1); // second open hit the cache
  });

  test("a dismissed recap resolves to null until new activity", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4);
    stub(async () => JSON.stringify(VALID));
    await resolveRecap(c, u); // generate + cache
    dismissRecap(c);
    expect(await resolveRecap(c, u)).toBeNull();

    // New activity moves the last-message id → the cache is stale → a fresh recap shows again.
    db.insert(messages).values({ conversationId: c, userId: u, role: "user", content: "back again", createdAt: new Date(Date.now() - RECAP_STALE_MS - 1) }).run();
    expect(await resolveRecap(c, u)).toEqual(VALID);
  });

  test("model failure degrades to null and caches nothing", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4);
    stub(async () => {
      throw new Error("jano down");
    });
    expect(await resolveRecap(c, u)).toBeNull();
    expect(db.select().from(conversationRecaps).where(eq(conversationRecaps.conversationId, c)).all()).toHaveLength(0);
  });
});

describe("resolveRecapForced (jano stubbed) - the /recap command force path (#37)", () => {
  const realComplete = backend.complete.bind(backend);
  afterEach(() => {
    backend.complete = realComplete;
  });
  function stub(fn: () => Promise<string>): void {
    backend.complete = fn as typeof backend.complete;
  }

  test("recaps a SUBSTANTIAL but FRESH thread that the staleness gate rejects", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4, 1_000); // 4 messages, just now (recent) - resolveRecap would return null
    let calls = 0;
    stub(async () => {
      calls++;
      return JSON.stringify(VALID);
    });
    // The default gate rejects it...
    expect(await resolveRecap(c, u)).toBeNull();
    // ...but the force path bypasses ONLY staleness and derives from the tail.
    expect(await resolveRecapForced(c, u)).toEqual(VALID);
    expect(calls).toBe(1);
  });

  test("returns null for a too-thin thread (under the content floor) without calling Jano", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, RECAP_MIN_MESSAGES - 1, 1_000); // fresh AND too short
    let called = false;
    stub(async () => {
      called = true;
      return JSON.stringify(VALID);
    });
    expect(await resolveRecapForced(c, u)).toBeNull();
    expect(called).toBe(false);
  });

  test("empty conversation → null without calling Jano", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    let called = false;
    stub(async () => {
      called = true;
      return JSON.stringify(VALID);
    });
    expect(await resolveRecapForced(c, u)).toBeNull();
    expect(called).toBe(false);
  });

  test("generates + caches once, then serves the cache on repeat /recap (no re-spend)", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4, 1_000);
    let calls = 0;
    stub(async () => {
      calls++;
      return JSON.stringify(VALID);
    });
    expect(await resolveRecapForced(c, u)).toEqual(VALID);
    expect(await resolveRecapForced(c, u)).toEqual(VALID);
    expect(calls).toBe(1); // the second /recap hit the cache
  });

  test("ignores a prior dismissal - an explicit /recap re-shows the cached recap", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4, 1_000);
    stub(async () => JSON.stringify(VALID));
    await resolveRecapForced(c, u); // generate + cache
    dismissRecap(c); // a dismissal that would hide the AUTO recap
    // The command still surfaces it (deliberate ask), unlike resolveRecap.
    expect(await resolveRecapForced(c, u)).toEqual(VALID);
  });

  test("model failure degrades to null and caches nothing", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    seedThread(u, c, 4, 1_000);
    stub(async () => {
      throw new Error("jano down");
    });
    expect(await resolveRecapForced(c, u)).toBeNull();
    expect(db.select().from(conversationRecaps).where(eq(conversationRecaps.conversationId, c)).all()).toHaveLength(0);
  });
});

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { conversations, facts, memoryChunks, messages, summaries, users } from "../db/schema.ts";
import { backend } from "../jano/client.ts";
import type { ChatMessage } from "../jano/types.ts";
import {
  buildSystemPrompt,
  conversationSummary,
  ephemeralSystemPrompt,
  forgetAllMemory,
  forgetFact,
  listFacts,
  memoryEnabledFor,
  summarizeForCompaction,
  updateMemory,
  upsertConversationSummary,
  userFacts,
  votedExamples,
  withRegenerateSteering,
} from "./service.ts";

// Pure READ-path memory helpers + prompt builders. The LLM-calling updateMemory is NOT
// exercised here (it hits the jano backend); these cover everything that reads/derives
// from the DB and shapes the system prompt.

function makeUser(): string {
  return db.insert(users).values({ login: `u-${Math.random()}`, role: "guest" }).returning().get().id;
}
function makeConversation(userId: string): string {
  return db.insert(conversations).values({ userId, title: "C" }).returning().get().id;
}
function addAssistant(userId: string, conversationId: string, content: string, vote: number, createdAt?: Date): void {
  db.insert(messages)
    .values({ conversationId, userId, role: "assistant", content, vote, ...(createdAt ? { createdAt } : {}) })
    .run();
}

describe("userFacts", () => {
  test("empty when the user has no facts", () => {
    expect(userFacts(makeUser())).toEqual([]);
  });

  test("returns fact contents, most-recently-updated first", () => {
    const u = makeUser();
    db.insert(facts).values({ userId: u, content: "old", updatedAt: new Date(1000) }).run();
    db.insert(facts).values({ userId: u, content: "new", updatedAt: new Date(2000) }).run();
    expect(userFacts(u)).toEqual(["new", "old"]);
  });

  test("respects the limit", () => {
    const u = makeUser();
    for (let i = 0; i < 5; i++) db.insert(facts).values({ userId: u, content: `f${i}` }).run();
    expect(userFacts(u, 2).length).toBe(2);
  });

  test("is scoped to the user", () => {
    const a = makeUser();
    const b = makeUser();
    db.insert(facts).values({ userId: a, content: "a-fact" }).run();
    expect(userFacts(b)).toEqual([]);
  });
});

describe("conversationSummary", () => {
  test("null when none exists", () => {
    const u = makeUser();
    expect(conversationSummary(u, makeConversation(u))).toBeNull();
  });

  test("returns the conversation-scoped summary content", () => {
    const u = makeUser();
    const c = makeConversation(u);
    db.insert(summaries).values({ userId: u, scope: "conversation", conversationId: c, content: "the gist" }).run();
    expect(conversationSummary(u, c)).toBe("the gist");
  });

  test("ignores a user-scoped summary (wrong scope)", () => {
    const u = makeUser();
    const c = makeConversation(u);
    db.insert(summaries).values({ userId: u, scope: "user", conversationId: c, content: "user-level" }).run();
    expect(conversationSummary(u, c)).toBeNull();
  });

  test("ignores another conversation's summary", () => {
    const u = makeUser();
    const c1 = makeConversation(u);
    const c2 = makeConversation(u);
    db.insert(summaries).values({ userId: u, scope: "conversation", conversationId: c2, content: "other" }).run();
    expect(conversationSummary(u, c1)).toBeNull();
  });
});

describe("votedExamples", () => {
  test("empty when no votes", () => {
    expect(votedExamples(makeUser())).toEqual({ liked: [], disliked: [] });
  });

  test("splits liked/disliked, collapses whitespace, truncates to 200 chars", () => {
    const u = makeUser();
    const c = makeConversation(u);
    addAssistant(u, c, "  good\n  reply  ", 1);
    addAssistant(u, c, "x".repeat(300), -1);
    const { liked, disliked } = votedExamples(u);
    expect(liked).toEqual(["good reply"]); // whitespace collapsed + trimmed
    expect(disliked[0]?.length).toBe(200); // sliced
  });

  test("ignores unvoted (vote 0) replies and non-assistant roles", () => {
    const u = makeUser();
    const c = makeConversation(u);
    addAssistant(u, c, "neutral", 0);
    db.insert(messages).values({ conversationId: c, userId: u, role: "user", content: "user upvote?", vote: 1 }).run();
    expect(votedExamples(u)).toEqual({ liked: [], disliked: [] });
  });

  test("respects the per-bucket limit and stops once both buckets fill", () => {
    const u = makeUser();
    const c = makeConversation(u);
    // 4 liked + 4 disliked; default limit is 3 per bucket.
    for (let i = 0; i < 4; i++) addAssistant(u, c, `like ${i}`, 1, new Date(1000 + i));
    for (let i = 0; i < 4; i++) addAssistant(u, c, `dislike ${i}`, -1, new Date(2000 + i));
    const { liked, disliked } = votedExamples(u);
    expect(liked.length).toBe(3);
    expect(disliked.length).toBe(3);
  });

  test("custom limit is honored", () => {
    const u = makeUser();
    const c = makeConversation(u);
    for (let i = 0; i < 3; i++) addAssistant(u, c, `like ${i}`, 1);
    expect(votedExamples(u, 1).liked.length).toBe(1);
  });

  test("skips a reply that collapses to empty (whitespace-only content)", () => {
    const u = makeUser();
    const c = makeConversation(u);
    addAssistant(u, c, "   \n  ", 1);
    expect(votedExamples(u).liked).toEqual([]);
  });
});

describe("buildSystemPrompt", () => {
  test("baseline persona line with no memory / no conversation", () => {
    const u = makeUser();
    const msg = buildSystemPrompt(u, null, "Leo");
    expect(msg.role).toBe("system");
    expect(msg.content).toContain("You are a7t.chat");
    expect(msg.content).toContain("Be proactive");
    expect(msg.content).not.toContain("What you remember about");
    expect(msg.content).not.toContain("Conversation so far");
    expect(msg.content).not.toContain("Relevant context from earlier");
  });

  test("injects facts under the user's display login", () => {
    const u = makeUser();
    db.insert(facts).values({ userId: u, content: "likes maps" }).run();
    const msg = buildSystemPrompt(u, null, "Leo");
    expect(msg.content).toContain("What you remember about Leo:");
    expect(msg.content).toContain("- likes maps");
  });

  test("injects the conversation summary when a conversationId is given", () => {
    const u = makeUser();
    const c = makeConversation(u);
    db.insert(summaries).values({ userId: u, scope: "conversation", conversationId: c, content: "planning a trip" }).run();
    const msg = buildSystemPrompt(u, c, "Leo");
    expect(msg.content).toContain("Conversation so far: planning a trip");
  });

  test("does NOT look up a summary when conversationId is null", () => {
    const u = makeUser();
    const msg = buildSystemPrompt(u, null, "Leo");
    expect(msg.content).not.toContain("Conversation so far");
  });

  test("injects recalled cross-conversation context", () => {
    const u = makeUser();
    const msg = buildSystemPrompt(u, null, "Leo", ["earlier note A", "earlier note B"]);
    expect(msg.content).toContain("Relevant context from earlier conversations:");
    expect(msg.content).toContain("- earlier note A");
    expect(msg.content).toContain("- earlier note B");
  });

  test("injects liked + disliked steering examples", () => {
    const u = makeUser();
    const c = makeConversation(u);
    addAssistant(u, c, "great answer", 1);
    addAssistant(u, c, "bad answer", -1);
    const msg = buildSystemPrompt(u, c, "Leo");
    expect(msg.content).toContain("thumbs-upped replies");
    expect(msg.content).toContain("+ great answer");
    expect(msg.content).toContain("thumbs-downed replies");
    expect(msg.content).toContain("- bad answer");
  });

  test("appends enabled capability instructions (maps marker)", () => {
    const u = makeUser();
    const msg = buildSystemPrompt(u, null, "Leo");
    // The maps capability contributes a fragment; assert the prompt grew beyond the base.
    expect(msg.content.length).toBeGreaterThan(
      "You are a7t.chat, a helpful, concise assistant running locally.".length + 50,
    );
  });

  test("injects the persona fragment right after the base line (#11)", () => {
    const u = makeUser();
    const persona = "The user has personalized how you should respond to them:\n- Address the user as: Leo";
    const msg = buildSystemPrompt(u, null, "Leo", [], persona);
    expect(msg.content).toContain("Address the user as: Leo");
    // Sits between the base line and any memory context.
    const base = "You are a7t.chat, a helpful, concise assistant running locally.";
    expect(msg.content.indexOf(persona)).toBeGreaterThan(msg.content.indexOf(base));
  });

  test("a null / whitespace persona injects nothing", () => {
    const u = makeUser();
    expect(buildSystemPrompt(u, null, "Leo", [], null).content).not.toContain("personalized");
    expect(buildSystemPrompt(u, null, "Leo", [], "   ").content).not.toContain("personalized");
  });

  // Collaborative send (#46): when the prompter is NOT the owner, ownerMemory=false must
  // withhold the owner's global facts and cross-conversation voted examples — otherwise a
  // `prompt` collaborator could read the owner's private memory back out through the model.
  test("ownerMemory=false withholds owner-global facts and voted examples", () => {
    const u = makeUser();
    const c = makeConversation(u);
    db.insert(facts).values({ userId: u, content: "likes maps" }).run();
    addAssistant(u, c, "great answer", 1);
    addAssistant(u, c, "bad answer", -1);
    const msg = buildSystemPrompt(u, c, "Leo", [], null, false);
    expect(msg.content).not.toContain("What you remember about");
    expect(msg.content).not.toContain("- likes maps");
    expect(msg.content).not.toContain("thumbs-upped replies");
    expect(msg.content).not.toContain("thumbs-downed replies");
  });

  test("ownerMemory=false still injects the summary of THIS conversation", () => {
    const u = makeUser();
    const c = makeConversation(u);
    db.insert(facts).values({ userId: u, content: "likes maps" }).run();
    db.insert(summaries).values({ userId: u, scope: "conversation", conversationId: c, content: "planning a trip" }).run();
    const msg = buildSystemPrompt(u, c, "Leo", [], null, false);
    // The shared conversation's own summary is visible to the collaborator, so it stays…
    expect(msg.content).toContain("Conversation so far: planning a trip");
    // …but the owner's global facts do not.
    expect(msg.content).not.toContain("What you remember about");
  });
});

describe("withRegenerateSteering", () => {
  const base: ChatMessage = { role: "system", content: "BASE" };

  test("returns the prompt unchanged when there are no prior answers", () => {
    expect(withRegenerateSteering(base, [])).toBe(base);
  });

  test("returns unchanged when prior answers are only whitespace", () => {
    expect(withRegenerateSteering(base, ["  ", "\n"])).toBe(base);
  });

  test("folds in a single prior answer with singular phrasing", () => {
    const out = withRegenerateSteering(base, ["my old reply"]);
    expect(out.content.startsWith("BASE\n")).toBe(true);
    expect(out.content).toContain("Your previous answer to this exact prompt:");
    expect(out.content).toContain("--- previous answer 1 ---");
    expect(out.content).toContain("my old reply");
    expect(out.content).toContain("pressed retry");
  });

  test("uses plural phrasing and keeps only the last 3 answers", () => {
    const out = withRegenerateSteering(base, ["a1", "a2", "a3", "a4"]);
    expect(out.content).toContain("Your previous answers to this exact prompt:");
    expect(out.content).not.toContain("a1"); // dropped — only last 3 kept
    expect(out.content).toContain("a2");
    expect(out.content).toContain("a4");
    expect(out.content).toContain("--- previous answer 3 ---");
  });

  test("truncates an over-long prior answer to 1200 chars + ellipsis", () => {
    const long = "y".repeat(1500);
    const out = withRegenerateSteering(base, [long]);
    expect(out.content).toContain("…");
    expect(out.content).not.toContain("y".repeat(1300)); // body was cut down
  });

  test("preserves the original system role", () => {
    const out = withRegenerateSteering({ role: "system", content: "X" }, ["prior"]);
    expect(out.role).toBe("system");
  });
});

describe("ephemeralSystemPrompt", () => {
  test("ghost prompt omits memory and declares itself temporary", () => {
    const msg = ephemeralSystemPrompt();
    expect(msg.role).toBe("system");
    expect(msg.content).toContain("You are a7t.chat");
    expect(msg.content).toContain("temporary chat");
    expect(msg.content).not.toContain("What you remember");
    expect(msg.content).not.toContain("Be proactive");
    // Persona is opt-out in a ghost chat too (#11): identity-free by design.
    expect(msg.content).not.toContain("personalized");
    expect(msg.content).not.toContain("Address the user as");
  });
});

// updateMemory hits the jano backend; we STUB backend.complete (never the network) to
// cover the parse → dedup → persist path and its failure branches.
describe("updateMemory (jano stubbed)", () => {
  const realComplete = backend.complete.bind(backend);
  afterEach(() => {
    backend.complete = realComplete;
  });
  function stubComplete(raw: string | (() => Promise<string>)): void {
    backend.complete = (typeof raw === "string" ? async () => raw : raw) as typeof backend.complete;
  }
  function stubThrows(): void {
    backend.complete = (async () => {
      throw new Error("jano down");
    }) as typeof backend.complete;
  }

  function seedTurn(): { userId: string; conversationId: string } {
    const userId = makeUser();
    const conversationId = makeConversation(userId);
    db.insert(messages).values({ conversationId, userId, role: "user", content: "I live in Berlin" }).run();
    db.insert(messages).values({ conversationId, userId, role: "assistant", content: "Noted." }).run();
    return { userId, conversationId };
  }

  test("no messages → returns early (backend never called)", async () => {
    let called = false;
    stubComplete(async () => {
      called = true;
      return "{}";
    });
    const userId = makeUser();
    await updateMemory(userId, makeConversation(userId));
    expect(called).toBe(false);
  });

  test("extracts new facts + inserts a conversation summary", async () => {
    const { userId, conversationId } = seedTurn();
    stubComplete(JSON.stringify({ newFacts: ["lives in Berlin", "uses Bun"], summary: "User introduced themselves." }));
    await updateMemory(userId, conversationId);

    expect(userFacts(userId).sort()).toEqual(["lives in Berlin", "uses Bun"]);
    expect(conversationSummary(userId, conversationId)).toBe("User introduced themselves.");
  });

  test("dedups against known facts (case/punctuation-insensitive) and drops blanks", async () => {
    const { userId, conversationId } = seedTurn();
    db.insert(facts).values({ userId, content: "Lives in Berlin" }).run();
    stubComplete(JSON.stringify({ newFacts: ["lives in berlin!!", "  ", "owns a Mac"], summary: "" }));
    await updateMemory(userId, conversationId);
    // "lives in berlin!!" normalizes to the existing fact → not duplicated; blank dropped.
    const all = userFacts(userId);
    expect(all).toContain("Lives in Berlin");
    expect(all).toContain("owns a Mac");
    expect(all.length).toBe(2);
  });

  test("updates an existing conversation summary instead of inserting a second", async () => {
    const { userId, conversationId } = seedTurn();
    db.insert(summaries).values({ userId, scope: "conversation", conversationId, content: "old summary" }).run();
    stubComplete(JSON.stringify({ newFacts: [], summary: "fresh summary" }));
    await updateMemory(userId, conversationId);
    const rows = db.select().from(summaries).where(eq(summaries.conversationId, conversationId)).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.content).toBe("fresh summary");
  });

  test("empty summary string does not touch the summaries table", async () => {
    const { userId, conversationId } = seedTurn();
    stubComplete(JSON.stringify({ newFacts: ["a fact"], summary: "   " }));
    await updateMemory(userId, conversationId);
    expect(conversationSummary(userId, conversationId)).toBeNull();
  });

  test("backend throwing is swallowed (no facts/summary written)", async () => {
    const { userId, conversationId } = seedTurn();
    stubThrows();
    await updateMemory(userId, conversationId);
    expect(userFacts(userId)).toEqual([]);
    expect(conversationSummary(userId, conversationId)).toBeNull();
  });

  test("unparseable response (no JSON object) → returns without writing", async () => {
    const { userId, conversationId } = seedTurn();
    stubComplete("sorry, I can't help with that");
    await updateMemory(userId, conversationId);
    expect(userFacts(userId)).toEqual([]);
  });

  test("malformed JSON inside braces → JSON.parse throws, returns without writing", async () => {
    const { userId, conversationId } = seedTurn();
    // Has a matching {...} so the regex extracts it, but the body is invalid JSON →
    // JSON.parse throws and parseJson's catch returns null.
    stubComplete("{ not: valid, json }");
    await updateMemory(userId, conversationId);
    expect(userFacts(userId)).toEqual([]);
  });

  test("extracts the JSON object embedded in surrounding prose", async () => {
    const { userId, conversationId } = seedTurn();
    stubComplete(`Here you go:\n${JSON.stringify({ newFacts: ["likes hiking"], summary: "ok" })}\nThanks!`);
    await updateMemory(userId, conversationId);
    expect(userFacts(userId)).toContain("likes hiking");
  });

  test("non-array newFacts + non-string summary are tolerated (no writes)", async () => {
    const { userId, conversationId } = seedTurn();
    stubComplete(JSON.stringify({ newFacts: "not-an-array", summary: 42 }));
    await updateMemory(userId, conversationId);
    expect(userFacts(userId)).toEqual([]);
    expect(conversationSummary(userId, conversationId)).toBeNull();
  });

  test("filters non-string entries out of newFacts and caps at 10", async () => {
    const { userId, conversationId } = seedTurn();
    const many = Array.from({ length: 15 }, (_, i) => `fact ${i}`);
    stubComplete(JSON.stringify({ newFacts: [...many, 123, null, ""], summary: "" }));
    await updateMemory(userId, conversationId);
    expect(userFacts(userId, 100).length).toBe(10); // sliced to 10, non-strings/blank dropped
  });
});

// Archivist transparency + control (#27): the see/forget helpers + the opt-out gate. All are
// scoped strictly to the caller's own userId.
describe("listFacts", () => {
  test("empty for a user with no facts", () => {
    expect(listFacts(makeUser())).toEqual([]);
  });

  test("returns id + content + createdAt, most-recently-updated first", () => {
    const u = makeUser();
    db.insert(facts).values({ userId: u, content: "old", updatedAt: new Date(1000) }).run();
    db.insert(facts).values({ userId: u, content: "new", updatedAt: new Date(2000) }).run();
    const rows = listFacts(u);
    expect(rows.map((r) => r.content)).toEqual(["new", "old"]);
    expect(typeof rows[0]!.id).toBe("string");
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  test("is scoped to the user", () => {
    const a = makeUser();
    const b = makeUser();
    db.insert(facts).values({ userId: a, content: "a-fact" }).run();
    expect(listFacts(b)).toEqual([]);
  });
});

describe("forgetFact", () => {
  test("deletes the caller's own fact and reports success", () => {
    const u = makeUser();
    const id = db.insert(facts).values({ userId: u, content: "forget me" }).returning().get().id;
    expect(forgetFact(u, id)).toBe(true);
    expect(listFacts(u)).toEqual([]);
  });

  test("cannot delete another user's fact (returns false, leaves it intact)", () => {
    const a = makeUser();
    const b = makeUser();
    const id = db.insert(facts).values({ userId: a, content: "a's secret" }).returning().get().id;
    expect(forgetFact(b, id)).toBe(false);
    expect(listFacts(a).map((r) => r.content)).toEqual(["a's secret"]);
  });

  test("an unknown id returns false", () => {
    expect(forgetFact(makeUser(), "does-not-exist")).toBe(false);
  });
});

describe("forgetAllMemory", () => {
  test("wipes facts + summaries + memory_chunks for the user, returns facts cleared", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    db.insert(facts).values({ userId: u, content: "f1" }).run();
    db.insert(facts).values({ userId: u, content: "f2" }).run();
    db.insert(summaries).values({ userId: u, scope: "conversation", conversationId: conv, content: "s" }).run();
    db.insert(memoryChunks).values({ userId: u, content: "chunk", embeddingModel: "bge-m3" }).run();

    expect(forgetAllMemory(u)).toBe(2);
    expect(listFacts(u)).toEqual([]);
    expect(conversationSummary(u, conv)).toBeNull();
    expect(db.select().from(memoryChunks).where(eq(memoryChunks.userId, u)).all()).toEqual([]);
  });

  test("leaves another user's memory untouched", () => {
    const a = makeUser();
    const b = makeUser();
    db.insert(facts).values({ userId: a, content: "keep" }).run();
    db.insert(memoryChunks).values({ userId: a, content: "keep-chunk", embeddingModel: "bge-m3" }).run();
    expect(forgetAllMemory(b)).toBe(0);
    expect(listFacts(a).map((r) => r.content)).toEqual(["keep"]);
    expect(db.select().from(memoryChunks).where(eq(memoryChunks.userId, a)).all().length).toBe(1);
  });
});

describe("memoryEnabledFor", () => {
  test("defaults to enabled for a user with no preferences", () => {
    expect(memoryEnabledFor(makeUser())).toBe(true);
  });

  test("false when the user has switched memory off", () => {
    const u = db
      .insert(users)
      .values({ login: `u-${Math.random()}`, role: "guest", preferences: JSON.stringify({ memory: { enabled: false } }) })
      .returning()
      .get().id;
    expect(memoryEnabledFor(u)).toBe(false);
  });

  test("true when explicitly enabled, and for a corrupt preferences column", () => {
    const on = db
      .insert(users)
      .values({ login: `u-${Math.random()}`, role: "guest", preferences: JSON.stringify({ memory: { enabled: true } }) })
      .returning()
      .get().id;
    const corrupt = db
      .insert(users)
      .values({ login: `u-${Math.random()}`, role: "guest", preferences: "{not json" })
      .returning()
      .get().id;
    expect(memoryEnabledFor(on)).toBe(true);
    expect(memoryEnabledFor(corrupt)).toBe(true); // degrades to the default, never silently opts out
  });

  test("an unknown user degrades to the default (enabled)", () => {
    expect(memoryEnabledFor("nobody")).toBe(true);
  });
});

describe("upsertConversationSummary", () => {
  test("inserts then updates the SAME row (one summary per user+conversation)", () => {
    const u = makeUser();
    const c = makeConversation(u);
    upsertConversationSummary(u, c, "first");
    expect(conversationSummary(u, c)).toBe("first");
    upsertConversationSummary(u, c, "second");
    expect(conversationSummary(u, c)).toBe("second");
    const rows = db.select().from(summaries).where(eq(summaries.conversationId, c)).all();
    expect(rows.length).toBe(1); // updated in place, never duplicated
  });
});

describe("summarizeForCompaction", () => {
  const realComplete = backend.complete.bind(backend);
  afterEach(() => {
    backend.complete = realComplete;
  });
  function stubComplete(fn: (req: { messages: { content: string }[] }) => Promise<string>): void {
    backend.complete = fn as typeof backend.complete;
  }

  test("folds the transcript into the rolling summary and returns it", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    let seen = "";
    stubComplete(async (req) => {
      seen = req.messages[0]!.content;
      return '{ "summary": "folded recap of the older turns" }';
    });
    const out = await summarizeForCompaction(u, c, "user: hi\nassistant: hello");
    expect(out).toBe("folded recap of the older turns");
    // Persisted via the shared upsert (buildSystemPrompt will now inject it).
    expect(conversationSummary(u, c)).toBe("folded recap of the older turns");
    // The folded transcript reached the model prompt.
    expect(seen).toContain("user: hi");
  });

  test("feeds the CURRENT summary back in so folding is cumulative", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    upsertConversationSummary(u, c, "earlier summary text");
    let seen = "";
    stubComplete(async (req) => {
      seen = req.messages[0]!.content;
      return '{ "summary": "new" }';
    });
    await summarizeForCompaction(u, c, "assistant: more");
    expect(seen).toContain("earlier summary text");
  });

  test("returns null and writes nothing on a model failure (safe decline)", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    stubComplete(async () => {
      throw new Error("jano down");
    });
    expect(await summarizeForCompaction(u, c, "user: x")).toBeNull();
    expect(conversationSummary(u, c)).toBeNull(); // uncompacted — nothing persisted
  });

  test("returns null on malformed / empty model output", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    stubComplete(async () => "not json at all");
    expect(await summarizeForCompaction(u, c, "user: x")).toBeNull();
    stubComplete(async () => '{ "summary": "   " }');
    expect(await summarizeForCompaction(u, c, "user: x")).toBeNull();
    expect(conversationSummary(u, c)).toBeNull();
  });

  test("does NOT extract durable facts (compaction is context-window only)", async () => {
    const u = makeUser();
    const c = makeConversation(u);
    stubComplete(async () => '{ "summary": "s", "newFacts": ["should be ignored"] }');
    await summarizeForCompaction(u, c, "user: x");
    expect(userFacts(u)).toEqual([]); // the durable memory tier is untouched
  });
});

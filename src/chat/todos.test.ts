import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { conversations, messages, users } from "../db/schema.ts";
import { setTaskItem, toggleConversationTodo } from "./todos.ts";

// The task-list checkbox parser behind the shared-page TODO toggle (#45). Pure + regression-
// prone (marker variants, indexing, idempotence, no false positives), so it's exercised hard.

describe("setTaskItem", () => {
  test("ticks the Nth item, leaving the others untouched", () => {
    const md = "- [ ] eggs\n- [ ] flour";
    expect(setTaskItem(md, 1, true)).toBe("- [ ] eggs\n- [x] flour");
  });

  test("unticks an item (x -> space)", () => {
    expect(setTaskItem("- [x] eggs\n- [x] flour", 0, false)).toBe("- [ ] eggs\n- [x] flour");
  });

  test("preserves the item text and surrounding markdown verbatim", () => {
    const md = "# Recipe\n\nTo buy:\n- [ ] **eggs** (a dozen)\n- [ ] flour\n\nEnjoy.";
    expect(setTaskItem(md, 0, true)).toBe(
      "# Recipe\n\nTo buy:\n- [x] **eggs** (a dozen)\n- [ ] flour\n\nEnjoy.",
    );
  });

  test("handles indented (nested) task items", () => {
    expect(setTaskItem("- [ ] top\n  - [ ] nested", 1, true)).toBe("- [ ] top\n  - [x] nested");
  });

  test("preserves CRLF line endings", () => {
    expect(setTaskItem("- [ ] a\r\n- [ ] b", 1, true)).toBe("- [ ] a\r\n- [x] b");
  });

  test("normalizes an uppercase [X] when re-setting it", () => {
    expect(setTaskItem("- [X] done", 0, true)).toBe("- [x] done");
  });

  test("is idempotent — setting an item to its current state returns equivalent content", () => {
    const md = "- [x] eggs";
    expect(setTaskItem(md, 0, true)).toBe("- [x] eggs");
  });

  test("returns null for an out-of-range index (no write)", () => {
    expect(setTaskItem("- [ ] only one", 1, true)).toBeNull();
    expect(setTaskItem("no tasks here", 0, true)).toBeNull();
  });

  test("returns null for a negative or non-integer index", () => {
    expect(setTaskItem("- [ ] a", -1, true)).toBeNull();
    expect(setTaskItem("- [ ] a", 0.5, true)).toBeNull();
  });

  test("only the targeted checkbox changes when several share the same text", () => {
    const md = "- [ ] step\n- [ ] step\n- [ ] step";
    expect(setTaskItem(md, 2, true)).toBe("- [ ] step\n- [ ] step\n- [x] step");
  });

  test("index 0 targets the real task, not a look-alike inside a fenced code block", () => {
    // Regression for the #53 review: a fenced `- [ ]` must not consume index 0 and cause the
    // real task below to be toggled at the wrong (or an out-of-range) index. The code line stays
    // byte-for-byte untouched; only the real checkbox flips.
    const md = "```md\n- [ ] example\n```\n- [ ] real task";
    expect(setTaskItem(md, 0, true)).toBe("```md\n- [ ] example\n```\n- [x] real task");
  });

  test("ticks a blockquoted task item without disturbing the `>` prefix", () => {
    expect(setTaskItem("> - [ ] quoted", 0, true)).toBe("> - [x] quoted");
  });

  test("index 0 skips a top-level indented-code look-alike and hits the real task", () => {
    // The `    - [ ] fake` line is an indented code block (no rendered checkbox), so index 0 must
    // land on the real task below it — leaving the code line byte-for-byte untouched.
    expect(setTaskItem("    - [ ] fake\n- [ ] real", 0, true)).toBe("    - [ ] fake\n- [x] real");
  });

  test("indexes across -, *, + bullets and ordered (1. / 2)) markers in document order", () => {
    // Every GFM list-item marker opens a real checkbox, so the ordinals must run through all of
    // them uniformly; index 4 lands on the last (ordered `2)`) item.
    const md = "- [ ] a\n* [ ] b\n+ [ ] c\n1. [ ] d\n2) [ ] e";
    expect(setTaskItem(md, 4, true)).toBe("- [ ] a\n* [ ] b\n+ [ ] c\n1. [ ] d\n2) [x] e");
  });

  test("skips a look-alike inside a tilde (~~~) fence, not just a backtick fence", () => {
    // remark-gfm renders no checkbox inside a tilde fence either, so index 0 must reach the first
    // real task below it and leave the fenced line untouched.
    const md = "~~~\n- [ ] fenced\n~~~\n- [ ] a\n- [ ] b";
    expect(setTaskItem(md, 0, true)).toBe("~~~\n- [ ] fenced\n~~~\n- [x] a\n- [ ] b");
  });

  test("ticks a genuinely nested 4-space task item under an open list", () => {
    // A 4-space indent WITH a list open above is a nested sublist item (a rendered checkbox), so
    // the indented-code skip must not swallow it — index 1 targets the nested task.
    expect(setTaskItem("- [ ] top\n    - [ ] nested", 1, true)).toBe("- [ ] top\n    - [x] nested");
  });

  test("indexes a task item that follows a plain (checkbox-free) bullet in the same list", () => {
    // A bare `- intro` opens a list without being a checkbox; the first real checkbox below it is
    // index 0, so the plain bullet must not consume an ordinal.
    expect(setTaskItem("- intro\n- [ ] task", 0, true)).toBe("- intro\n- [x] task");
  });

  test("skips a bracket without whitespace-then-content after it (renders as plain text)", () => {
    // GFM requires horizontal whitespace AND content after `]`, so `- [ ]eggs`, `- [ ]`, and a
    // trailing-space-only `- [ ] ` are all plain text — not checkboxes. If the parser counted them
    // it would over-count and drift every later ordinal past what streamdown renders (#53 review).
    // Here index 0 must land on the one real task below the look-alikes.
    const md = "- [ ]eggs\n- [ ]\n- [ ] \n- [ ] real";
    expect(setTaskItem(md, 0, true)).toBe("- [ ]eggs\n- [ ]\n- [ ] \n- [x] real");
    // ...and there is exactly one checkbox, so index 1 is out of range (a true no-op).
    expect(setTaskItem(md, 1, true)).toBeNull();
  });

  test("returns null when the only bracket isn't a list-item checkbox", () => {
    // `arr[ ]` / a bare `[x]` mid-sentence have no leading bullet/number, so nothing is a task
    // item and any index is out of range (no false-positive write).
    expect(setTaskItem("call arr[ ] and check [x] inline", 0, true)).toBeNull();
  });
});

// The message-scoped DB write both the owner route and the public share path ride (#45/#131).
// Scoped to a single conversation + a single checkbox character; the caller has already been
// authorized. Uses the isolated temp DB (src/__tests__/setup.ts).
describe("toggleConversationTodo", () => {
  let seq = 0;
  function seed(content: string): { conv: string; mid: string } {
    seq++;
    const uid = db.insert(users).values({ login: `todo-${seq}-${Math.random()}`, role: "account" }).returning().get().id;
    const conv = db.insert(conversations).values({ userId: uid }).returning().get().id;
    const mid = db.insert(messages).values({ conversationId: conv, userId: uid, role: "assistant", content }).returning().get().id;
    return { conv, mid };
  }

  test("ticks the target checkbox and persists it to the message row", () => {
    const { conv, mid } = seed("- [ ] eggs\n- [ ] flour");
    const res = toggleConversationTodo(conv, mid, 1, true);
    expect(res?.content).toBe("- [ ] eggs\n- [x] flour");
    expect(db.select().from(messages).where(eq(messages.id, mid)).get()?.content).toBe("- [ ] eggs\n- [x] flour");
  });

  test("unticks (x -> space) and is idempotent (no needless write, same content)", () => {
    const { conv, mid } = seed("- [x] eggs");
    expect(toggleConversationTodo(conv, mid, 0, false)?.content).toBe("- [ ] eggs");
    // Setting it to the state it's already in returns equivalent content without corruption.
    expect(toggleConversationTodo(conv, mid, 0, false)?.content).toBe("- [ ] eggs");
  });

  test("rejects a message that belongs to a DIFFERENT conversation (null, no write)", () => {
    const a = seed("- [ ] one");
    const b = seed("- [ ] two");
    // b's message id under a's conversation id must not resolve — scoping guard.
    expect(toggleConversationTodo(a.conv, b.mid, 0, true)).toBeNull();
    expect(db.select().from(messages).where(eq(messages.id, b.mid)).get()?.content).toBe("- [ ] two");
  });

  test("rejects an unknown message id (null)", () => {
    const { conv } = seed("- [ ] x");
    expect(toggleConversationTodo(conv, "does-not-exist", 0, true)).toBeNull();
  });

  test("rejects an out-of-range index (null, no write)", () => {
    const { conv, mid } = seed("- [ ] only one");
    expect(toggleConversationTodo(conv, mid, 5, true)).toBeNull();
    expect(db.select().from(messages).where(eq(messages.id, mid)).get()?.content).toBe("- [ ] only one");
  });
});

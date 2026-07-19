import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { conversations, messages, shares, users } from "../db/schema.ts";
import {
  createShare,
  deleteShare,
  generateSlug,
  getShareBySlug,
  getShareForConversation,
  shareUrl,
  toggleSharedTodo,
} from "./shares.ts";

// The shareable-live-collab data layer: slug generation, find-or-create, owner-scoping, and
// revoke-by-delete. Uses the isolated temp DB (setup.ts).

function makeUser(): string {
  return db.insert(users).values({ login: `u-${Math.random()}`, role: "account" }).returning().get().id;
}
function makeConversation(userId: string): string {
  return db.insert(conversations).values({ userId }).returning().get().id;
}
function makeMessage(userId: string, conversationId: string, content: string): string {
  return db
    .insert(messages)
    .values({ conversationId, userId, role: "assistant", content })
    .returning()
    .get().id;
}

describe("generateSlug", () => {
  test("is url-safe and unguessable (distinct, no padding/special chars)", () => {
    const a = generateSlug();
    const b = generateSlug();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet only
    expect(a.length).toBeGreaterThanOrEqual(20); // 16 bytes → ~22 chars
  });
});

describe("shareUrl", () => {
  test("builds an /s/<slug> link off APP_URL with no double slash", () => {
    expect(shareUrl("abc")).toBe(`${config.appUrl.replace(/\/+$/, "")}/s/abc`);
    expect(shareUrl("abc").includes("//s/")).toBe(false);
  });
});

describe("createShare", () => {
  test("mints a share for the owner's conversation", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    const s = createShare(u, conv);
    expect(s).not.toBeNull();
    expect(s!.conversationId).toBe(conv);
    expect(s!.userId).toBe(u);
    expect(s!.slug.length).toBeGreaterThan(0);
  });

  test("is idempotent — re-sharing returns the SAME stable slug (one share per conversation)", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    const first = createShare(u, conv);
    const second = createShare(u, conv);
    expect(first!.slug).toBe(second!.slug);
    expect(db.select().from(shares).where(eq(shares.conversationId, conv)).all()).toHaveLength(1);
  });

  test("refuses a conversation the caller does not own (no cross-user share)", () => {
    const owner = makeUser();
    const other = makeUser();
    const conv = makeConversation(owner);
    expect(createShare(other, conv)).toBeNull();
    expect(db.select().from(shares).where(eq(shares.conversationId, conv)).all()).toHaveLength(0);
  });

  test("refuses an unknown conversation", () => {
    const u = makeUser();
    expect(createShare(u, "does-not-exist")).toBeNull();
  });

  test("survives a unique-constraint race without throwing (defensive)", () => {
    // Simulate the TOCTOU window: a row already occupies the unique(conversationId) slot
    // (attributed to a different user, so the owner's scoped find misses it). createShare's
    // insert hits the constraint; it must recover gracefully (no 500), not throw.
    const owner = makeUser();
    const ghost = makeUser();
    const conv = makeConversation(owner);
    db.insert(shares).values({ conversationId: conv, userId: ghost, slug: generateSlug() }).run();
    expect(() => createShare(owner, conv)).not.toThrow();
  });
});

describe("getShareForConversation / getShareBySlug", () => {
  test("owner reads their share; a different user does not", () => {
    const u = makeUser();
    const other = makeUser();
    const conv = makeConversation(u);
    const s = createShare(u, conv)!;
    expect(getShareForConversation(u, conv)?.slug).toBe(s.slug);
    expect(getShareForConversation(other, conv)).toBeNull();
  });

  test("getShareBySlug resolves a live slug and returns null for an unknown one", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    const s = createShare(u, conv)!;
    expect(getShareBySlug(s.slug)?.conversationId).toBe(conv);
    expect(getShareBySlug("nope")).toBeNull();
  });
});

describe("deleteShare", () => {
  test("unsharing deletes the row so the old slug dies (404 territory)", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    const s = createShare(u, conv)!;
    expect(deleteShare(u, conv)).toBe(true);
    expect(getShareBySlug(s.slug)).toBeNull();
    expect(getShareForConversation(u, conv)).toBeNull();
  });

  test("re-sharing after an unshare mints a FRESH slug (old link stays dead)", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    const first = createShare(u, conv)!;
    deleteShare(u, conv);
    const second = createShare(u, conv)!;
    expect(second.slug).not.toBe(first.slug);
    expect(getShareBySlug(first.slug)).toBeNull();
  });

  test("is a no-op (false) when nothing is shared or the caller isn't the owner", () => {
    const u = makeUser();
    const other = makeUser();
    const conv = makeConversation(u);
    expect(deleteShare(u, conv)).toBe(false); // never shared
    createShare(u, conv);
    expect(deleteShare(other, conv)).toBe(false); // not the owner → untouched
    expect(getShareForConversation(u, conv)).not.toBeNull();
  });

  test("deleting the conversation cascades the share away", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    const s = createShare(u, conv)!;
    db.delete(conversations).where(eq(conversations.id, conv)).run();
    expect(getShareBySlug(s.slug)).toBeNull();
  });
});

describe("toggleSharedTodo", () => {
  test("ticks a checkbox and persists it to the message content", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    const mid = makeMessage(u, conv, "To buy:\n- [ ] eggs\n- [ ] flour");
    const res = toggleSharedTodo(conv, mid, 0, true);
    expect(res?.content).toBe("To buy:\n- [x] eggs\n- [ ] flour");
    // Persisted, so the next reader (owner or watcher) sees the completion.
    const stored = db.select({ content: messages.content }).from(messages).where(eq(messages.id, mid)).get();
    expect(stored?.content).toBe("To buy:\n- [x] eggs\n- [ ] flour");
  });

  test("unticks a checkbox", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    const mid = makeMessage(u, conv, "- [x] eggs");
    expect(toggleSharedTodo(conv, mid, 0, false)?.content).toBe("- [ ] eggs");
  });

  test("refuses a message that belongs to a DIFFERENT conversation (cross-share guard)", () => {
    const u = makeUser();
    const convA = makeConversation(u);
    const convB = makeConversation(u);
    const midB = makeMessage(u, convB, "- [ ] secret");
    // A write token scoped to convA must not reach convB's message.
    expect(toggleSharedTodo(convA, midB, 0, true)).toBeNull();
    // convB's content is untouched.
    const stored = db.select({ content: messages.content }).from(messages).where(eq(messages.id, midB)).get();
    expect(stored?.content).toBe("- [ ] secret");
  });

  test("returns null for an unknown message id", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    expect(toggleSharedTodo(conv, "does-not-exist", 0, true)).toBeNull();
  });

  test("returns null (no write) for an out-of-range item index", () => {
    const u = makeUser();
    const conv = makeConversation(u);
    const mid = makeMessage(u, conv, "- [ ] only one");
    expect(toggleSharedTodo(conv, mid, 5, true)).toBeNull();
    const stored = db.select({ content: messages.content }).from(messages).where(eq(messages.id, mid)).get();
    expect(stored?.content).toBe("- [ ] only one"); // unchanged
  });
});

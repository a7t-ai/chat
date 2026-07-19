import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { HANDLE_MAX, HANDLE_MIN, handleAvailable, setHandle, validateHandle } from "./handle.ts";

// Seed an account row and return its id.
function makeUser(handle: string | null = null): string {
  const u = db
    .insert(users)
    .values({ login: `acct_${crypto.randomUUID()}`, role: "account", handle })
    .returning()
    .get();
  return u.id;
}

afterEach(() => {
  db.delete(users).run();
});

describe("validateHandle — pure charset/length gate", () => {
  test("accepts a well-formed handle unchanged", () => {
    expect(validateHandle("leo_42")).toEqual({ ok: true, handle: "leo_42" });
    expect(validateHandle("abc")).toEqual({ ok: true, handle: "abc" }); // exactly the min
  });

  test("lowercases first — uppercase input claims the lowercase handle (not a charset error)", () => {
    expect(validateHandle("Leo")).toEqual({ ok: true, handle: "leo" });
    expect(validateHandle("MixedCASE_9")).toEqual({ ok: true, handle: "mixedcase_9" });
  });

  test("trims surrounding whitespace before validating", () => {
    expect(validateHandle("  leo  ")).toEqual({ ok: true, handle: "leo" });
  });

  test("rejects the charset: spaces, dots, dashes, unicode, symbols", () => {
    for (const bad of ["leo bob", "leo.bob", "leo-bob", "léo", "leo!", "a b", "hi@there"]) {
      expect(validateHandle(bad)).toEqual({ ok: false, error: "charset" });
    }
  });

  test("rejects too short / too long / empty (length before charset)", () => {
    expect(validateHandle("ab")).toEqual({ ok: false, error: "length" }); // 2 < min
    expect(validateHandle("")).toEqual({ ok: false, error: "length" });
    expect(validateHandle("   ")).toEqual({ ok: false, error: "length" }); // trims to empty
    expect(validateHandle("a".repeat(HANDLE_MAX + 1))).toEqual({ ok: false, error: "length" });
    // An over-length string that ALSO has bad chars is a length error (length is checked first).
    expect(validateHandle("!".repeat(HANDLE_MAX + 1))).toEqual({ ok: false, error: "length" });
  });

  test("accepts exactly the min and max lengths", () => {
    expect(validateHandle("a".repeat(HANDLE_MIN))).toEqual({ ok: true, handle: "a".repeat(HANDLE_MIN) });
    expect(validateHandle("a".repeat(HANDLE_MAX))).toEqual({ ok: true, handle: "a".repeat(HANDLE_MAX) });
  });

  test("non-string input degrades to a length error, never throws", () => {
    expect(validateHandle(undefined)).toEqual({ ok: false, error: "length" });
    expect(validateHandle(null)).toEqual({ ok: false, error: "length" });
    expect(validateHandle(42)).toEqual({ ok: false, error: "length" });
    expect(validateHandle({})).toEqual({ ok: false, error: "length" });
  });
});

describe("handleAvailable — case-insensitive, self-excluding", () => {
  test("a free handle is available", () => {
    const me = makeUser();
    expect(handleAvailable("leo", me)).toBe(true);
  });

  test("another account's handle is taken, case-insensitively", () => {
    makeUser("leo");
    const me = makeUser();
    expect(handleAvailable("leo", me)).toBe(false);
    // The comparison is on lower(handle); the argument is already normalized lowercase.
    expect(handleAvailable("leo", me)).toBe(false);
  });

  test("a user may keep their OWN handle (not a collision with themselves)", () => {
    const me = makeUser("leo");
    expect(handleAvailable("leo", me)).toBe(true);
  });
});

describe("setHandle — validate + uniqueness + caller-scoped write", () => {
  test("sets a valid handle and persists the lowercased value", () => {
    const me = makeUser();
    expect(setHandle(me, "Leo_42")).toEqual({ ok: true, handle: "leo_42" });
    expect(db.select().from(users).where(eq(users.id, me)).get()?.handle).toBe("leo_42");
  });

  test("charset / length failures never touch the DB", () => {
    const me = makeUser();
    expect(setHandle(me, "leo bob")).toEqual({ ok: false, error: "charset" });
    expect(setHandle(me, "ab")).toEqual({ ok: false, error: "length" });
    expect(db.select().from(users).where(eq(users.id, me)).get()?.handle).toBeNull();
  });

  test("a collision with another account returns `taken` (case-insensitive)", () => {
    makeUser("leo");
    const me = makeUser();
    expect(setHandle(me, "LEO")).toEqual({ ok: false, error: "taken" });
    expect(db.select().from(users).where(eq(users.id, me)).get()?.handle).toBeNull();
  });

  test("re-saving your OWN handle is allowed (idempotent), including a case-only change", () => {
    const me = makeUser("leo");
    expect(setHandle(me, "leo")).toEqual({ ok: true, handle: "leo" });
    expect(setHandle(me, "LEO")).toEqual({ ok: true, handle: "leo" });
    expect(db.select().from(users).where(eq(users.id, me)).get()?.handle).toBe("leo");
  });

  test("changing to a new, free handle works", () => {
    const me = makeUser("leo");
    expect(setHandle(me, "leo2")).toEqual({ ok: true, handle: "leo2" });
    expect(db.select().from(users).where(eq(users.id, me)).get()?.handle).toBe("leo2");
  });

  test("is scoped to the caller — only the caller's row changes", () => {
    const other = makeUser("someoneelse");
    const me = makeUser();
    setHandle(me, "mine");
    expect(db.select().from(users).where(eq(users.id, other)).get()?.handle).toBe("someoneelse");
    expect(db.select().from(users).where(eq(users.id, me)).get()?.handle).toBe("mine");
  });

  test("no reservation: any account may claim any valid, free handle (owner is designated at sign-up, not by handle)", () => {
    // The owner model (#191) no longer reserves a special handle — a handle is purely public identity
    // (#189), so `taken` (uniqueness) is the ONLY conflict outcome.
    const me = makeUser();
    expect(setHandle(me, "leo")).toEqual({ ok: true, handle: "leo" });
    expect(db.select().from(users).where(eq(users.id, me)).get()?.handle).toBe("leo");
  });
});

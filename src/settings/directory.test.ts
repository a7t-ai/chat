import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import {
  DIRECTORY_LIMIT,
  DIRECTORY_QUERY_MAX,
  directoryName,
  directoryQuery,
  listDirectory,
} from "./directory.ts";

// Seed a user row and return its id. Defaults to a synthetic acct_<uuid> login (a passkey account)
// so tests can prove the login never leaks into a directory row.
function makeUser(over: { handle?: string | null; displayName?: string | null; login?: string; email?: string | null } = {}): string {
  const u = db
    .insert(users)
    .values({
      login: over.login ?? `acct_${crypto.randomUUID()}`,
      role: "account",
      handle: over.handle ?? null,
      displayName: over.displayName ?? null,
      email: over.email ?? null,
    })
    .returning()
    .get();
  return u.id;
}

afterEach(() => {
  db.delete(users).run();
});

describe("directoryName — pure public-name precedence (never leaks email/login)", () => {
  test("prefers a set display name over the handle", () => {
    expect(directoryName({ handle: "leo_42", displayName: "Leo Cardoso" })).toBe("Leo Cardoso");
  });

  test("falls back to the handle when no display name is set", () => {
    expect(directoryName({ handle: "leo_42", displayName: null })).toBe("leo_42");
    expect(directoryName({ handle: "leo_42", displayName: "   " })).toBe("leo_42"); // whitespace-only
  });

  test("trims a display name", () => {
    expect(directoryName({ handle: "leo_42", displayName: "  Leo  " })).toBe("Leo");
  });

  // The row projection never even carries email/login, but the helper is pointedly incapable of
  // surfacing them: with neither a display name nor a handle it returns an empty string, NEVER an
  // acct_<uuid> slug or an address.
  test("never falls through to a login/email — empty when both name and handle are absent", () => {
    expect(directoryName({ handle: null, displayName: null })).toBe("");
  });
});

describe("directoryQuery — bounded, lowercased, wildcard-escaped needle", () => {
  test("empty / whitespace-only / non-string degrades to null (no filter)", () => {
    expect(directoryQuery("")).toBeNull();
    expect(directoryQuery("   ")).toBeNull();
    expect(directoryQuery(undefined)).toBeNull();
    expect(directoryQuery(null)).toBeNull();
    expect(directoryQuery(42)).toBeNull();
  });

  test("trims + lowercases", () => {
    expect(directoryQuery("  Leo  ")).toBe("leo");
  });

  test("escapes LIKE wildcards + the escape char so they match literally", () => {
    expect(directoryQuery("a_b")).toBe("a\\_b");
    expect(directoryQuery("50%")).toBe("50\\%");
    expect(directoryQuery("a\\b")).toBe("a\\\\b");
  });

  test("clamps to DIRECTORY_QUERY_MAX", () => {
    const long = "a".repeat(DIRECTORY_QUERY_MAX + 20);
    expect(directoryQuery(long)).toBe("a".repeat(DIRECTORY_QUERY_MAX));
  });
});

describe("listDirectory — scoped, bounded, public-fields-only", () => {
  test("lists only handle-set accounts, excluding the caller", () => {
    const me = makeUser({ handle: "me_self" });
    makeUser({ handle: "alice" });
    makeUser({ handle: "bob" });
    makeUser({ handle: null }); // handle-less → never surfaced (no raw uuid)

    const rows = listDirectory(me);
    const handles = rows.map((r) => r.handle);
    expect(handles).toEqual(["alice", "bob"]); // ordered by lower(handle), caller excluded
    expect(handles).not.toContain("me_self");
  });

  test("a handle-less account is never surfaced (no anonymous enumeration)", () => {
    const me = makeUser({ handle: "me" });
    makeUser({ handle: null, displayName: "No Handle" });
    expect(listDirectory(me)).toEqual([]);
  });

  test("each row carries ONLY id + handle + public name — no email/login/plan/private fields", () => {
    const me = makeUser({ handle: "me" });
    makeUser({ handle: "alice", displayName: "Alice A", login: "acct_secret-login", email: "alice@secret.test" });

    const rows = listDirectory(me);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Exact key set — nothing extra can ride along.
    expect(Object.keys(row).sort()).toEqual(["handle", "id", "name"]);
    expect(row.handle).toBe("alice");
    expect(row.name).toBe("Alice A");
    expect(typeof row.id).toBe("string");
    // Belt-and-suspenders: the serialized row contains none of the private values.
    const json = JSON.stringify(row);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("@secret.test");
    expect(json).not.toContain("acct_");
  });

  test("the public name uses the display-name precedence (display name, else handle)", () => {
    const me = makeUser({ handle: "me" });
    makeUser({ handle: "named", displayName: "Real Name" });
    makeUser({ handle: "bare", displayName: null });

    const byHandle = Object.fromEntries(listDirectory(me).map((r) => [r.handle, r.name]));
    expect(byHandle.named).toBe("Real Name");
    expect(byHandle.bare).toBe("bare");
  });

  test("search matches the handle OR the display name, case-insensitively", () => {
    const me = makeUser({ handle: "me" });
    makeUser({ handle: "leo_dev", displayName: null });
    makeUser({ handle: "someone", displayName: "Leonardo" });
    makeUser({ handle: "unrelated", displayName: "Nobody" });

    const byHandle = listDirectory(me, "LEO").map((r) => r.handle).sort();
    expect(byHandle).toEqual(["leo_dev", "someone"]); // handle hit + display-name hit
  });

  test("an empty/whitespace query returns everyone (no filter)", () => {
    const me = makeUser({ handle: "me" });
    makeUser({ handle: "alice" });
    makeUser({ handle: "bob" });
    expect(listDirectory(me, "   ").map((r) => r.handle)).toEqual(["alice", "bob"]);
  });

  test("wildcard chars in the query are literal, not SQL wildcards", () => {
    const me = makeUser({ handle: "me" });
    makeUser({ handle: "a_b" });
    makeUser({ handle: "axb" });
    // "_" is a SQL single-char wildcard; escaped it must match only the literal underscore handle.
    expect(listDirectory(me, "a_b").map((r) => r.handle)).toEqual(["a_b"]);
  });

  test("caps results at DIRECTORY_LIMIT and never exceeds it even with a larger requested limit", () => {
    const me = makeUser({ handle: "me" });
    for (let i = 0; i < DIRECTORY_LIMIT + 10; i++) {
      makeUser({ handle: `user_${String(i).padStart(3, "0")}` });
    }
    expect(listDirectory(me).length).toBe(DIRECTORY_LIMIT);
    expect(listDirectory(me, undefined, DIRECTORY_LIMIT + 100).length).toBe(DIRECTORY_LIMIT);
  });

  test("respects a smaller explicit limit", () => {
    const me = makeUser({ handle: "me" });
    makeUser({ handle: "alice" });
    makeUser({ handle: "bob" });
    makeUser({ handle: "carol" });
    expect(listDirectory(me, undefined, 2).length).toBe(2);
  });
});

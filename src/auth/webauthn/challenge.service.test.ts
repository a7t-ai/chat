import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../../db/index.ts";
import { users, webauthnChallenges } from "../../db/schema.ts";
import { CHALLENGE_TTL_MS, consumeChallenge, createChallenge, PASSKEY_RATE_LIMIT_PER_MIN, pruneExpiredChallenges } from "./challenge.service.ts";

afterEach(() => {
  db.delete(webauthnChallenges).run();
  db.delete(users).run();
});

function makeUser(): string {
  const row = db.insert(users).values({ login: `u-${Math.random().toString(36).slice(2)}`, role: "account" }).returning().get();
  return row!.id;
}

describe("createChallenge / consumeChallenge", () => {
  test("mints a base64url challenge and persists a row", () => {
    const r = createChallenge({ purpose: "authenticate" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const rows = db.select().from(webauthnChallenges).all();
    expect(rows.length).toBe(1);
  });

  test("register challenge carries the bound userId", () => {
    const userId = makeUser();
    const r = createChallenge({ purpose: "register", userId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = consumeChallenge({ challenge: r.challenge, purpose: "register" });
    expect(row?.userId).toBe(userId);
  });

  test("consume is single-use — the second attempt is null", () => {
    const r = createChallenge({ purpose: "authenticate" });
    if (!r.ok) throw new Error("expected ok");
    expect(consumeChallenge({ challenge: r.challenge, purpose: "authenticate" })).not.toBeNull();
    expect(consumeChallenge({ challenge: r.challenge, purpose: "authenticate" })).toBeNull();
  });

  test("consume rejects (but still burns) a purpose mismatch", () => {
    const r = createChallenge({ purpose: "authenticate" });
    if (!r.ok) throw new Error("expected ok");
    expect(consumeChallenge({ challenge: r.challenge, purpose: "register" })).toBeNull();
    // Burned even on mismatch — a subsequent correct-purpose consume also fails.
    expect(consumeChallenge({ challenge: r.challenge, purpose: "authenticate" })).toBeNull();
  });

  test("consume rejects an unknown challenge", () => {
    expect(consumeChallenge({ challenge: "nope", purpose: "authenticate" })).toBeNull();
  });

  test("consume rejects an expired challenge", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const r = createChallenge({ purpose: "authenticate", now: t0 });
    if (!r.ok) throw new Error("expected ok");
    const later = new Date(t0.getTime() + CHALLENGE_TTL_MS + 1);
    expect(consumeChallenge({ challenge: r.challenge, purpose: "authenticate", now: later })).toBeNull();
  });
});

describe("pruneExpiredChallenges", () => {
  test("removes only expired rows", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    // Insert directly so createChallenge's own internal prune doesn't pre-empt this.
    db.insert(webauthnChallenges).values({ challenge: "old", purpose: "authenticate", expiresAt: t0, createdAt: t0 }).run();
    db.insert(webauthnChallenges)
      .values({ challenge: "fresh", purpose: "authenticate", expiresAt: new Date(t0.getTime() + 10 * CHALLENGE_TTL_MS), createdAt: t0 })
      .run();
    const at = new Date(t0.getTime() + 1); // "old" is now expired; "fresh" is not
    expect(pruneExpiredChallenges(at)).toBe(1);
    const rows = db.select().from(webauthnChallenges).all();
    expect(rows.map((r) => r.challenge)).toEqual(["fresh"]);
  });
});

describe("per-IP rate limit", () => {
  test("blocks once the per-minute cap is reached for a non-local IP", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    for (let i = 0; i < PASSKEY_RATE_LIMIT_PER_MIN; i++) {
      expect(createChallenge({ purpose: "authenticate", ip: "203.0.113.9", now }).ok).toBe(true);
    }
    const blocked = createChallenge({ purpose: "authenticate", ip: "203.0.113.9", now });
    expect(blocked).toEqual({ ok: false, errorCode: "RATE_LIMIT" });
  });

  test("loopback IPs are exempt from the cap", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    for (let i = 0; i < PASSKEY_RATE_LIMIT_PER_MIN + 5; i++) {
      expect(createChallenge({ purpose: "authenticate", ip: "127.0.0.1", now }).ok).toBe(true);
    }
  });

  test("a different IP has its own bucket", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    for (let i = 0; i < PASSKEY_RATE_LIMIT_PER_MIN; i++) createChallenge({ purpose: "authenticate", ip: "203.0.113.1", now });
    expect(createChallenge({ purpose: "authenticate", ip: "203.0.113.2", now }).ok).toBe(true);
  });
});

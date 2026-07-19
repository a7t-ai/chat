import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import { hashToken } from "./tokens.ts";
import { createSession, destroySession, rotateSession, SESSION_TTL_DAYS, validateSession } from "./session.service.ts";

let n = 0;
function makeUser(): string {
  const u = db.insert(users).values({ login: `sess-user-${process.pid}-${n++}`, role: "guest" }).returning().get();
  return u!.id;
}

const t0 = new Date("2026-06-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const plus = (ms: number) => new Date(t0.getTime() + ms);

afterEach(() => {
  db.delete(sessions).run();
});

describe("createSession", () => {
  test("returns a prefixed plaintext token + TTL expiry; stores only the hash", () => {
    const userId = makeUser();
    const { token, expiresAt } = createSession({ userId, ip: "10.0.0.1", userAgent: "ua", now: t0 });
    expect(token.startsWith("sess_")).toBe(true);
    expect(expiresAt.getTime()).toBe(plus(SESSION_TTL_DAYS * DAY).getTime());

    const row = db.select().from(sessions).all()[0]!;
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.userId).toBe(userId);
    expect(JSON.stringify(row)).not.toContain(token);
  });
});

describe("validateSession", () => {
  test("returns the userId for a live session and bumps lastSeen", () => {
    const userId = makeUser();
    const { token } = createSession({ userId, now: t0 });
    const later = plus(DAY);
    expect(validateSession(token, later)).toBe(userId);

    const row = db.select().from(sessions).all()[0]!;
    expect(row.lastSeenAt!.getTime()).toBe(later.getTime());
  });

  test("returns null + deletes an expired session", () => {
    const userId = makeUser();
    const { token } = createSession({ userId, now: t0 });
    const expired = plus((SESSION_TTL_DAYS + 1) * DAY);
    expect(validateSession(token, expired)).toBeNull();
    expect(db.select().from(sessions).all().length).toBe(0); // lazily GC'd
  });

  test("returns null for an unknown token", () => {
    expect(validateSession("sess_nope", t0)).toBeNull();
  });
});

describe("rotateSession", () => {
  test("issues a fresh token, invalidates the old one, keeps the user", () => {
    const userId = makeUser();
    const { token: oldToken } = createSession({ userId, ip: "10.0.0.2", userAgent: "ua", now: t0 });
    const rotated = rotateSession(oldToken, plus(DAY));
    expect(rotated).not.toBeNull();
    if (!rotated) return;
    expect(rotated.token).not.toBe(oldToken);
    expect(rotated.token.startsWith("sess_")).toBe(true);

    // Old token no longer validates; new one does, for the same user.
    expect(validateSession(oldToken, plus(2 * DAY))).toBeNull();
    expect(validateSession(rotated.token, plus(2 * DAY))).toBe(userId);
    // Exactly one live session remains.
    expect(db.select().from(sessions).all().length).toBe(1);
  });

  test("returns null when rotating an expired session (and GCs it)", () => {
    const userId = makeUser();
    const { token } = createSession({ userId, now: t0 });
    const res = rotateSession(token, plus((SESSION_TTL_DAYS + 1) * DAY));
    expect(res).toBeNull();
    expect(db.select().from(sessions).all().length).toBe(0);
  });

  test("returns null for an unknown token", () => {
    expect(rotateSession("sess_nope", t0)).toBeNull();
  });
});

describe("destroySession", () => {
  test("removes a session and reports true; idempotent afterward", () => {
    const userId = makeUser();
    const { token } = createSession({ userId, now: t0 });
    expect(destroySession(token)).toBe(true);
    expect(validateSession(token, plus(DAY))).toBeNull();
    // Second destroy is a no-op.
    expect(destroySession(token)).toBe(false);
  });

  test("destroying an unknown token returns false", () => {
    expect(destroySession("sess_nope")).toBe(false);
  });
});

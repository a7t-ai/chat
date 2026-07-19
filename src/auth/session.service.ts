import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { hashToken } from "./tokens.ts";

// Web sessions. The cookie holds an opaque, CSPRNG-generated token; we store ONLY its
// SHA-256 hash (same model as sessions/passkeys). Expiry is enforced on every validate, and
// rotation issues a fresh token while invalidating the old one (defense against fixation
// + cookie theft). All time is injectable so tests don't sleep.

// Session lifetime + a defensive user-agent storage cap. These lived in the (now-removed) email
// OTP config, but sessions + passkey sign-in still need them, so they own them here. Env-tunable.
const intEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];
  const n = raw === undefined ? fallback : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const SESSION_TTL_DAYS = intEnv("SESSION_TTL_DAYS", 30);
export const MAX_USER_AGENT_LENGTH = intEnv("MAX_USER_AGENT_LENGTH", 512);

const SESSION_PREFIX = "sess_";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreateSessionInput {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}

// Returns the plaintext session token ONCE (for the httpOnly cookie); only its hash is
// stored.
export function createSession(input: CreateSessionInput): { token: string; expiresAt: Date } {
  const now = input.now ?? new Date();
  const token = SESSION_PREFIX + randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * DAY_MS);
  const userAgent = input.userAgent ? input.userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null;

  db.insert(sessions)
    .values({
      userId: input.userId,
      tokenHash,
      expiresAt,
      lastSeenAt: now,
      ip: input.ip ?? null,
      userAgent,
      createdAt: now,
    })
    .run();

  return { token, expiresAt };
}

// Returns the owning userId for a live session, or null. Expired sessions are deleted on
// sight (lazy GC) and treated as invalid. On success, lastSeenAt is bumped.
export function validateSession(token: string, now: Date = new Date()): string | null {
  const tokenHash = hashToken(token);
  const row = db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get();
  if (!row) return null;

  if (row.expiresAt.getTime() <= now.getTime()) {
    db.delete(sessions).where(eq(sessions.id, row.id)).run();
    return null;
  }

  db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.id)).run();
  return row.userId;
}

// Rotate: validate the old token, then issue a brand-new session for the same user and
// destroy the old one. Returns the new token, or null if the old session was invalid.
// Carries forward ip/userAgent from the old row.
export function rotateSession(
  token: string,
  now: Date = new Date(),
): { token: string; expiresAt: Date } | null {
  const tokenHash = hashToken(token);
  const row = db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get();
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    db.delete(sessions).where(eq(sessions.id, row.id)).run();
    return null;
  }

  const fresh = createSession({ userId: row.userId, ip: row.ip, userAgent: row.userAgent, now });
  db.delete(sessions).where(eq(sessions.id, row.id)).run();
  return fresh;
}

// Destroy a single session (logout). Idempotent: destroying an unknown/already-gone token
// is a no-op. Returns whether a row was removed.
export function destroySession(token: string): boolean {
  const tokenHash = hashToken(token);
  const removed = db
    .delete(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .returning({ id: sessions.id })
    .all();
  return removed.length > 0;
}

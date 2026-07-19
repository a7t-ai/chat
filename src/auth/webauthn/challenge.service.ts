import { randomBytes } from "node:crypto";
import { and, count, eq, gte, lte } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { webauthnChallenges } from "../../db/schema.ts";
import type { WebauthnChallenge } from "../../db/schema.ts";

// Short-lived, SINGLE-USE WebAuthn ceremony challenges (#20). The random challenge is the replay
// defense — the authenticator signs it, and we consume the row the first time it's presented, so an
// assertion can never be replayed (critical for platform passkeys whose sign counter stays 0). Time
// is injectable everywhere so tests drive expiry deterministically.

export const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes — a ceremony completes in seconds
const CHALLENGE_BYTES = 32; // 256-bit nonce

// Per-IP cap on ceremony STARTS in a rolling minute. Bounds challenge-table growth and brute
// enumeration; loopback is exempt (local/test traffic, mirroring the OTP limiter). Env-overridable.
const rawLimit = Number.parseInt(process.env.PASSKEY_RATE_LIMIT_PER_MIN ?? "", 10);
export const PASSKEY_RATE_LIMIT_PER_MIN = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 30;

type Purpose = WebauthnChallenge["purpose"];

// Only the exact loopback literals are exempt; a missing/unknown IP is treated as non-local (subject
// to the cap) so a blank IP can never become a bypass. Mirrors the OTP service's isLocalIp.
function isLocalIp(ip: string | null | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1";
}

// Delete every expired challenge. Called on each create so the table self-prunes; returns the count.
export function pruneExpiredChallenges(now: Date = new Date()): number {
  const removed = db
    .delete(webauthnChallenges)
    .where(lte(webauthnChallenges.expiresAt, now))
    .returning({ id: webauthnChallenges.id })
    .all();
  return removed.length;
}

export interface CreateChallengeInput {
  purpose: Purpose;
  userId?: string | null; // set for register (bound to the account); null for authenticate
  ip?: string | null;
  now?: Date;
}

export type CreateChallengeResult = { ok: true; challenge: string } | { ok: false; errorCode: "RATE_LIMIT" };

export function createChallenge(input: CreateChallengeInput): CreateChallengeResult {
  const now = input.now ?? new Date();
  pruneExpiredChallenges(now);

  if (!isLocalIp(input.ip)) {
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const row = db
      .select({ c: count() })
      .from(webauthnChallenges)
      .where(and(eq(webauthnChallenges.ip, input.ip!), gte(webauthnChallenges.createdAt, oneMinuteAgo)))
      .get();
    if ((row?.c ?? 0) >= PASSKEY_RATE_LIMIT_PER_MIN) return { ok: false, errorCode: "RATE_LIMIT" };
  }

  const challenge = randomBytes(CHALLENGE_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  db.insert(webauthnChallenges)
    .values({ challenge, purpose: input.purpose, userId: input.userId ?? null, ip: input.ip ?? null, expiresAt, createdAt: now })
    .run();
  return { ok: true, challenge };
}

// Consume a challenge: look it up, DELETE it unconditionally (single use — even a purpose/expiry
// mismatch burns it, so it can't be retried), and return the row only when it matches the expected
// purpose and hasn't expired. Returns null otherwise (unknown / already-used / wrong-purpose /
// expired) — the caller treats all of these as a generic rejection.
export function consumeChallenge(input: { challenge: string; purpose: Purpose; now?: Date }): WebauthnChallenge | null {
  const now = input.now ?? new Date();
  const row = db.select().from(webauthnChallenges).where(eq(webauthnChallenges.challenge, input.challenge)).get();
  if (!row) return null;
  db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, row.id)).run();
  if (row.purpose !== input.purpose) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

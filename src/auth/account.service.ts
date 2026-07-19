import { eq, sql } from "drizzle-orm";
import { accountTokensUsed } from "../chat/service.ts";
import { db } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import { type AccountPlanId, accountPlanOf } from "../entitlements/plans.ts";

// Passkey-account management — the minimal admin surface left after email OTP + invites + per-account
// guardrail settings were removed (#169). Two operations: list every passkey account with its plan +
// live usage, and revoke one (clear access + kick out every session). Admin-only at the route layer.
//
// SECURITY: nothing here can set a role or touch an admin — revoke only ever matches role='account'.

export interface AccountListing {
  id: string;
  email: string | null; // legacy — null for a passkey account
  login: string;
  accessGrantedAt: Date | null;
  plan: AccountPlanId; // subscription plan (#13); validated (unknown → ultra on the OSS build)
  createdAt: Date;
  usageTokens: number; // tokens spent (the live usage meter)
  lastSeenAt: Date | null; // most recent session.lastSeenAt across the user's sessions
}

// List every account user (role='account') with its plan + live usage. lastSeenAt is the max
// lastSeenAt over the user's sessions (a presence signal). Never selects a token hash / secret.
export function listAccounts(): AccountListing[] {
  const rows = db
    .select({
      id: users.id,
      email: users.email,
      login: users.login,
      accessGrantedAt: users.accessGrantedAt,
      plan: users.plan,
      usageResetAt: users.usageResetAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.role, "account"))
    .all();

  // Per-user lastSeen = max(sessions.lastSeenAt). Grouped query so one round-trip covers all
  // accounts (a session row's lastSeenAt is a timestamp_ms int; max() returns the latest).
  const lastSeenRows = db
    .select({
      userId: sessions.userId,
      lastSeenAt: sql<number | null>`max(${sessions.lastSeenAt})`,
    })
    .from(sessions)
    .groupBy(sessions.userId)
    .all();
  const lastSeenByUser = new Map<string, number | null>();
  for (const r of lastSeenRows) lastSeenByUser.set(r.userId, r.lastSeenAt);

  return rows.map((u) => {
    const lastSeenMs = lastSeenByUser.get(u.id) ?? null;
    return {
      id: u.id,
      email: u.email,
      login: u.login,
      accessGrantedAt: u.accessGrantedAt,
      plan: accountPlanOf(u),
      createdAt: u.createdAt,
      usageTokens: accountTokensUsed(u.id, u.usageResetAt),
      lastSeenAt: lastSeenMs == null ? null : new Date(lastSeenMs),
    };
  });
}

export type RevokeResult = { ok: true } | { ok: false; reason: "not_found" };

// Revoke an account's access AND immediately kick it out. In ONE transaction:
//   1. accessGrantedAt = null  → the auth gate keys off accessGrantedAt, so the account hits the
//      inactive wall on its next call.
//   2. delete ALL of the user's sessions → every live cookie is invalidated NOW (no waiting for a
//      session to expire). The account's passkeys remain, but with access cleared and no self-service
//      grant path, it stays walled until the owner re-grants (recovery is owner-only, #169).
// Atomic so a crash can't clear the flag without killing the sessions (or vice versa). Only targets
// role='account' rows (revoking an admin is a no-op → not_found), so this can never strip the owner.
// Idempotent: an unknown/non-account id is not_found.
export function revokeAccount(id: string): RevokeResult {
  return db.transaction((tx) => {
    const cleared = tx
      .update(users)
      .set({ accessGrantedAt: null })
      .where(sql`${users.id} = ${id} AND ${users.role} = 'account'`)
      .returning({ id: users.id })
      .all();
    if (cleared.length === 0) return { ok: false, reason: "not_found" as const };
    tx.delete(sessions).where(eq(sessions.userId, id)).run();
    return { ok: true as const };
  });
}

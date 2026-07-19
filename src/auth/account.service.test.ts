import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { sessions, usageEvents, users } from "../db/schema.ts";
import { listAccounts, revokeAccount } from "./account.service.ts";

// Unit tests for the passkey-account management service (#169: invites + per-account guardrail
// settings were removed, leaving list + revoke). Each test seeds its own user(s); shared tables are
// cleared afterEach so usage sums + listings stay deterministic.

afterEach(() => {
  db.delete(usageEvents).run();
  db.delete(sessions).run();
  db.delete(users).run();
});

function makeAccount(
  snap: Partial<{ email: string | null; accessGrantedAt: Date | null; usageResetAt: Date | null }> = {},
) {
  return db
    .insert(users)
    .values({
      login: `acct-${Math.random()}`,
      email: snap.email === undefined ? null : snap.email, // passkey accounts carry no email
      role: "account",
      accessGrantedAt: snap.accessGrantedAt === undefined ? new Date() : snap.accessGrantedAt,
      usageResetAt: snap.usageResetAt === undefined ? null : snap.usageResetAt,
    })
    .returning()
    .get()!;
}

// ---- listAccounts ----------------------------------------------------------------------
describe("listAccounts", () => {
  test("returns only account users, with plan + usage, and no secrets/guardrail fields", () => {
    db.insert(users).values({ login: `admin-${Math.random()}`, role: "admin" }).run();
    const acct = makeAccount({ email: "a@b.com" });

    const list = listAccounts();
    expect(list.map((a) => a.id)).toContain(acct.id);
    const row = list.find((a) => a.id === acct.id)!;
    expect(row.email).toBe("a@b.com");
    expect(row.plan).toBe("ultra"); // OSS default (#166)
    // No token-hash / secret fields, and no removed guardrail settings, leak.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain("modelAllowlist");
    expect(serialized).not.toContain("maxConcurrency");
  });

  test("usageTokens is summed ONLY since a legacy usageResetAt", () => {
    const resetAt = new Date(Date.now() - 60_000); // 1 min ago
    const acct = makeAccount({ usageResetAt: resetAt });
    db.insert(usageEvents)
      .values({ userId: acct.id, tokensIn: 1000, tokensOut: 0, createdAt: new Date(resetAt.getTime() - 5000) })
      .run();
    db.insert(usageEvents)
      .values({ userId: acct.id, tokensIn: 7, tokensOut: 3, createdAt: new Date(resetAt.getTime() + 5000) })
      .run();

    const row = listAccounts().find((a) => a.id === acct.id)!;
    expect(row.usageTokens).toBe(10); // only the post-reset event (7+3), not the 1000 before
  });

  test("usageTokens counts ALL events when usageResetAt is null", () => {
    const acct = makeAccount({ usageResetAt: null });
    db.insert(usageEvents).values({ userId: acct.id, tokensIn: 40, tokensOut: 2 }).run();
    const row = listAccounts().find((a) => a.id === acct.id)!;
    expect(row.usageTokens).toBe(42);
  });

  test("lastSeenAt is the max of the user's sessions; null when none", () => {
    const acct = makeAccount();
    const older = new Date(Date.now() - 120_000);
    const newer = new Date(Date.now() - 10_000);
    db.insert(sessions)
      .values({ userId: acct.id, tokenHash: `h1-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000), lastSeenAt: older })
      .run();
    db.insert(sessions)
      .values({ userId: acct.id, tokenHash: `h2-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000), lastSeenAt: newer })
      .run();

    const row = listAccounts().find((a) => a.id === acct.id)!;
    expect(row.lastSeenAt?.getTime()).toBe(newer.getTime()); // the more recent session

    const noSessions = makeAccount();
    expect(listAccounts().find((a) => a.id === noSessions.id)!.lastSeenAt).toBeNull();
  });
});

// ---- revokeAccount ---------------------------------------------------------------------
describe("revokeAccount", () => {
  test("clears accessGrantedAt AND deletes ALL the user's sessions", () => {
    const acct = makeAccount({ accessGrantedAt: new Date() });
    db.insert(sessions).values({ userId: acct.id, tokenHash: `s1-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) }).run();
    db.insert(sessions).values({ userId: acct.id, tokenHash: `s2-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) }).run();

    const res = revokeAccount(acct.id);
    expect(res.ok).toBe(true);

    const after = db.select().from(users).where(eq(users.id, acct.id)).get()!;
    expect(after.accessGrantedAt).toBeNull(); // the auth gate now walls it (account_inactive)
    expect(after.role).toBe("account"); // still an account (not deleted, not re-roled)
    const remaining = db.select().from(sessions).where(eq(sessions.userId, acct.id)).all();
    expect(remaining.length).toBe(0); // every session gone → kicked out immediately
  });

  test("does NOT touch other users' sessions", () => {
    const a = makeAccount();
    const b = makeAccount();
    db.insert(sessions).values({ userId: a.id, tokenHash: `a-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) }).run();
    db.insert(sessions).values({ userId: b.id, tokenHash: `b-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) }).run();

    revokeAccount(a.id);
    expect(db.select().from(sessions).where(eq(sessions.userId, b.id)).all().length).toBe(1); // b untouched
  });

  test("unknown id → not_found", () => {
    expect(revokeAccount("does-not-exist")).toEqual({ ok: false, reason: "not_found" });
  });

  test("an admin user is never revocable through this path (only role='account')", () => {
    const admin = db.insert(users).values({ login: `admin-${Math.random()}`, role: "admin", accessGrantedAt: new Date() }).returning().get()!;
    const res = revokeAccount(admin.id);
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(db.select().from(users).where(eq(users.id, admin.id)).get()!.accessGrantedAt).not.toBeNull(); // untouched
  });
});

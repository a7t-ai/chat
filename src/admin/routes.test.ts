import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../auth/middleware.ts";
import { db } from "../db/index.ts";
import { conversations, messages, sessions, usageEvents, users } from "../db/schema.ts";
import { backend } from "../jano/client.ts";
import adminRoutes from "./routes.ts";

// Integration tests for the admin router. Email OTP + invites + per-account guardrail settings were
// removed (#169), so the surface is now: telemetry, list passkey accounts, revoke one, set its plan.
// The router is mounted behind a fake-auth middleware; admin.accounts / admin.stats are owner-only,
// so we also verify a non-admin (account) caller is walled. Jano (listModels) + its /health
// (janoStats) are STUBBED — never the network.

const realListModels = backend.listModels;
const realFetch = globalThis.fetch;

beforeEach(() => {
  backend.listModels = (async () => [{ id: "qwen-chat", label: "Qwen Chat" }]) as typeof backend.listModels;
  // janoStats() fetches `${janoUrl}/health`; return a small telemetry blob.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ model: "qwen-chat", queueDepth: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  backend.listModels = realListModels;
  globalThis.fetch = realFetch;
});

function makeAdmin(): AuthContext {
  const u = db.insert(users).values({ login: `admin-${Math.random()}`, role: "admin" }).returning().get();
  return { role: "admin", via: "owner", user: u, key: null };
}
// A non-admin caller (account tier) — used to assert the owner-only features wall it out.
function makeNonAdmin(): AuthContext {
  const u = db.insert(users).values({ login: `acct-${Math.random()}`, role: "account", accessGrantedAt: new Date() }).returning().get();
  return { role: "account", via: "session", user: u, key: null, accessGranted: true };
}

function appFor(auth: AuthContext): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    return next();
  });
  app.route("/", adminRoutes);
  return app;
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// A passkey account (no email) + an optional usageResetAt to exercise the usage meter.
function makeAccount(snap: Partial<{ email: string; usageResetAt: Date | null }> = {}) {
  return db
    .insert(users)
    .values({
      login: `acct-${Math.random()}`,
      email: snap.email ?? null,
      role: "account",
      accessGrantedAt: new Date(),
      usageResetAt: snap.usageResetAt === undefined ? null : snap.usageResetAt,
    })
    .returning()
    .get()!;
}

// ---- GET /stats -----------------------------------------------------------------------
describe("GET /stats", () => {
  test("aggregates usage by model, with totals, recent, and the backend block", async () => {
    const admin = makeAdmin();
    const owner = db.insert(users).values({ login: "stats-user", role: "account" }).returning().get();
    const conv = db.insert(conversations).values({ userId: owner.id, title: "C" }).returning().get();
    db.insert(messages).values({ conversationId: conv.id, userId: owner.id, role: "user", content: "hi" }).run();
    // two usage events for the same user, one old (>24h) one fresh
    db.insert(usageEvents).values({ userId: owner.id, conversationId: conv.id, model: "qwen-chat", tokensIn: 100, tokensOut: 50 }).run();
    db.insert(usageEvents)
      .values({ userId: owner.id, conversationId: conv.id, model: "qwen-code", tokensIn: 10, tokensOut: 5, createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .run();

    const res = await appFor(admin).request("/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { users: number; messages: number; requests: number; tokensIn: number; tokensOut: number; activeKeys: number };
      last24h: { requests: number; tokensIn: number };
      byModel: { model: string; requests: number }[];
      recent: { model: string }[];
      backend: { models: string[]; jano: Record<string, unknown> | null };
    };

    expect(body.totals.requests).toBeGreaterThanOrEqual(2);
    expect(body.totals.tokensIn).toBeGreaterThanOrEqual(110);
    expect(body.last24h.requests).toBeGreaterThanOrEqual(1); // the old event is excluded from 24h
    expect(body.byModel.map((m) => m.model)).toEqual(expect.arrayContaining(["qwen-chat", "qwen-code"]));
    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.backend.models).toEqual(["qwen-chat"]); // from the stubbed listModels
    expect(body.backend.jano).toMatchObject({ model: "qwen-chat" }); // from the stubbed /health
  });

  test("janoStats returns null gracefully when /health fails (still 200)", async () => {
    const admin = makeAdmin();
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const res = await appFor(admin).request("/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backend: { jano: unknown } };
    expect(body.backend.jano).toBeNull();
  });

  test("a non-admin is walled (admin.stats is owner-only) → 403", async () => {
    const res = await appFor(makeNonAdmin()).request("/stats");
    expect(res.status).toBe(403);
  });
});

// ---- accounts (list / revoke / plan) --------------------------------------------------
describe("GET /accounts", () => {
  test("lists accounts with live usage + lastSeen; no secrets, no guardrail fields", async () => {
    const admin = makeAdmin();
    const acct = makeAccount({ email: "list@me.com" });
    db.insert(usageEvents).values({ userId: acct.id, tokensIn: 30, tokensOut: 12 }).run();
    db.insert(sessions)
      .values({ userId: acct.id, tokenHash: `sess-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000), lastSeenAt: new Date() })
      .run();

    const res = await appFor(admin).request("/accounts");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("token_hash");
    // The removed guardrail settings must NOT resurface in the listing.
    expect(raw).not.toContain("modelAllowlist");
    expect(raw).not.toContain("maxConcurrency");

    const body = JSON.parse(raw) as { accounts: { id: string; email: string | null; plan: string; usageTokens: number; lastSeenAt: number | null }[] };
    const row = body.accounts.find((a) => a.id === acct.id)!;
    expect(row.email).toBe("list@me.com");
    expect(row.usageTokens).toBe(42); // 30 + 12
    expect(row.plan).toBe("ultra"); // OSS default (#166)
    expect(row.lastSeenAt).not.toBeNull();
  });

  test("usage respects a legacy usageResetAt", async () => {
    const admin = makeAdmin();
    const resetAt = new Date(Date.now() - 60_000);
    const acct = makeAccount({ usageResetAt: resetAt });
    db.insert(usageEvents).values({ userId: acct.id, tokensIn: 999, tokensOut: 0, createdAt: new Date(resetAt.getTime() - 5000) }).run();
    db.insert(usageEvents).values({ userId: acct.id, tokensIn: 4, tokensOut: 1, createdAt: new Date(resetAt.getTime() + 5000) }).run();

    const res = await appFor(admin).request("/accounts");
    const body = (await res.json()) as { accounts: { id: string; usageTokens: number }[] };
    expect(body.accounts.find((a) => a.id === acct.id)!.usageTokens).toBe(5); // only post-reset
  });

  test("a non-admin is walled (admin.accounts is owner-only) → 403", async () => {
    const res = await appFor(makeNonAdmin()).request("/accounts");
    expect(res.status).toBe(403);
  });
});

describe("POST /accounts/:id/revoke", () => {
  test("clears accessGrantedAt + deletes ALL sessions → the account is kicked out + walled", async () => {
    const admin = makeAdmin();
    const acct = makeAccount();
    db.insert(sessions).values({ userId: acct.id, tokenHash: `r1-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) }).run();
    db.insert(sessions).values({ userId: acct.id, tokenHash: `r2-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) }).run();

    const res = await appFor(admin).request(`/accounts/${acct.id}/revoke`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });

    const after = db.select().from(users).where(eq(users.id, acct.id)).get()!;
    expect(after.accessGrantedAt).toBeNull(); // the auth gate now walls it (account_inactive)
    expect(db.select().from(sessions).where(eq(sessions.userId, acct.id)).all().length).toBe(0); // kicked out
  });

  test("unknown id → 404", async () => {
    const res = await appFor(makeAdmin()).request("/accounts/missing/revoke", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("revoking an admin id is a no-op → 404 (can never strip the owner)", async () => {
    const admin = makeAdmin();
    const otherAdmin = db.insert(users).values({ login: `admin2-${Math.random()}`, role: "admin" }).returning().get()!;
    const res = await appFor(admin).request(`/accounts/${otherAdmin.id}/revoke`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(db.select().from(users).where(eq(users.id, otherAdmin.id)).get()!.role).toBe("admin");
  });

  test("a non-admin cannot revoke → 403", async () => {
    const res = await appFor(makeNonAdmin()).request("/accounts/whatever/revoke", { method: "POST" });
    expect(res.status).toBe(403);
  });
});

describe("POST /accounts/:id/plan (#13)", () => {
  test("sets an account's plan and returns the refreshed row", async () => {
    const admin = makeAdmin();
    const acct = makeAccount();
    const res = await appFor(admin).request(`/accounts/${acct.id}/plan`, json({ plan: "pro" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { id: string; plan: string } };
    expect(body.account.plan).toBe("pro");
    expect(db.select().from(users).where(eq(users.id, acct.id)).get()!.plan).toBe("pro");
  });

  test("an invalid plan → 400 (no change)", async () => {
    const admin = makeAdmin();
    const acct = makeAccount();
    const res = await appFor(admin).request(`/accounts/${acct.id}/plan`, json({ plan: "enterprise" }));
    expect(res.status).toBe(400);
    // A fresh account defaults to `ultra` in the OSS build (#166); the rejected update leaves it there.
    expect(db.select().from(users).where(eq(users.id, acct.id)).get()!.plan).toBe("ultra");
  });

  test("unknown / non-account id → 404", async () => {
    const res = await appFor(makeAdmin()).request("/accounts/nope/plan", json({ plan: "pro" }));
    expect(res.status).toBe(404);
  });

  test("a non-admin cannot set a plan → 403", async () => {
    const res = await appFor(makeNonAdmin()).request("/accounts/whatever/plan", json({ plan: "pro" }));
    expect(res.status).toBe(403);
  });
});

// ---- REMOVED: invites + per-account guardrail routes are gone (#169) ---------------------
describe("REMOVED — invite + guardrail routes no longer exist (#169)", () => {
  test("POST /invites → 404", async () => {
    const res = await appFor(makeAdmin()).request("/invites", json({ label: "x" }));
    expect(res.status).toBe(404);
  });
  test("GET /invites → 404", async () => {
    const res = await appFor(makeAdmin()).request("/invites");
    expect(res.status).toBe(404);
  });
  test("PATCH /accounts/:id (guardrail edit) → 404", async () => {
    const acct = makeAccount();
    const res = await appFor(makeAdmin()).request(`/accounts/${acct.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budget: 1 }),
    });
    expect(res.status).toBe(404);
  });
  test("POST /accounts/:id/reset-usage → 404", async () => {
    const acct = makeAccount();
    const res = await appFor(makeAdmin()).request(`/accounts/${acct.id}/reset-usage`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

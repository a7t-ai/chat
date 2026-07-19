import { count, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { listAccounts, revokeAccount } from "../auth/account.service.ts";
import { setAccountPlan } from "../billing/service.ts";
import { db } from "../db/index.ts";
import { conversations, keys, messages, usageEvents, users } from "../db/schema.ts";
import { requireFeature } from "../entitlements/index.ts";
import { isAccountPlan } from "../entitlements/plans.ts";
import { backend, janoStats } from "../jano/client.ts";

// Admin-only. Mounted under /api/admin (already behind the auth gate). The email OTP + invite
// machinery was removed (#169) — accounts sign up with a passkey — so this is now a minimal
// account-management + telemetry surface: list passkey accounts, revoke one (kick it out), set its
// plan, and the local stats dashboard.
//
// Each route is gated on its own entitlement feature (`admin.accounts` / `admin.stats`) rather than
// a blanket role check, so the owner-only wall lives in the same catalog as every other feature
// (see src/entitlements/). Both resolve to "admin role only" today.
const admin = new Hono();

// Accounts — management of passkey-login users. Owner-only via admin.accounts (an account can never
// reach this). Every response is the secret-free AccountListing (never a token hash / session token).

// List accounts with their plan + live usage + lastSeen (max of the account's sessions). No secrets.
admin.get("/accounts", requireFeature("admin.accounts"), (c) => {
  return c.json({ accounts: listAccounts() });
});

// Revoke an account: clear accessGrantedAt AND delete ALL its sessions (atomic) — kicks it out
// immediately (its passkeys stay, but access is gone). Unknown / non-account id → 404. Idempotent.
// This is the owner-only account recovery/reset lever (#169: no email recovery).
admin.post("/accounts/:id/revoke", requireFeature("admin.accounts"), (c) => {
  const id = c.req.param("id");
  const res = revokeAccount(id);
  if (!res.ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// Set an account's subscription plan (#13) — the admin override, mirroring the billing webhook but
// gated by admin.accounts. Body: { plan: "free" | "plus" | "pro" | "ultra" }. An invalid plan is a 400; an
// unknown / non-account id is a 404 (setAccountPlan only touches role='account' rows, so this can
// never change an admin/owner). Returns the refreshed account row.
admin.post("/accounts/:id/plan", requireFeature("admin.accounts"), async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { plan?: unknown };
  if (!isAccountPlan(body.plan)) return c.json({ error: "invalid plan" }, 400);
  if (!setAccountPlan(id, body.plan)) return c.json({ error: "not found" }, 404);
  const account = listAccounts().find((a) => a.id === id);
  if (!account) return c.json({ error: "not found" }, 404);
  return c.json({ account });
});

// Telemetry: app-layer usage (per user/model, from usage_events) + on-demand Jano stats.
admin.get("/stats", requireFeature("admin.stats"), async (c) => {
  const dayAgoMs = Date.now() - 86_400_000;

  const totals = {
    users: db.select({ n: count() }).from(users).get()?.n ?? 0,
    conversations: db.select({ n: count() }).from(conversations).get()?.n ?? 0,
    messages: db.select({ n: count() }).from(messages).get()?.n ?? 0,
    activeKeys: db.select({ n: count() }).from(keys).where(isNull(keys.revokedAt)).get()?.n ?? 0,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
  };

  const usage = db
    .select({
      login: users.login,
      model: usageEvents.model,
      tokensIn: usageEvents.tokensIn,
      tokensOut: usageEvents.tokensOut,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .leftJoin(users, eq(usageEvents.userId, users.id))
    .all();

  const last24h = { requests: 0, tokensIn: 0, tokensOut: 0 };
  const byModel = new Map<string, { model: string; requests: number; tokensIn: number; tokensOut: number }>();

  for (const u of usage) {
    totals.requests++;
    totals.tokensIn += u.tokensIn;
    totals.tokensOut += u.tokensOut;
    if (u.createdAt.getTime() >= dayAgoMs) {
      last24h.requests++;
      last24h.tokensIn += u.tokensIn;
      last24h.tokensOut += u.tokensOut;
    }
    const mk = u.model ?? "?";
    const m = byModel.get(mk) ?? { model: mk, requests: 0, tokensIn: 0, tokensOut: 0 };
    m.requests++;
    m.tokensIn += u.tokensIn;
    m.tokensOut += u.tokensOut;
    byModel.set(mk, m);
  }

  const recent = usage
    .slice(-15)
    .reverse()
    .map((u) => ({ login: u.login, model: u.model, tokensIn: u.tokensIn, tokensOut: u.tokensOut, at: u.createdAt.getTime() }));

  const models = await backend.listModels().then((m) => m.map((x) => x.id)).catch(() => [] as string[]);
  const jano = await janoStats();

  return c.json({
    totals,
    last24h,
    byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests),
    recent,
    backend: { models, jano },
  });
});

export default admin;

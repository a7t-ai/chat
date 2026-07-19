import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "../auth/cookie.ts";
import { createSession } from "../auth/session.service.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import server from "../server.ts";

const SIG = "x-a7t-billing-signature";

function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(server.fetch(new Request(`http://localhost${path}`, init)));
}
// Admin = the LOCAL break-glass bootstrap (#191 removed the Tailscale-header admin path). Setting
// DEV_ADMIN_LOGIN admits a credential-less, non-edge request as that login-keyed admin. Returns `{}`;
// the side effect is the grant. beforeEach clears it so account-cookie tests aren't preempted.
function adminHeaders(login = `bill-admin-${Math.random()}`): Record<string, string> {
  (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = login;
  return {};
}
function seedAccount(over: Partial<{ email: string; plan: "free" | "plus" | "pro" | "ultra" }> = {}) {
  const u = db
    .insert(users)
    .values({
      login: `bill-acct-${Math.random()}`,
      email: over.email ?? `${Math.random()}@a7t.test`,
      role: "account",
      plan: over.plan ?? "free",
      accessGrantedAt: new Date(),
    })
    .returning()
    .get()!;
  return { user: u, cookie: `${SESSION_COOKIE}=${createSession({ userId: u.id }).token}` };
}
function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

type BillingCfg = { provider: string; webhookSecret: string; checkoutUrls: Record<string, string> };
const billing = () => config.billing as unknown as BillingCfg;

beforeEach(() => {
  const a = config.auth as unknown as { devAdminLogin: string; edgeMarkerSecret: string };
  a.devAdminLogin = "";
  a.edgeMarkerSecret = "";
  const b = billing();
  b.provider = "";
  b.webhookSecret = "";
  b.checkoutUrls = { byok: "", pro: "" };
});
afterEach(() => {
  db.delete(users).run();
});

describe("GET /api/billing", () => {
  test("401 without a credential", async () => {
    expect((await fetchApp("/api/billing")).status).toBe(401);
  });

  test("account: catalog + current plan + no checkout when billing is dark", async () => {
    const { cookie } = seedAccount({ plan: "plus" });
    const res = await fetchApp("/api/billing", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      owner: boolean;
      currentPlan: string;
      plans: { id: string; checkoutAvailable: boolean }[];
    };
    expect(body.configured).toBe(false);
    expect(body.owner).toBe(false);
    expect(body.currentPlan).toBe("plus");
    expect(body.plans.map((p) => p.id)).toEqual(["free", "plus", "pro", "ultra"]);
    expect(body.plans.every((p) => p.checkoutAvailable === false)).toBe(true);
  });

  test("admin is the owner tier (owner:true, currentPlan owner), no upgrade path", async () => {
    const res = await fetchApp("/api/billing", { headers: adminHeaders() });
    const body = (await res.json()) as { owner: boolean; currentPlan: string };
    expect(body.owner).toBe(true);
    expect(body.currentPlan).toBe("owner");
  });

  test("checkoutAvailable reflects a configured hosted link per purchasable plan", async () => {
    const { cookie } = seedAccount();
    billing().provider = "polar";
    billing().checkoutUrls.pro = "https://buy.example/pro";
    const res = await fetchApp("/api/billing", { headers: { cookie } });
    const body = (await res.json()) as { configured: boolean; plans: { id: string; checkoutAvailable: boolean }[] };
    expect(body.configured).toBe(true);
    const byId = Object.fromEntries(body.plans.map((p) => [p.id, p.checkoutAvailable]));
    expect(byId.free).toBe(false);
    expect(byId.plus).toBe(false); // no URL set
    expect(byId.ultra).toBe(false); // no URL set
    expect(byId.pro).toBe(true);
  });
});

describe("POST /api/billing/checkout", () => {
  test("returns the checkout url for a purchasable, configured plan", async () => {
    const { cookie } = seedAccount();
    billing().provider = "polar";
    billing().checkoutUrls.pro = "https://buy.example/pro";
    const res = await fetchApp("/api/billing/checkout", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { url: string }).toEqual({ url: "https://buy.example/pro" });
  });

  test("400 for a bad/free plan; 503 when purchasable but no link configured", async () => {
    const { cookie } = seedAccount();
    billing().provider = "polar";
    const bad = await fetchApp("/api/billing/checkout", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ plan: "free" }),
    });
    expect(bad.status).toBe(400);
    const dark = await fetchApp("/api/billing/checkout", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(dark.status).toBe(503);
  });

  test("401 without a credential (checkout is gated)", async () => {
    const res = await fetchApp("/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/billing/webhook — public, HMAC-gated", () => {
  test("503 when the webhook secret is unconfigured (fails closed, no DB touch)", async () => {
    const { user } = seedAccount({ email: "leo@a7t.test", plan: "free" });
    const body = JSON.stringify({ email: "leo@a7t.test", plan: "pro" });
    const res = await fetchApp("/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", [SIG]: sign(body, "whatever") },
      body,
    });
    expect(res.status).toBe(503);
    const row = db.select({ plan: users.plan }).from(users).where(eqId(user.id)).get();
    expect(row?.plan).toBe("free"); // untouched
  });

  test("401 on a missing / wrong signature (no plan change)", async () => {
    billing().webhookSecret = "s3cret";
    const { user } = seedAccount({ email: "leo@a7t.test", plan: "free" });
    const body = JSON.stringify({ email: "leo@a7t.test", plan: "pro" });

    const noSig = await fetchApp("/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(noSig.status).toBe(401);

    const wrong = await fetchApp("/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", [SIG]: sign(body, "wrong-secret") },
      body,
    });
    expect(wrong.status).toBe(401);
    expect(db.select({ plan: users.plan }).from(users).where(eqId(user.id)).get()?.plan).toBe("free");
  });

  test("a valid signed event flips the account's plan (idempotent)", async () => {
    billing().webhookSecret = "s3cret";
    const { user } = seedAccount({ email: "leo@a7t.test", plan: "free" });
    const body = JSON.stringify({ email: "leo@a7t.test", plan: "pro" });
    const res = await fetchApp("/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", [SIG]: sign(body, "s3cret") },
      body,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; applied: boolean }).toEqual({ ok: true, applied: true });
    expect(db.select({ plan: users.plan }).from(users).where(eqId(user.id)).get()?.plan).toBe("pro");
  });

  test("400 on a valid signature but an invalid event body", async () => {
    billing().webhookSecret = "s3cret";
    const body = JSON.stringify({ email: "leo@a7t.test", plan: "enterprise" });
    const res = await fetchApp("/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", [SIG]: sign(body, "s3cret") },
      body,
    });
    expect(res.status).toBe(400);
  });

  test("unknown email → 200 applied:false (no account-existence oracle)", async () => {
    billing().webhookSecret = "s3cret";
    const body = JSON.stringify({ email: "ghost@a7t.test", plan: "pro" });
    const res = await fetchApp("/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", [SIG]: sign(body, "s3cret") },
      body,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; applied: boolean }).toEqual({ ok: true, applied: false });
  });

  test("a downgrade event (plan:free) is honored", async () => {
    billing().webhookSecret = "s3cret";
    const { user } = seedAccount({ email: "leo@a7t.test", plan: "pro" });
    const body = JSON.stringify({ email: "leo@a7t.test", plan: "free" });
    await fetchApp("/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", [SIG]: sign(body, "s3cret") },
      body,
    });
    expect(db.select({ plan: users.plan }).from(users).where(eqId(user.id)).get()?.plan).toBe("free");
  });
});

// eqId — a tiny local scoping helper (users.id) to keep the DB assertions terse.
function eqId(id: string) {
  return eq(users.id, id);
}

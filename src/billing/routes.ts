import { Hono } from "hono";
import { config } from "../config.ts";
import { planCatalog } from "../entitlements/plans.ts";
import {
  accountIdByEmail,
  BillingError,
  billingConfigured,
  checkoutUrlFor,
  currentPlan,
  setAccountPlan,
  startCheckout,
} from "./service.ts";
import {
  parseBillingEvent,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
  webhookConfigured,
} from "./webhook.ts";

// Billing / plans (#13). Mounted at /api/billing. Two authenticated routes (the pricing view + the
// self-serve checkout start) sit behind the normal auth gate — viewing/buying plans is available to
// any authenticated account (no entitlement wall; the WHOLE point is to let a free account upgrade).
// The webhook is PUBLIC (the provider can't hold a session) and carved out of the auth gate in
// authMiddleware — it is bounded ENTIRELY by the HMAC signature, verified before any DB access.
const billing = new Hono();

// The pricing view: the plan ladder, the caller's current plan, and — per plan — whether a
// self-serve checkout is available (a configured hosted link). No secrets; the caller's own plan
// only. This endpoint is retained as DORMANT scaffolding for a possible future hosted tier; the OSS
// build removed its frontend caller (the Plans/pricing UI) since there's no paywall (#166).
billing.get("/", (c) => {
  const auth = c.get("auth");
  // Admin is the owner tier, above the account ladder (`owner`); an account carries a real plan.
  const current = auth.role === "admin" ? "owner" : currentPlan(auth.user.id);
  return c.json({
    provider: config.billing.provider,
    configured: billingConfigured(),
    // Admin is the owner tier, above the account ladder — they already have everything, so the UI
    // shows no upgrade path for them (owner=true).
    owner: auth.role === "admin",
    currentPlan: current,
    plans: planCatalog().map((p) => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      highlights: p.highlights,
      purchasable: p.purchasable,
      // Whether THIS caller could start a checkout for this plan right now (provider configured +
      // a hosted link set for it). The server re-checks on POST /checkout regardless.
      checkoutAvailable: checkoutUrlFor(p.id) !== null,
    })),
  });
});

// Start a checkout for a plan. Body: `{ plan }`. Returns `{ url }` — the provider's hosted checkout
// link to redirect to. A rejection surfaces as its BillingError status (400 unknown/non-purchasable,
// 503 no self-serve path for it). The plan flip happens later, via the signed webhook — never here.
billing.post("/checkout", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { plan?: unknown };
  try {
    return c.json(startCheckout(body.plan));
  } catch (e) {
    if (e instanceof BillingError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// Provider webhook — PUBLIC, gated ONLY by the HMAC signature (no auth context; carved out of the
// auth gate). Order is load-bearing: fail closed on an unconfigured secret, verify the signature
// over the RAW body, and only THEN parse + apply — so an invalid/forged request never reaches the
// DB. Applying is idempotent (setting the same plan twice is a no-op) and can only touch a
// role='account' row. An unknown-email event is a 200 `applied:false` (no account-existence oracle).
billing.post("/webhook", async (c) => {
  if (!webhookConfigured()) return c.json({ error: "billing webhook not configured" }, 503);
  const raw = await c.req.text();
  if (!verifyWebhookSignature(raw, c.req.header(SIGNATURE_HEADER))) {
    return c.json({ error: "invalid signature" }, 401);
  }
  const event = parseBillingEvent(raw);
  if (!event) return c.json({ error: "invalid event" }, 400);
  const userId = accountIdByEmail(event.email);
  if (!userId) return c.json({ ok: true, applied: false });
  const applied = setAccountPlan(userId, event.plan);
  return c.json({ ok: true, applied });
});

export default billing;

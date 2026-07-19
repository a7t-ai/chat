import { eq, sql } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { type AccountPlanId, accountPlanOf, isAccountPlan, planInfo } from "../entitlements/plans.ts";

// The billing seam (#13) — the ONE place the plan ladder is charged for and applied. It stays
// PROVIDER-AGNOSTIC: this module knows only "start a hosted checkout for a plan" and "set an
// account's plan"; the actual provider (Polar, …) is wired through config (a checkout URL per plan
// + a webhook secret), never hard-coded here. Every premium feature still works without billing —
// this only lights up SELF-SERVE upgrades.

// A rejection the routes turn into an HTTP wall. Only the statuses the routes emit (bad request /
// not purchasable / feature dark) as a literal union so Hono's `c.json(body, status)` accepts it.
export class BillingError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 503) {
    super(message);
    this.name = "BillingError";
  }
}

// Whether a billing provider is configured at all. When false, the pricing UI still renders (it's
// informative), but no self-serve checkout is offered — upgrades are "contact the owner" / admin.
export function billingConfigured(): boolean {
  return config.billing.provider.trim().length > 0;
}

// The hosted checkout URL for a plan, or null when there's no self-serve path for it (billing dark,
// the plan isn't purchasable — e.g. `free` — or no URL configured for it). A configured URL is a
// FIXED provider link (no user input), so there is no SSRF surface. We only surface https links —
// a mis-set non-https value is treated as absent, never sent to the client.
export function checkoutUrlFor(plan: AccountPlanId): string | null {
  if (!billingConfigured()) return null;
  if (!planInfo(plan).purchasable) return null;
  const url = (config.billing.checkoutUrls[plan] ?? "").trim();
  if (!url || !/^https:\/\//i.test(url)) return null;
  return url;
}

// Start a checkout for the caller's chosen plan: validate it's a real, purchasable plan with a
// configured hosted link, and return that link for the client to redirect to. Throws BillingError
// (400 unknown/non-purchasable plan, 503 no self-serve path) otherwise — never a bare 500.
export function startCheckout(plan: unknown): { url: string } {
  if (!isAccountPlan(plan) || plan === "free" || !planInfo(plan).purchasable) {
    throw new BillingError("unknown or non-purchasable plan", 400);
  }
  const url = checkoutUrlFor(plan);
  if (!url) throw new BillingError("self-serve checkout is not available for this plan", 503);
  return { url };
}

// The caller's current plan (validated) — for the /api/billing view. Reads the account row.
export function currentPlan(userId: string): AccountPlanId {
  const row = db.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).get();
  return row ? accountPlanOf(row) : "free";
}

// Set an account's subscription plan — the ONE mutation both the billing webhook and the admin
// override funnel through. SECURITY: only ever touches role='account' rows (re-asserted in the
// WHERE), so it can NEVER change an admin/owner (their plan is moot) or escalate a role; `plan`
// is validated against the catalog by the caller. Returns whether a matching account was updated
// (false = no such account, e.g. an unknown-email webhook — no existence oracle leaked upstream).
export function setAccountPlan(userId: string, plan: AccountPlanId): boolean {
  const updated = db
    .update(users)
    .set({ plan })
    .where(sql`${users.id} = ${userId} AND ${users.role} = 'account'`)
    .returning({ id: users.id })
    .all();
  return updated.length > 0;
}

// Resolve an account by email (normalized lowercased+trimmed, as stored) for the webhook, which
// identifies the paying customer by email. Returns the account's id, or null when no such ACCOUNT
// exists (never matches an admin/guest row — plans only apply to accounts).
export function accountIdByEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const row = db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.email} = ${normalized} AND ${users.role} = 'account'`)
    .get();
  return row?.id ?? null;
}

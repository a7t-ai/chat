import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { type AccountPlanId, isAccountPlan } from "../entitlements/plans.ts";

// The billing webhook verifier + parser (#13). The provider (or a thin relay in front of it) POSTs
// a signed event when a subscription starts / changes / cancels; we flip the account's plan. The
// signature is checked BEFORE any DB access (mirrors the share write-token, src/share/write-token.ts)
// so an unsigned/forged/dark-config request is a true no-op, never touching storage.
//
// The wire contract is deliberately PROVIDER-AGNOSTIC and minimal so it's honest to test and simple
// to wire behind any provider:
//   - Signature: `x-a7t-billing-signature: <hex HMAC-SHA256 of the raw body>` (a `sha256=` prefix
//     is tolerated). Signed with BILLING_WEBHOOK_SECRET; UNSET ⇒ verification fails closed.
//   - Body: `{ "email": "<account email>", "plan": "free" | "plus" | "pro" | "ultra" }` — set that account's
//     plan (downgrade to `free` on cancel). Anything else (bad plan, missing email) is rejected.
//
// Scope note: applying an event is idempotent and can ONLY toggle a plan (feature flags), never
// spend/budget or a role — so even a replayed event can't grant unmetered usage or escalate. A
// production provider (or the relay in front of it) should still include replay protection (a
// signed timestamp/id, e.g. standard-webhooks) to bound the replay window; that lives in the
// provider adapter, outside this minimal normalized core.

export const SIGNATURE_HEADER = "x-a7t-billing-signature";

function secretOf(secret?: string): string {
  return secret ?? config.billing.webhookSecret;
}

// Whether the webhook can operate — a signing secret is configured. With no secret the endpoint
// fails closed (503, no verification attempted), so a plan can never flip on an unconfigured server.
export function webhookConfigured(secret?: string): boolean {
  return secretOf(secret).trim().length > 0;
}

// Constant-time hex compare — equal-length check first (timingSafeEqual throws on length mismatch),
// so a wrong-length signature fails fast without leaking timing on the compare.
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false; // non-hex / malformed input
  }
}

// Verify the HMAC-SHA256 signature over the RAW request body. False (a no-op reject) for a missing
// secret (dark), a missing/malformed signature, or a mismatch — with NO DB access. `secret` is
// injectable for tests; production uses the configured secret.
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret?: string,
): boolean {
  const s = secretOf(secret);
  if (s.trim().length === 0) return false; // fail closed when unconfigured
  if (!signature) return false;
  const provided = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  const expected = createHmac("sha256", s).update(rawBody).digest("hex");
  return safeEqualHex(provided, expected);
}

// The normalized event this endpoint acts on: set `email`'s account to `plan`.
export interface BillingEvent {
  email: string;
  plan: AccountPlanId;
}

// Parse + validate the (already signature-verified) body into a normalized event, or null when it
// doesn't match the contract (not JSON, missing/blank email, or a plan not in the catalog). A null
// here is a clean 400 — we never coerce a bad plan into a real one.
export function parseBillingEvent(rawBody: string): BillingEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { email, plan } = data as { email?: unknown; plan?: unknown };
  if (typeof email !== "string" || email.trim().length === 0) return null;
  if (!isAccountPlan(plan)) return null;
  return { email, plan };
}

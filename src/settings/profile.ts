import type { AuthContext } from "../auth/middleware.ts";
import { tierOf } from "../entitlements/index.ts";
import { type AccountPlanId, accountPlanOf } from "../entitlements/plans.ts";

// The caller's OWN account snapshot for the profile card (#12) — the self-service counterpart of
// the admin accounts listing (which shows EVERY account). It reveals only what the caller may
// already see about themselves (their plan tier), so it rides on the ungated /api/me. Plan is
// derived from the entitlement TIER + the account's subscription. `planOf` is the single place
// that maps a caller to a user-facing plan id — the shape here stays put as the ladder grows.
// The usage meter was dropped (#186): with everyone `ultra` and no budgets it only ever surfaced
// an unactionable "no limit" line, so /api/me no longer carries a usage snapshot.

// The user-facing plan. The admin (the owner account — the first non-edge passkey sign-up, #191) is the
// "owner" tier ABOVE the ladder; an account resolves to its subscription plan on the user row (#13:
// free/plus/pro/ultra).
export type PlanId = "owner" | AccountPlanId;

export function planOf(auth: AuthContext): PlanId {
  return tierOf(auth) === "admin" ? "owner" : accountPlanOf(auth.user);
}

// The whole self-profile payload embedded in /api/me: which plan the caller is on. Identity fields
// (name/email/avatar) already ride on /api/me's `user` block, so this adds only the plan the card
// needs beyond that.
export interface SelfProfile {
  plan: PlanId;
}

export function selfProfile(auth: AuthContext): SelfProfile {
  return { plan: planOf(auth) };
}

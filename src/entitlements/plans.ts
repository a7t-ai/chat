import type { User } from "../db/schema.ts";
import type { Feature } from "./types.ts";

// The subscription ladder (#13) — the single source of truth for the account-facing plans and
// which premium features each unlocks. It maps OUR product ladder (free local Qwen taste → BYOK
// → paid flat), NOT a generic SaaS tier list. The entitlement rules (index.ts) derive premium
// access from a caller's plan through `planUnlocks`, and the pricing UI + billing seam
// (src/billing/) render/charge from `planCatalog`, so the ladder lives in exactly one place.
//
// The owner (admin over Tailscale) is ABOVE this ladder — the "owner" tier that always has
// everything — so admins never carry an account plan; only email-login accounts do.

// The purchasable account plans, in ladder order (floor → top). This is the STORED `users.plan`
// enum; keep it in sync with the schema column's enum. BYOK is NOT a tier — it's a FEATURE that
// tiers unlock (from Plus up); the ladder is Free → Plus → Pro → Ultra.
export type AccountPlanId = "free" | "plus" | "pro" | "ultra";

export const ACCOUNT_PLAN_IDS = ["free", "plus", "pro", "ultra"] as const satisfies readonly AccountPlanId[];

export interface Plan {
  id: AccountPlanId;
  name: string; // human display name (pricing card title)
  tagline: string; // one-line positioning under the name
  // Premium features this plan unlocks. Referenced by the entitlement predicates — a caller on a
  // plan whose `unlocks` includes a feature passes that feature's plan check. `free` unlocks none
  // of the premium levers (it's the local-model taste).
  unlocks: readonly Feature[];
  // Short bullet points for the pricing card (what you get on this rung). UI copy only.
  highlights: readonly string[];
  // Whether a checkout can be started for this plan. `free` is the default floor (not a purchase);
  // the paid rungs are purchasable when the billing provider has a checkout URL configured.
  purchasable: boolean;
}

// Features every tier includes. They're routed through the entitlement seam (so any of them CAN be
// promoted to a paid rung later with a one-line edit), but Free unlocks them all today — the
// "should stay free" set. Only BYOK + Research sit behind a paid rung. Kept separate so each higher
// tier's `unlocks` stays cumulative without repeating the list.
const BASELINE: readonly Feature[] = [
  "chat.voice",
  "chat.temporary",
  "conversations.share",
  "conversations.collaborate",
  "files",
];

// The catalog. `unlocks` is the load-bearing field (drives entitlements) — the CUMULATIVE set of
// features a tier grants; everything else is display copy. Adding/moving a premium lever is a
// one-line edit here, no route/predicate churn. (Pro and Ultra share the same features today — only
// BYOK + Research are gated — so Ultra differs by quota/limits, not feature set, for now.)
const PLANS: Record<AccountPlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "A taste of the local console.",
    unlocks: BASELINE,
    highlights: ["Local Qwen models", "Voice, files, sharing", "Conversation memory"],
    purchasable: false,
  },
  plus: {
    id: "plus",
    name: "Plus",
    tagline: "Bring your own frontier key.",
    // Plus adds BYOK — storing + spending a frontier-provider key (their model, their bill).
    unlocks: [...BASELINE, "byok"],
    highlights: ["Everything in Free", "Bring your own frontier key", "Run turns on your own provider"],
    purchasable: true,
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "One flat price, the whole console.",
    // Pro adds web search (Research) on top of BYOK.
    unlocks: [...BASELINE, "byok", "research"],
    highlights: ["Everything in Plus", "Web search (Research)", "Priority support"],
    purchasable: true,
  },
  ultra: {
    id: "ultra",
    name: "Ultra",
    tagline: "The whole console, maxed out.",
    // Same feature set as Pro today; positioned as the top rung with the highest quotas/limits.
    unlocks: [...BASELINE, "byok", "research"],
    highlights: ["Everything in Pro", "Highest usage limits", "Top concurrency"],
    purchasable: true,
  },
};

// Type guard: is `id` one of the stored account plan ids? Used to validate untrusted input
// (webhook payloads, admin patches) before it can reach `users.plan`.
export function isAccountPlan(id: unknown): id is AccountPlanId {
  return typeof id === "string" && (ACCOUNT_PLAN_IDS as readonly string[]).includes(id);
}

// The account's plan, read from the user row and validated. The OSS build has no paywall (#166):
// every account is `ultra` by default (see the schema column default), so a null / legacy / unknown
// value degrades to `ultra` too — resolving any account to the full feature set. The ladder + this
// seam stay in place as inert scaffolding for a possible future hosted tier; flipping this fallback
// (and the schema default) back to `free` is all it takes to re-arm the paywall.
export function accountPlanOf(user: Pick<User, "plan">): AccountPlanId {
  return isAccountPlan(user.plan) ? user.plan : "ultra";
}

// Whether a plan unlocks a premium feature. The entitlement predicates for the premium levers
// (research, byok) call this so plan → access lives in the catalog, not scattered in rules.
export function planUnlocks(plan: AccountPlanId, feature: Feature): boolean {
  return PLANS[plan].unlocks.includes(feature);
}

// A single plan's public descriptor (never any secret) — for the pricing card + billing view.
export function planInfo(id: AccountPlanId): Plan {
  return PLANS[id];
}

// The whole ladder, floor → top, for the pricing UI + billing catalog.
export function planCatalog(): Plan[] {
  return ACCOUNT_PLAN_IDS.map((id) => PLANS[id]);
}

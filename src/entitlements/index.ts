import type { Context, MiddlewareHandler } from "hono";
import type { AuthContext } from "../auth/middleware.ts";
import { config } from "../config.ts";
import { accountPlanOf, planUnlocks } from "./plans.ts";
import {
  type Decision,
  EntitlementError,
  type Feature,
  type Gate,
  GATE_STATUS,
  type GateStatus,
  type Rule,
} from "./types.ts";

export { EntitlementError };
export type { Decision, Feature, Gate, GateStatus };

// A caller's access tier. Today it maps to the auth role — admin (the owner over Tailscale),
// and the non-owner "free" tier which BOTH credentialed guests and email-login account users
// resolve to (account-with-access defaults to free; there are no paid plans yet). This is the
// seam where "free" / "pro" / "team" slot in later, derived from a subscription on the user
// row rather than the auth role. Everything reasons in tiers, so adding plans won't touch the
// call sites — only the rules below.
export type Tier = "admin" | "guest";

export function tierOf(auth: AuthContext): Tier {
  // An email-login account user defaults to the free tier (the non-owner "guest" tier today).
  // When real plans land, this is where a subscription on `auth.user` upgrades them.
  if (auth.role === "account") return "guest";
  return auth.role;
}

// Default rule: open to everyone. The foundation "returns true" — the survival-kit features
// (send / switch / regenerate / vote / read / write) are available to every tier, always.
const open = (title: string): Rule => ({ title, gate: "forbidden", entitled: () => true });

// A feature routed through the plan seam: the owner always has it, else the caller's plan must
// unlock it (see plans.ts). A paywall (an upgrade), not a hard lock. Free unlocks the BASELINE set,
// so these read as free TODAY but can be promoted to a paid rung just by moving them up in plans.ts
// — no route or call-site changes.
const planGated = (title: string, feature: Feature): Rule => ({
  title,
  gate: "paywall",
  entitled: (auth) => auth.role === "admin" || planUnlocks(accountPlanOf(auth.user), feature),
});

// The feature → rule table — the single source of truth for permissions. To put a feature
// behind a tier or a paywall, change its `entitled` predicate (and its `gate`); no route
// code changes.
const RULES: Record<Feature, Rule> = {
  "chat.send": open("Chat"),
  "chat.model_switch": open("Model switching"),
  "chat.regenerate": open("Regenerate"),
  "chat.temporary": planGated("Temporary chat", "chat.temporary"),
  "chat.vote": open("Voting"),
  "chat.voice": planGated("Voice input", "chat.voice"),
  "conversations.read": open("Viewing conversations"),
  "conversations.write": open("Managing conversations"),
  // The shareable-live-collab wedge. Open to everyone today (the growth loop wants sharing
  // frictionless), but it owns its own rule so a tier could later make sharing a paid lever
  // — a one-line edit here, no route changes.
  "conversations.share": planGated("Sharing", "conversations.share"),
  // The Share PRIMITIVE — invite a specific account to collaborate on the SAME conversation
  // (identity-bound, revocable), distinct from the public watch link above. Open to everyone
  // today (any owner can share their own chat), but it owns its own rule so a tier could later
  // make collaboration a paid lever — a one-line edit here, no route changes.
  "conversations.collaborate": planGated("Collaboration", "conversations.collaborate"),

  // Attachments / file manager (#15). Open to everyone today (any account manages its OWN files),
  // but it owns its own rule so storage could later become a paid/tiered lever — a one-line edit
  // here, no route changes. The routes are scoped per-caller regardless of this gate.
  files: planGated("Files", "files"),

  // Premium retrieval. Admins (the owner) always have it; an account gets it from its PLAN (the
  // `pro` rung unlocks `research`, see plans.ts). The `WEB_SEARCH_GUESTS` config flag stays a
  // global admin override that opens it to every account regardless of plan (useful while a
  // billing provider is being wired). A blocked account hits the PAYWALL (an upgrade), not a hard
  // forbidden. This is the rule the existing search gate delegates to.
  research: {
    title: "Research (web search)",
    gate: "paywall",
    entitled: (auth) =>
      auth.role === "admin" || config.search.guestsAllowed || planUnlocks(accountPlanOf(auth.user), "research"),
  },

  // Bring-your-own-key (#14). A paywall (an upgrade), not a hard lock: the owner always has it; an
  // account gets it from its PLAN (the `plus`, `pro`, and `ultra` rungs unlock `byok`, see plans.ts). The
  // `BYOK_GUESTS` config flag stays a global admin override (mirrors `research`). Gating STORING a
  // key here is the paid lever; the runner re-checks the same entitlement before spending a key
  // (resolveTurnBackend), so a downgraded plan can neither add keys nor use ones already stored.
  byok: {
    title: "Bring your own key",
    gate: "paywall",
    entitled: (auth) =>
      auth.role === "admin" || config.byok.guestsAllowed || planUnlocks(accountPlanOf(auth.user), "byok"),
  },

  // Owner-only tools. A hard tier lock (forbidden), never a paywall — an account can't buy
  // their way into the admin console. Managing passkey accounts (list / revoke / set plan).
  "admin.accounts": {
    title: "Account management",
    gate: "forbidden",
    entitled: (auth) => auth.role === "admin",
  },
  "admin.stats": {
    title: "Telemetry",
    gate: "forbidden",
    entitled: (auth) => auth.role === "admin",
  },
};

export const FEATURES = Object.keys(RULES) as Feature[];

// The friendly wall message for a gate. Shared by static features and capabilities so the
// copy stays consistent everywhere.
function gateMessage(gate: Gate, title: string): string {
  switch (gate) {
    case "paywall":
      return `${title} isn't included in your plan yet.`;
    case "forbidden":
      return `${title} isn't available for your account.`;
    case "unavailable":
      return `${title} is currently unavailable.`;
  }
}

// The core check: decide whether `auth` may use `feature`, returning everything a caller
// needs to either proceed or render the correct wall.
export function decide(auth: AuthContext, feature: Feature): Decision {
  const rule = RULES[feature];
  if (rule.entitled(auth)) return { allowed: true, feature };
  return {
    allowed: false,
    feature,
    gate: rule.gate,
    status: GATE_STATUS[rule.gate],
    message: gateMessage(rule.gate, rule.title),
  };
}

// Boolean convenience — "can this caller use the feature?" For UI hints (/api/me) and
// inline branching where no error is thrown.
export function can(auth: AuthContext, feature: Feature): boolean {
  return RULES[feature].entitled(auth);
}

// Throwing form for handlers that gate inline (mirrors chat's assertBudget / ChatError).
// Catch the EntitlementError and hand it to `entitlementJson`.
export function assertFeature(auth: AuthContext, feature: Feature): void {
  const d = decide(auth, feature);
  if (!d.allowed) throw new EntitlementError(d.feature, d.gate, d.status, d.message);
}

// Render a blocked check (a false Decision or an EntitlementError) as the HTTP wall. The
// shape matches the rest of the API's errors (`{ error, message }`) plus `feature`/`gate`
// so the client can branch — e.g. show an upgrade modal when `gate === "paywall"`.
export function entitlementJson(
  c: Context,
  d: { gate: Gate; status: GateStatus; message: string; feature: string },
) {
  return c.json({ error: d.gate, message: d.message, feature: d.feature, gate: d.gate }, d.status);
}

// Route guard for a static feature. Put it in front of a handler (or a whole sub-app) and
// a caller who lacks the feature gets the right wall before the handler runs:
//   chat.post("/transcribe", requireFeature("chat.voice"), handler)
export function requireFeature(feature: Feature): MiddlewareHandler {
  return async (c, next) => {
    const d = decide(c.get("auth"), feature);
    if (!d.allowed) return entitlementJson(c, d);
    return next();
  };
}

// Entitlement gate for a pluggable capability (maps, …). Capabilities aren't in the static
// catalog — each carries its own `entitled` predicate (default: everyone) and an optional
// `gate`. server.ts wraps every capability's routes in this, so a new capability is gated
// by the foundation automatically; a premium one just sets `entitled` (+ `gate`).
export function requireCapability(cap: {
  id: string;
  title: string;
  entitled?: (auth: AuthContext) => boolean;
  gate?: Gate;
}): MiddlewareHandler {
  const gate = cap.gate ?? "forbidden";
  return async (c, next) => {
    if (!cap.entitled || cap.entitled(c.get("auth"))) return next();
    return entitlementJson(c, {
      gate,
      status: GATE_STATUS[gate],
      message: gateMessage(gate, cap.title),
      feature: `cap:${cap.id}`,
    });
  };
}

// Per-feature snapshot for the client: which static features THIS caller may use. Drives
// showing or hiding entry points (composer toggles, admin buttons). The server re-checks
// on every request regardless, so this is a hint, never the enforcement.
export function featureMap(auth: AuthContext): Record<Feature, boolean> {
  const out = {} as Record<Feature, boolean>;
  for (const f of FEATURES) out[f] = can(auth, f);
  return out;
}

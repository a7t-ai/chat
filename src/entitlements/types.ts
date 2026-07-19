import type { AuthContext } from "../auth/middleware.ts";

// Entitlements: one place that answers "may THIS caller use THIS feature?" for every
// feature the app exposes. Today we have no paid plans and only two roles (admin = the
// owner over Tailscale, guest = a credentialed visitor), so most rules simply return
// true — but every feature is now wired through the seam, so introducing tiers or a
// paywall later is a one-line edit to a rule, never a hunt through the route code.

// The product's feature catalog. EVERY fixed, user-facing capability has an id here, and
// every route that serves one gates on it (`assertFeature` / `requireFeature` / `can`).
// Adding a feature = add its id here and a rule in `./index.ts`. Pluggable capabilities
// (maps, …) are gated through their own `entitled` seam instead (see `requireCapability`),
// so they are deliberately NOT enumerated here.
export type Feature =
  // --- core chat ---
  | "chat.send" // start/continue a turn (the main generation)
  | "chat.model_switch" // /model swap — pick the conversation's model
  | "chat.regenerate" // retry an answer / navigate its variants
  | "chat.temporary" // ephemeral "ghost" chat (nothing persisted)
  | "chat.vote" // 👍 / 👎 an answer
  | "chat.voice" // voice input (audio → transcript)
  // --- conversations ---
  | "conversations.read" // list / open conversations
  | "conversations.write" // rename / star / delete / (re)title
  | "conversations.share" // opt-in shareable-live-collab link (watch it build, no login)
  | "conversations.collaborate" // invite a specific account to collaborate on the same conversation
  // --- account tools ---
  | "files" // attachments / file manager — upload + manage your own files
  // --- premium retrieval ---
  | "research" // web search ("Research") — retrieval-augmented answers
  // --- premium model access ---
  | "byok" // bring-your-own frontier key — store + run turns on your own provider key/cost
  // --- owner-only tools ---
  | "admin.accounts" // manage passkey accounts: list / revoke / set plan
  | "admin.stats"; // telemetry dashboard

// How a caller who lacks a feature is turned away. Each maps to an HTTP status the client
// can branch on:
//   paywall     -> 402 Payment Required     — "upgrade your plan to use this"
//   forbidden   -> 403 Forbidden            — "your tier can never use this"
//   unavailable -> 503 Service Unavailable  — "the feature is off / not configured"
export type Gate = "paywall" | "forbidden" | "unavailable";

export type GateStatus = 402 | 403 | 503;

export const GATE_STATUS: Record<Gate, GateStatus> = {
  paywall: 402,
  forbidden: 403,
  unavailable: 503,
};

// The outcome of a check: either allowed, or blocked with everything the caller needs to
// return the correct wall (the gate kind, its HTTP status, and a human message).
export type Decision =
  | { allowed: true; feature: string }
  | { allowed: false; feature: string; gate: Gate; status: GateStatus; message: string };

// Thrown by `assertFeature` for handlers that gate inline (mirrors chat's ChatError).
// Carries the status + gate so the catch site returns the right wall.
export class EntitlementError extends Error {
  constructor(
    public readonly feature: string,
    public readonly gate: Gate,
    public readonly status: GateStatus,
    message: string,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

// A feature's gating rule — the per-feature permission function the design calls for.
// `entitled` answers "may THIS caller's tier use the feature?"; `gate` decides which wall
// a blocked caller hits. To put a feature behind a tier or a paywall, this is the only
// thing that changes.
export interface Rule {
  title: string; // human label (messages, docs)
  gate: Gate;
  entitled: (auth: AuthContext) => boolean;
}

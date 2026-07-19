import type { Hono } from "hono";
import type { AuthContext } from "../auth/middleware.ts";

// The a7t pillars — the family of agentic ideas a7t.chat grows through ("The name is the
// map"). Every capability belongs to exactly ONE pillar. The pillars are
// depth, not breadth: they make the chat do more FOR YOU over time, not match every feature.
export type Pillar = "assistant" | "archivist" | "architect" | "autopilot" | "autoagent";

// A capability's contextual-nudge declaration (#22 — the suggestion engine). When the recent
// conversation relates to a capability the caller ISN'T yet using, the client surfaces a subtle,
// dismissible chip pointing at it (the super-app's discoverability fix). This is a lightweight,
// content-free classifier: `triggers` are plain keywords/phrases matched (word-boundary,
// case-insensitive) against the latest exchange — no LLM, no per-turn server work. Declared HERE
// on the descriptor so a capability stays self-contained (the registry is still the only seam a
// capability touches); the engine (src/capabilities/suggest.ts) just collects the active ones.
export interface CapabilitySuggestion {
  // Keywords/phrases whose presence in the recent exchange means "this request relates to me".
  // Keep them specific to avoid Clippy-style false positives; OUR strings, never user input.
  triggers: string[];
  // Short headline for the nudge chip, e.g. "See it on a map".
  title: string;
  // One-line copy telling the user what they can do, e.g. "Ask about a place or trip…".
  body: string;
}

// A capability is a self-contained unit of assistant ability beyond plain chat
// (maps today; a companion service / a companion service / weather later). Each one plugs into three seams
// without touching the core:
//   - systemPrompt(): an instruction fragment teaching the model when to emit this
//     capability's inline marker  [[<id>:<payload>]]  (see ../capabilities/registry).
//   - routes: a Hono sub-app mounted at /api/cap/<id> (already behind authMiddleware).
//   - (client side) a Chip + Surface registered under the same id.
// The marker id is the contract that binds the server fragment, the backend routes,
// and the client renderer together.
export interface Capability {
  id: string; // marker id + route namespace, e.g. "map"
  title: string; // human label (settings, telemetry)
  // The pillar this capability belongs to. SOURCE OF TRUTH: groupable
  // in the UI, taggable in telemetry, drivable by the suggestion engine. The folder layout
  // (capabilities/<pillar>/<capability>) mirrors this for human navigation only.
  pillar: Pillar;
  enabled: boolean; // flip off to remove it everywhere at once
  systemPrompt?: () => string; // injected into the chat system prompt when enabled
  routes?: Hono; // mounted at /api/cap/<id>
  // Optional contextual-nudge triggers (#22). When set, the caller's ACTIVE (enabled + entitled)
  // suggestions ride /api/me and the client surfaces a dismissible chip if the recent exchange
  // matches. Omit it and the capability contributes no nudge — a first-class shape.
  suggestion?: CapabilitySuggestion;
  // Entitlement seam (the tiers/paywall foundation). Whether THIS caller's tier may use
  // the capability; defaults to everyone today. server.ts auto-gates the routes on this,
  // so a premium capability only needs to set this (and optionally `gate`) — no core
  // changes. See src/entitlements/.
  entitled?: (auth: AuthContext) => boolean;
  // Which wall a non-entitled caller hits: "paywall" (402, an upgrade) or "forbidden"
  // (403, a hard tier lock). Defaults to "forbidden".
  gate?: "paywall" | "forbidden";
}

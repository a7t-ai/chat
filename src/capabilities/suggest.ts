import type { AuthContext } from "../auth/middleware.ts";
import { enabledCapabilities } from "./registry.ts";
import type { Capability } from "./types.ts";

// Capability suggestion engine (#22) — the SERVER half. Capabilities declare their nudge triggers
// on the registry descriptor (`suggestion`); this collects the ones the caller can ACTUALLY use
// into a flat, serializable hint list that rides /api/me. The client does the cheap text matching
// locally (see web/src/lib/suggestions.ts), so the hot chat route is never touched and no message
// content leaves the box for matching. Deliberately fail-safe: a capability the caller isn't
// entitled to contributes nothing, so we never nudge toward a wall.

// One capability's nudge, flattened for the wire (carries the marker id so the client can also
// suppress the nudge when the reply already used that marker).
export interface SuggestionHint {
  id: string;
  title: string;
  body: string;
  triggers: string[];
}

// The caller's active contextual-nudge set: every ENABLED capability that declares a suggestion
// AND that this caller is entitled to. Entitlement is re-checked here (mirrors requireCapability)
// so a premium/gated capability never surfaces a nudge to someone who'd hit its paywall. `caps`
// defaults to the live enabled registry; it's injectable so the entitlement branch is unit-testable.
export function activeSuggestions(auth: AuthContext, caps: Capability[] = enabledCapabilities()): SuggestionHint[] {
  const out: SuggestionHint[] = [];
  for (const cap of caps) {
    const s = cap.suggestion;
    if (!s) continue;
    // A capability with no `entitled` predicate is open to everyone (the default).
    if (cap.entitled && !cap.entitled(auth)) continue;
    out.push({ id: cap.id, title: s.title, body: s.body, triggers: s.triggers });
  }
  return out;
}

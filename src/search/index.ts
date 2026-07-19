import type { AuthContext } from "../auth/middleware.ts";
import { config } from "../config.ts";
import { can } from "../entitlements/index.ts";
import { selectProvider } from "./providers.ts";

// Public surface of the web-search ("Research") capability. The chat route calls
// `runWebSearch`; entitlement + availability are decided here so both the route and
// `/api/me` (which tells the client whether to show the toggle) agree.

export { runWebSearch } from "./service.ts";
export type { SearchOutcome, SearchStage } from "./service.ts";
export type { Source } from "./types.ts";

// A usable provider is configured (a key, or a self-hosted SearXNG URL) and the feature
// isn't globally disabled. Until this is true the toggle stays hidden everywhere.
export function isSearchConfigured(): boolean {
  return config.search.enabled && selectProvider() !== null;
}

// The active provider's name (for telemetry / setup messaging), or null when none.
export function searchProviderName(): string | null {
  return selectProvider()?.name ?? null;
}

// Premium gate seam. Admins (the owner) always have web search; guests only when it's
// explicitly opened to them. This now delegates to the central entitlements catalog (the
// `research` feature), so web search is gated the same way as every other feature — and a
// subscription check replaces the rule in one place (see src/entitlements/).
export function searchEntitled(auth: AuthContext): boolean {
  return can(auth, "research");
}

// Whether THIS caller can actually use web search right now (configured + entitled).
// Drives both the `/api/me` flag (show the toggle) and the server-side guard (defense in
// depth — never trust the client to have hidden it).
export function searchAvailableFor(auth: AuthContext): boolean {
  return isSearchConfigured() && searchEntitled(auth);
}

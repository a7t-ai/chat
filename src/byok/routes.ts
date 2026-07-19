import { Hono } from "hono";
import { requireFeature } from "../entitlements/index.ts";
import {
  ByokError,
  byokAvailable,
  configuredProviders,
  deleteProviderKey,
  listProviderKeys,
  setProviderKey,
} from "./service.ts";
import { providerCatalog } from "./providers.ts";

// BYOK key management (#14). Mounted at /api/byok, already behind the auth gate. EVERY route is
// walled by the `byok` entitlement (a paywall — 402 for a non-entitled caller), so managing keys
// is itself the paid feature; the runner re-checks entitlement on use too (see resolveTurnBackend).
// Keys are always scoped to the authenticated caller (auth.user.id) — there is no route that names
// another user, so cross-account access is impossible. Responses are masked (provider + last4);
// plaintext is never returned.
const byok = new Hono();

byok.use("*", requireFeature("byok"));

// Guard the write/read surface when BYOK isn't configured on the server (no encryption key). This
// is distinct from the entitlement wall: the caller may be entitled, but the feature is dark.
// GET still succeeds (so the UI can show "not configured"); mutations return 503.

// The caller's BYOK state: whether the server has it configured, the provider catalog to offer,
// and the caller's own already-configured keys (masked).
byok.get("/", (c) => {
  const auth = c.get("auth");
  return c.json({
    available: byokAvailable(),
    providers: providerCatalog(),
    keys: listProviderKeys(auth.user.id),
  });
});

// Set (or replace) the caller's key for a provider. Body: `{ key }`. Validation + encryption live
// in the service; a rejection surfaces as its ByokError status (400 bad provider/key, 503 dark).
byok.put("/:provider", async (c) => {
  const auth = c.get("auth");
  const provider = c.req.param("provider");
  const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
  if (typeof body.key !== "string") return c.json({ error: "key is required" }, 400);
  try {
    const stored = setProviderKey(auth.user.id, provider, body.key);
    return c.json({ ok: true, key: stored });
  } catch (e) {
    if (e instanceof ByokError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// Remove the caller's key for a provider. Idempotent — removing a key that isn't there is `ok`
// with `removed: false`, never an error (no existence oracle needed; it's the caller's own row).
byok.delete("/:provider", (c) => {
  const auth = c.get("auth");
  const provider = c.req.param("provider");
  const removed = deleteProviderKey(auth.user.id, provider);
  return c.json({ ok: true, removed });
});

export default byok;

// Re-exported for /api/me's presence hint (which providers the caller has connected).
export { configuredProviders };

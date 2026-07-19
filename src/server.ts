import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import adminRoutes from "./admin/routes.ts";
import authRoutes from "./auth/routes.ts";
import { authMiddleware } from "./auth/middleware.ts";
import { wallPage } from "./auth/wall.ts";
import billingRoutes from "./billing/routes.ts";
import byokRoutes, { configuredProviders } from "./byok/routes.ts";
import { byokAvailable } from "./byok/service.ts";
import { enabledCapabilities } from "./capabilities/registry.ts";
import { activeSuggestions } from "./capabilities/suggest.ts";
import chatRoutes from "./chat/routes.ts";
import filesRoutes from "./files/routes.ts";
import memoryRoutes from "./memory/routes.ts";
import modelsRoutes from "./models/routes.ts";
import shareRoutes from "./share/routes.ts";
import sttRoutes from "./stt/routes.ts";
import { streamingDictationAvailable } from "./stt/service.ts";
import { config } from "./config.ts";
import { db } from "./db/index.ts";
import { users } from "./db/schema.ts";
import { can, featureMap, requireCapability } from "./entitlements/index.ts";
import { searchAvailableFor } from "./search/index.ts";
import { webauthnAvailable } from "./auth/webauthn/config.ts";
import { listDirectory } from "./settings/directory.ts";
import { setHandle } from "./settings/handle.ts";
import { mergePreferences, parseStoredPreferences, serializePreferences } from "./settings/preferences.ts";
import { selfProfile } from "./settings/profile.ts";

const app = new Hono();

// Public health probe (container healthchecks).
app.get("/health", (c) => c.json({ ok: true, service: "a7t-chat", ts: Date.now() }));

// API gate: session cookie -> owner-admin (stored role='admin' — the first non-edge passkey sign-up,
// #191) or account (passkey login) · local bootstrap -> admin · neither -> 401. A public-edge request
// is never admin.
// Only /api is gated; the SPA shell is public and renders the wall/login itself.
app.use("/api/*", authMiddleware);

// Cap request bodies so a single caller can't exhaust memory or amplify the whisper backend
// (the ceiling fits an audio upload for /transcribe; JSON endpoints are far smaller). Without
// this, /chat and /transcribe accepted unbounded bodies.
app.use(
  "/api/*",
  bodyLimit({ maxSize: 30 * 1024 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) }),
);

app.get("/api/me", (c) => {
  const auth = c.get("auth");
  // The caller's own plan for the profile card (#12). Derived from the same tier the chat path
  // enforces. It exposes only the caller's own data, so it belongs on this ungated identity route.
  const profile = selfProfile(auth);
  return c.json({
    role: auth.role,
    via: auth.via,
    // Account users are identified by email (their `login` is a synthetic slug); admin/guest
    // by login. Include both shapes so the client can branch without breaking either.
    user: {
      id: auth.user.id,
      login: auth.user.login,
      email: auth.user.email ?? null,
      displayName: auth.user.displayName,
      // User-chosen public handle (#189) — null until the user sets one. The client's display
      // precedence prefers it (handle → displayName → …) so a passkey account's synthetic
      // `acct_<uuid>` login is never shown, and the directory (#190) + invites (#177) read it here.
      handle: auth.user.handle ?? null,
    },
    // Whether an account has been granted access. Passkey sign-up grants it directly, so this is
    // normally true; it stays false only for a legacy never-granted row (always true for admin).
    accessGranted: auth.role === "account" ? auth.accessGranted : true,
    // Self-service profile (#12): the caller's plan tier ("owner" | "free" | …). Drives the in-app
    // profile card. Owner data only — never another account's, and never their email beyond the
    // `user` block already here. The usage meter was dropped (#186).
    plan: profile.plan,
    // Legacy field kept for shape stability — the guest-key/Bearer path is retired, so `key` is
    // always null now (admin + account both carry no key).
    key: null,
    theme: auth.user.theme ?? null,
    lang: auth.user.lang ?? null,
    // Account-synced customization (persona/behavior/visual/accessibility, #11). Always the
    // normalized shape — a null/corrupt column degrades to defaults, so the client never has
    // to defend against a missing field.
    preferences: parseStoredPreferences(auth.user.preferences),
    env: config.appEnv, // "production" | "staging" — the UI shows a badge when not prod
    // Web search ("Research"): whether this caller may use it (configured + entitled).
    // The composer shows the toggle only when available; the server re-checks anyway.
    search: { available: searchAvailableFor(auth) },
    // Bring-your-own-key (#14): whether the server has BYOK configured, and — only for an
    // entitled caller — which providers they've connected (masked provider ids). Drives the BYOK
    // settings panel; `features.byok` carries the pure entitlement. Never lists another account's
    // keys, and the array is empty for anyone without the paywall entitlement.
    byok: {
      available: byokAvailable(),
      providers: can(auth, "byok") ? configuredProviders(auth.user.id) : [],
    },
    // Passkey (WebAuthn) sign-in (#20): whether the server has passkeys configured (WEBAUTHN_RP_ID
    // set). Drives the in-app passkey manager entry point; the login button reads the same signal
    // from the public /api/auth/passkey/available probe (this route is post-auth). Dark ⇒ false.
    passkeys: { available: webauthnAvailable() },
    // Live dictation / streaming STT (#71): whether the server has a streaming ASR backend
    // configured (STREAMING_STT_URL set). DARK ⇒ false, and the composer shows only the existing
    // batch Whisper mic. When available the composer offers the live "text as you speak" mic that
    // streams partials into the field; the /api/dictate route re-checks this server-side.
    dictation: { available: streamingDictationAvailable() },
    // Per-feature entitlements for THIS caller — a hint the client uses to show/hide
    // entry points. Every value is re-checked server-side on use, so it's never the
    // enforcement (see src/entitlements/). `features.research` is pure tier entitlement;
    // `search.available` additionally requires a provider to be configured.
    features: featureMap(auth),
    // Capability suggestion engine (#22): the caller's ACTIVE contextual-nudge set (enabled +
    // entitled capabilities that declare one). The client matches these against the latest
    // exchange locally — content-free, no per-turn server work — and surfaces a dismissible chip.
    suggestions: activeSuggestions(auth),
  });
});

// Account-synced settings (theme + UI language). Persisting them server-side is what
// "broadcasts" a preference to the user's other instances: each one reads it back from
// /api/me on load.
app.put("/api/settings", async (c) => {
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => ({}))) as {
    theme?: string;
    lang?: string;
    preferences?: unknown;
  };
  const patch: { theme?: string; lang?: string; preferences?: string } = {};
  if (typeof body.theme === "string") patch.theme = body.theme;
  if (typeof body.lang === "string") patch.lang = body.lang;
  // Customization (#11): merge the (possibly partial) patch onto the stored, normalized
  // preferences and persist the full normalized JSON. `mergePreferences` bounds every field,
  // so an oversized/malformed payload can neither bloat the persona prompt nor land junk in
  // the column. `preferences` present but not an object still round-trips to the current value.
  if ("preferences" in body) {
    const current = parseStoredPreferences(auth.user.preferences);
    patch.preferences = serializePreferences(mergePreferences(current, body.preferences));
  }
  if (Object.keys(patch).length > 0) {
    db.update(users).set(patch).where(eq(users.id, auth.user.id)).run();
  }
  return c.json({ ok: true });
});

// Set / change the caller's public handle (#189) — a dedicated route (not folded into
// PUT /api/settings) so it can return real HTTP status codes: 400 for a charset/length reject,
// 409 for a collision. `setHandle` is the authority — it validates (charset + length), lowercases
// to the canonical form, pre-checks uniqueness for a friendly error, and writes SCOPED to the
// caller (auth.user.id), so a caller can only ever set their OWN handle. The `lower(handle)` UNIQUE
// index is the real backstop behind the pre-check. On success the client patches `me` locally (and
// re-reads /api/me on next load), so the account menu + profile card reflect the new handle.
app.put("/api/settings/handle", async (c) => {
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => ({}))) as { handle?: unknown };
  const result = setHandle(auth.user.id, body.handle);
  if (result.ok) return c.json({ ok: true, handle: result.handle });
  // charset/length are a bad request (400); a name collision is a conflict (409).
  return c.json({ ok: false, error: result.error }, result.error === "taken" ? 409 : 400);
});

// User directory (#190) — "find each other on this instance." Any authenticated caller may browse;
// `listDirectory` returns ONLY public identity fields (handle + a public display name + the stable
// user id) for accounts that opted in by setting a handle, scoped to EXCLUDE the caller and always
// bounded (optional `?q=` search over handle + display name, hard-capped at DIRECTORY_LIMIT). It
// never touches email/login/plan/usage, so nothing private can leak. Reusable for the identity-bound
// collaboration invite picker (#177). Defined inline (like /api/me) so it registers before the chat
// routes and can't be shadowed by /api/:something.
app.get("/api/users", (c) => {
  const auth = c.get("auth");
  return c.json({ users: listDirectory(auth.user.id, c.req.query("q")) });
});

// Account auth (#169) — passkey sign-up + sign-in. The public passkey ceremonies + availability
// probe are carved out of the gate in authMiddleware (the front door); logout is public + idempotent;
// register/list/delete run under the gate. Mounted before chat so /api/auth matches first.
app.route("/api/auth", authRoutes);

// Admin (account management + telemetry) — registered before the chat routes so /api/admin matches first.
app.route("/api/admin", adminRoutes);

// PUBLIC shareable-live-collab read path (no-login "watch it build"). Mounted before the
// chat routes; the auth gate carves out GET /api/share/* so a watcher needs no credential.
// All mutations (share / unshare) stay on the gated /api/conversations/:id/share endpoints.
app.route("/api/share", shareRoutes);

// Bring-your-own-key management (#14). Mounted before the chat routes so /api/byok matches first;
// every route is walled by the `byok` entitlement (paywall) inside the sub-app.
app.route("/api/byok", byokRoutes);

// Plans / billing (#13). Mounted before the chat routes so /api/billing matches first. The pricing
// view + checkout start run under the auth gate (any authenticated account may view/upgrade); the
// PUBLIC provider webhook (POST /api/billing/webhook) is carved out of the gate in authMiddleware
// and bounded entirely by its HMAC signature.
app.route("/api/billing", billingRoutes);

// Attachments / file manager (#15). Mounted before the chat routes so /api/files matches first;
// every route is gated on the `files` entitlement + scoped to the caller inside the sub-app.
app.route("/api/files", filesRoutes);

// Archivist memory management (#27). Mounted before the chat routes so /api/memory matches first;
// authed (the caller's own account) but NOT entitlement-gated — memory is a core, free pillar. Lets
// a user see, forget one, or forget all of what a7t.chat durably remembers; the on/off switch rides
// preferences (memory.enabled).
app.route("/api/memory", memoryRoutes);

// Model capability catalog (#63). Mounted before the chat routes so the enriched GET
// /api/models/catalog matches here, while the existing minimal GET /api/models (id+label+default,
// still used by the current picker) stays on the chat routes below — distinct paths, no collision.
app.route("/api/models", modelsRoutes);

// Live dictation / streaming STT (#71). Mounted before the catch-all chat routes so /api/dictate
// matches here. DARK by default (503) until STREAMING_STT_URL is set; the batch /transcribe route
// (inside chatRoutes) stays the untouched fallback.
app.route("/api/dictate", sttRoutes);

// Capability #1: chat (Jano client + streaming + /model).
app.route("/api", chatRoutes);

// Pluggable capabilities (maps, …) — each mounts its routes at /api/cap/<id>, already
// behind authMiddleware. Adding one to the registry wires it up here automatically. Each
// capability's routes are also gated on its entitlement seam, so a tier/premium
// capability is walled by the foundation without any per-route changes.
for (const cap of enabledCapabilities()) {
  if (!cap.routes) continue;
  const gated = new Hono();
  gated.use("*", requireCapability(cap));
  gated.route("/", cap.routes);
  app.route(`/api/cap/${cap.id}`, gated);
}

// Staging-only: serve design docs as HTML for reading on device (rendered into ./docs-html/
// out of band). Gated to staging by config.appEnv, so it never registers on prod. Temporary —
// remove when no longer needed.
if (config.appEnv === "staging") {
  app.get("/docs/:name", async (c) => {
    const name = c.req.param("name");
    if (name !== "vision" && name !== "autoagent") return c.notFound();
    const f = Bun.file(`${process.cwd()}/docs-html/${name}.html`);
    return (await f.exists()) ? c.html(await f.text()) : c.notFound();
  });
}

// Static SPA (public). The app calls /api/me and shows the wall/login when unauthenticated.
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("*", async (c) => {
  const index = Bun.file("./web/dist/index.html");
  return (await index.exists()) ? c.html(await index.text()) : c.html(wallPage());
});

console.log(`a7t-chat listening on http://${config.bindHost}:${config.port}`);

export default {
  port: config.port,
  hostname: config.bindHost,
  // Bun's default idleTimeout is 10s, which severs streaming generations that take
  // longer (model swaps, long replies). Max it out — SSE keeps the connection active.
  idleTimeout: 255,
  fetch: app.fetch,
};

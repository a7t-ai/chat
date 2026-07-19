import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import type { User } from "../db/schema.ts";
import { SESSION_COOKIE } from "./cookie.ts";
import { validateSession } from "./session.service.ts";

// The two LIVE auth contexts. The guest-key/Bearer tier was RETIRED, and email OTP + invites were
// removed (#169) — passkey sign-up is now the account credential — so `account` is the only non-admin
// tier. `key` is kept on the union (always null) so the many `auth.key` read sites and /api/me stay
// shape-stable without a churn of edits.
//
// Admin (#191) is the single "owner". It is conferred two ways ONLY: `via: "owner"` — the passkey
// account that STORED `role='admin'` because it was the FIRST account created via the private
// (non-edge) path (the blanket Tailscale-header auto-admin was REMOVED); or `via: "dev"` — the
// LOCAL-only break-glass bootstrap. Neither is ever reachable via the public edge.
export type AuthContext =
  | { role: "admin"; via: "owner" | "dev"; user: User; key: null }
  // Passkey-login account. `accessGranted` mirrors `user.accessGrantedAt != null`. Passkey sign-up
  // grants access DIRECTLY, so every new account is granted; this stays a safety net for any legacy
  // never-granted account row (whose stale session must NOT silently gain access) — it may reach ONLY
  // the logout/me endpoints, every other /api/* route is walled.
  | { role: "account"; via: "session"; user: User; key: null; accessGranted: boolean };

// Endpoints an authenticated-but-ungated account (a legacy never-granted row) may still hit.
// Everything else under /api is blocked for them — there is no self-service grant path anymore
// (recovery is admin/owner-only, #169), so this stays purely a defensive floor.
const UNGATED_ALLOWLIST = ["/api/auth/logout", "/api/me"];

// The PUBLIC auth endpoints — reachable with NO credential at all. logout is public + idempotent:
// it only destroys the caller's OWN cookie token, so a stale/expired session clicking "log out" must
// succeed, not hit the wall. (The passkey sign-up/sign-in ceremonies are the other front door, carved
// out just below, but PRIVATE-PATH only, never reachable over the public edge.)
const PUBLIC_AUTH_PATHS = ["/api/auth/logout"];

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

// Get-or-create the LOCAL bootstrap admin (`DEV_ADMIN_LOGIN`). The removed Tailscale path used to
// share this; now ONLY the break-glass bootstrap does. It creates/promotes a login-keyed admin row so
// a fresh instance can be operated before an owner handle exists.
function getOrCreateAdmin(login: string, displayName: string | null): User {
  const found = db.select().from(users).where(eq(users.login, login)).get();
  if (found) {
    if (found.role !== "admin") {
      db.update(users).set({ role: "admin" }).where(eq(users.id, found.id)).run();
      return { ...found, role: "admin" };
    }
    return found;
  }
  const created = db
    .insert(users)
    .values({ login, displayName, role: "admin" })
    .returning()
    .get();
  if (!created) throw new Error("failed to create admin user");
  return created;
}

// Public-edge discriminator (#191) — the hard non-admin rule, and the SINGLE definition both the auth
// gate AND the passkey sign-up owner-bootstrap (`createPasskeyAccount`) consult, so the two can never
// diverge. cloudflared injects `cf-connecting-ip` on every proxied request and a client cannot strip
// it; the private (Tailscale Serve / loopback) path has no such header. Its presence — or a configured
// edge marker — means "arrived via the public edge" ⇒ can NEVER be admin, and can never claim the
// owner slot at sign-up. With the app bound to 127.0.0.1, the only ingresses are the private path (no
// marker) and cloudflared (marker present), so this discriminator is sound.
export function isViaEdge(c: Context): boolean {
  const a = config.auth;
  return (
    c.req.header("cf-connecting-ip") !== undefined ||
    (a.edgeMarkerSecret.length > 0 && c.req.header(a.edgeMarkerHeader) === a.edgeMarkerSecret)
  );
}

// The auth gate, in order:
//   0. public carve-outs          -> admitted with no credential (logout always; passkey ceremonies
//                                    only on the private path, NOT via the public edge; share reads +
//                                    todo write + billing webhook + map reads)
//   1. dev bootstrap (break-glass) -> admin   (LOCAL only: DEV_ADMIN_LOGIN set + NOT via the edge)
//   2. session cookie             -> owner-admin if the user's STORED role is 'admin' and NOT via the
//                                    edge (#191), else the account user (passkey sign-up/sign-in) (+ access floor)
//   3. neither                    -> the wall
//
// The blanket Tailscale-header auto-admin was REMOVED (#191): there is no tailnet auto-admin. Everyone
// authenticates via passkey (#169); admin is ONLY the owner account — the FIRST passkey account created
// via the private (non-edge) path, which stored `role='admin'` at sign-up (see createPasskeyAccount in
// webauthn/routes.ts) — resolved on its session, or the local bootstrap. The Bearer/guest-key tier was
// RETIRED and email OTP + invites were removed (#169), so `account` (passkey login) is the only
// non-admin tier.
//
// PUBLIC carve-out: logout is always reachable with NO credential; the passkey sign-up/sign-in
// ceremonies are the front door for a brand-new visitor (nothing to authenticate with yet) but ONLY
// on the private (non-edge) path: the public edge must never create or log into an account (this
// instance is private). They're admitted before the tier checks, the passkey ones gated on `!viaEdge`.
//
// Public-edge discriminator (the hard non-admin rule): cloudflared injects `cf-connecting-ip` on
// every proxied request and a client cannot strip it; the Tailscale Serve / loopback path has no such
// header. Its presence (or a configured edge marker) means "arrived via the public edge" -> can NEVER
// be admin. With the app bound to 127.0.0.1, the only ingresses are the private path (no marker) and
// cloudflared (marker present), so BOTH admin paths (owner session + dev bootstrap) are gated on
// `!viaEdge` and a public request is never admin.
export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const a = config.auth;
  const path = c.req.path;

  // Public logout — no credential required (idempotent, clears only the caller's own cookie).
  if (PUBLIC_AUTH_PATHS.includes(path)) return next();

  // Public-edge discriminator (the hard non-admin rule), computed UP-FRONT because the passkey
  // carve-out just below now consults it too. cloudflared injects `cf-connecting-ip` (or a configured
  // edge marker) on every proxied request and a client cannot strip it; its presence means the request
  // arrived via the public edge. Reuses the shared `isViaEdge` helper (the SAME check the passkey
  // sign-up owner-bootstrap uses), so the gate can never diverge from it. The admin tiers below reuse
  // this same value.
  const viaEdge = isViaEdge(c);

  // Passkey (WebAuthn) sign-up / sign-in (#20, #169): the passwordless front door, but PRIVATE-PATH
  // ONLY. The availability probe, the SIGN-UP ceremony (creates a new account + session), and the
  // SIGN-IN ceremony (mints a session for an existing credential) are reachable with NO credential,
  // but ONLY when the request did NOT arrive via the public edge (`!viaEdge`). WHY: this hosted
  // instance is private (owner + tailnet only); the public cloudflared edge must serve only read-only
  // shares (and later a landing page), never account creation or login. The owner claim at sign-up
  // ALREADY required `!viaEdge` (createPasskeyAccount stamps only the first NON-EDGE account
  // `role='admin'`), so leaving sign-up / sign-in / availability reachable over the edge was the gap:
  // it let anyone on the public internet create or log into an account. Over the edge these paths now
  // fall through to the normal gate and hit the 401 wall (no account creation, no login, not even the
  // availability probe). TIGHTLY bounded to these exact paths; every OTHER passkey route (authed
  // register / list / delete) stays behind the gate below. signup/verify creates an account ONLY on a
  // valid attestation; login/verify mints a session ONLY on an assertion signed by a stored
  // credential's key.
  if (
    !viaEdge &&
    ((c.req.method === "GET" && path === "/api/auth/passkey/available") ||
      (c.req.method === "POST" &&
        (path === "/api/auth/passkey/signup/options" ||
          path === "/api/auth/passkey/signup/verify" ||
          path === "/api/auth/passkey/login/options" ||
          path === "/api/auth/passkey/login/verify")))
  ) {
    return next();
  }

  // Public share viewing — the no-login "watch it build in real time" wedge. READ-ONLY GET
  // endpoints under /api/share/* are reachable with NO credential: the share link IS the
  // capability. The carve-out is GET-only (sharing / unsharing live under the gated
  // /api/conversations/:id/share), and the share routes themselves resolve the slug + 404 an
  // unknown/revoked one, so nothing private leaks. This never touches the admin edge-trust
  // discriminator below; it only admits read traffic that the owner explicitly opted to make
  // public.
  if (c.req.method === "GET" && path.startsWith("/api/share/")) return next();

  // Public TODO-completion write (#45) — the ONE unauthenticated mutation, admitted here as a
  // TIGHTLY bounded sibling of the read carve-out above. Only `POST /api/share/<slug>/todo`
  // matches (nothing else under /api/share is writable). It carries no auth context; the route
  // enforces a temporary, slug-bound write token + a per-token rate limit BEFORE any DB access,
  // and the write itself can only flip a checkbox on that share's conversation — never arbitrary
  // content, never another route. Like the GET carve-out, it sidesteps the admin discriminator.
  if (c.req.method === "POST" && /^\/api\/share\/[^/]+\/todo$/.test(path)) return next();

  // Public billing webhook (#13) — the provider POSTs subscription changes here; it holds no
  // session, so it must reach the route with NO credential. TIGHTLY bounded: only the exact
  // `POST /api/billing/webhook` matches (nothing else under /api/billing is public — the pricing
  // view + checkout start stay behind the gate). It carries no auth context; the route fails closed
  // on an unconfigured secret and verifies an HMAC signature over the raw body BEFORE any DB access,
  // and the write can only flip a role='account' plan — never arbitrary content. Like the share
  // carve-outs, it never touches the admin edge-trust discriminator below.
  if (c.req.method === "POST" && path === "/api/billing/webhook") return next();

  // Public map read-path — powers the no-login shared page's map (Maps is a free, untiered
  // capability). GET-only, and only the three READ-ONLY map routes: the place->coords geocode
  // proxy, the basemap-availability probe, and the basemap tile archive. These carry NO user
  // data — geocoding is a public place-name lookup (already rate-limited) and the tiles are a
  // public basemap — so admitting anonymous GETs lets a shared-page watcher place map pins and
  // load the basemap without an account. The basemap already CDN-falls-back client-side
  // (MapCanvas `resolveStyle`), but geocoding has no fallback, so without this the pins can't
  // resolve. GET-only and matched to these exact paths: no other /api/cap/* route (and no
  // non-GET) is carved out — the capability's write/model surface stays fully gated. Like the
  // share carve-outs, this never touches the admin edge-trust discriminator below.
  if (
    c.req.method === "GET" &&
    (path === "/api/cap/map/geo" || path === "/api/cap/map/basemap-status" || path === "/api/cap/map/basemap.pmtiles")
  ) {
    return next();
  }

  // `viaEdge` (the hard non-admin discriminator) is computed up-front above: the SAME check the
  // passkey sign-up owner-bootstrap uses, so a public request can never be admin here nor claim the
  // owner slot there. The admin tiers below reuse it.

  // Break-glass bootstrap (LOCAL only): DEV_ADMIN_LOGIN grants admin so a fresh instance can be
  // operated before an owner handle exists. NEVER honored via the public edge, and left empty in
  // production. (The blanket Tailscale-header auto-admin that used to sit above this was removed in
  // #191 — there is no tailnet auto-admin anymore.)
  if (a.devAdminLogin.length > 0 && !viaEdge) {
    const user = getOrCreateAdmin(a.devAdminLogin, "Dev Admin");
    c.set("auth", { role: "admin", via: "dev", user, key: null });
    return next();
  }

  // Session cookie -> owner-admin or account user (passkey sign-up/sign-in). A valid, unexpired
  // session identifies the user. The owner is the account that STORED `role='admin'` at sign-up (the
  // first passkey account created via the private path, #191) — it resolves to admin here, but NEVER
  // via the public edge, so this rides the SAME `!viaEdge` discriminator the removed Tailscale path
  // used, keeping "a public request is never admin" byte-for-byte intact (a stored-admin user hitting
  // the public edge is deliberately treated as a plain account). It deliberately does NOT depend on
  // `accessGrantedAt`: the owner can always get in and can't be locked out by a stray access-flag
  // state. Owner-TRANSFER is not built (a future admin action); if the owner row is deleted, the next
  // non-edge sign-up claims the vacant slot (an acceptable self-host re-bootstrap).
  //
  // Everyone else is a plain account. Passkey sign-up grants access directly, so a live account is
  // normally granted; the `accessGrantedAt` floor stays as defense-in-depth — a legacy never-granted
  // row with a stale session may reach ONLY the logout/me endpoints (every other /api/* is 403'd),
  // and there is no self-service grant path anymore (recovery is admin/owner-only).
  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (sessionToken) {
    const userId = validateSession(sessionToken);
    if (userId) {
      const user = db.select().from(users).where(eq(users.id, userId)).get();
      if (user) {
        if (user.role === "admin" && !viaEdge) {
          c.set("auth", { role: "admin", via: "owner", user, key: null });
          return next();
        }
        const accessGranted = user.accessGrantedAt != null;
        c.set("auth", { role: "account", via: "session", user, key: null, accessGranted });
        if (!accessGranted && !UNGATED_ALLOWLIST.includes(path)) {
          return c.json({ error: "account_inactive" }, 403);
        }
        return next();
      }
    }
  }

  return c.json(
    { error: "credential required", message: "The chat is currently being tested. Ask Leo for a credential at leo@a7t.ai :)" },
    401,
  );
}

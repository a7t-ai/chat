import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { clearSessionCookie, SESSION_COOKIE } from "./cookie.ts";
import { destroySession } from "./session.service.ts";
import passkeyRoutes from "./webauthn/routes.ts";

// Account auth, mounted under /api/auth. Passkeys are the ONLY account credential (#169) — email OTP
// + invites were removed. The public passkey sign-up + sign-in ceremonies (and the availability
// probe) are carved out of the gate in auth/middleware.ts (the front door); the register/list/delete
// routes stay behind it. `logout` is public + idempotent (it only destroys the caller's OWN cookie
// token, so a stale/expired session clicking "log out" must succeed, not hit the wall).
const auth = new Hono();

// POST /logout — destroy the session + clear the cookie.
auth.post("/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) destroySession(token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// Passkey (WebAuthn) auth (#20, #169), mounted at /api/auth/passkey. The public sign-up/sign-in
// ceremonies + availability probe are carved out of the gate in auth/middleware.ts (the front door);
// register/list/delete stay behind it (an authenticated account manages its own credentials).
auth.route("/passkey", passkeyRoutes);

export default auth;

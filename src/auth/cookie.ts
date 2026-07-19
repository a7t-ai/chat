import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { SESSION_TTL_DAYS } from "./session.service.ts";

// The session cookie. One name + one set of flags, defined once so the set/clear paths can
// never drift apart. SECURITY: the cookie holds the opaque session token (only its hash is
// stored server-side) and is locked down:
//   - httpOnly  : JS can't read it → XSS can't exfiltrate the session
//   - secure    : sent only over HTTPS (the app is fronted by Tailscale Serve / cloudflared,
//                 both TLS) so it never leaks over cleartext
//   - sameSite  : "Lax" → not sent on cross-site POSTs (CSRF defense) but survives top-level
//                 navigations back to the app
//   - path "/"  : the whole app
//   - maxAge    : SESSION_TTL_DAYS, matching the server-side session expiry
export const SESSION_COOKIE = "a7t_session";

const MAX_AGE_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  // Mirror the attributes so the clearing Set-Cookie matches the original (browsers key the
  // delete on name + path).
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, sameSite: "Lax" });
}

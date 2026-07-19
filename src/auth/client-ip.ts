import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

// The TRUSTED client IP, derived server-side — the single source the OTP service's per-IP
// rate limits key on. SECURITY-CRITICAL (otp.service contract (a)):
//
//   - When the request arrived via the PUBLIC EDGE, cloudflared injects `cf-connecting-ip`
//     with the real client IP and a public client cannot strip it (it is added at the
//     origin). So when that header is present we trust it.
//   - Otherwise the request came over Tailscale Serve straight to the 127.0.0.1 bind, so the
//     authentic peer is the live socket address (Bun's `server.requestIP`, surfaced by Hono's
//     Bun adapter via getConnInfo).
//   - We NEVER read `x-forwarded-for`: it is client-spoofable, so honoring it would let an
//     attacker forge a fresh IP per request and walk straight past every per-IP cap.
//
// KNOWN LIMITATION (DEFERRED — owner decision, not fixed here): on the Tailscale-Serve path
// `cf-connecting-ip` is client-SETTABLE (only the public cloudflared edge injects it
// authentically; the loopback/Tailscale path has no proxy stripping it). A client that
// reaches the origin over Tailscale Serve and sets its own `cf-connecting-ip` is treated as
// "via edge" and can rotate that value per request, EVADING the per-IP OTP caps on that
// path. The per-EMAIL caps still apply (and are the account-existence-safe limit). The real
// remediation is the listener-separation owner-decision (a server-set, per-listener signal
// can't be forged) — not a patch to this header logic.
//
// Returns `null` when the IP can't be determined. The OTP service treats null as NON-local
// (subject to IP limits) — a blank IP must never become a rate-limit bypass.
export function trustedClientIp(c: Context): string | null {
  // Edge path: cloudflared's header wins. Presence (not value) marks "via the public edge";
  // an empty value still means the edge added it, so we only fall through on a real address.
  const cf = c.req.header("cf-connecting-ip");
  if (cf !== undefined) {
    const trimmed = cf.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  // Tailscale Serve path: the live socket peer. getConnInfo throws if the Bun server handle
  // isn't on the context (e.g. a synthetic test context) — treat that as "unknown" (null),
  // never as a bypass.
  try {
    const addr = getConnInfo(c).remote.address;
    return addr && addr.length > 0 ? addr : null;
  } catch {
    return null;
  }
}

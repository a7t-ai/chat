import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

// The share write token — a temporary, write-scoped sibling of #7's public read slug (#45).
// The public watch link is read-only; ticking a TODO on the published page is the ONE write it
// allows, and it is gated by this token so a random POST cannot touch the DB.
//
// The token is a STATELESS HMAC (no table, no cleanup): `${expiresAt}.${hmac(secret,
// "<slug>.<expiresAt>")}`. Binding it to the slug (which is in the URL, so verifiable with no
// DB lookup) means an invalid/forged/expired token is rejected BEFORE any DB access — a true
// no-op, per the abuse model. Only the server (holding `secret`) can mint one, and the page
// only receives it inside the share snapshot, so possessing a token means "fetched this share's
// link recently". It expires; a leaked token is useless once past `expiresAt` and can only ever
// flip checkboxes on ITS slug (never another share, never arbitrary content).
//
// Expiry is quantized to a window so the token is STABLE across the watch page's snapshot polls
// (a fresh token every 3s would defeat the per-token rate limit). Within a STEP the minted
// token is byte-identical; validity runs 15–30 min, comfortably covering a viewer's session.

const STEP_MS = 15 * 60_000; // window granularity — the token is constant within a step
const MAX_TTL_MS = 2 * STEP_MS; // longest life a valid token may claim (forgery upper bound)

function secretOf(secret?: string): string {
  return secret ?? config.share.writeSecret;
}

function sign(slug: string, expiresAt: number, secret: string): string {
  return createHmac("sha256", secret).update(`${slug}.${expiresAt}`).digest("hex");
}

// Constant-time hex comparison — equal-length check first (timingSafeEqual throws on a length
// mismatch), so a wrong-length token fails fast without leaking timing on the compare itself.
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false; // non-hex / malformed input
  }
}

// Mint a write token for `slug`, valid for the current window. `now`/`secret` are injectable
// for tests; production uses Date.now() + the configured secret.
export function mintWriteToken(
  slug: string,
  now: number = Date.now(),
  secret?: string,
): { token: string; expiresAt: number } {
  const s = secretOf(secret);
  const expiresAt = (Math.floor(now / STEP_MS) + 2) * STEP_MS;
  return { token: `${expiresAt}.${sign(slug, expiresAt, s)}`, expiresAt };
}

// Validate a token against `slug`. False (a no-op reject) for anything malformed, expired,
// claiming an over-long life, bound to a different slug, or signed with the wrong secret — with
// NO DB access, so an invalid token never touches storage.
export function verifyWriteToken(
  slug: string,
  token: string | null | undefined,
  now: number = Date.now(),
  secret?: string,
): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  const mac = token.slice(dot + 1);
  if (!Number.isFinite(expiresAt)) return false;
  if (now >= expiresAt) return false; // expired
  if (expiresAt - now > MAX_TTL_MS) return false; // forged far-future expiry
  return safeEqualHex(mac, sign(slug, expiresAt, secretOf(secret)));
}

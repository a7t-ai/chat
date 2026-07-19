import type { Me } from "./api";

// Client mirror of the server's handle bounds (src/settings/handle.ts). The SERVER is authoritative
// — these only drive instant UX (the input's maxLength + the Save-button enable + inline hints).
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;
const HANDLE_RE = /^[a-z0-9_]+$/;

// Normalize a typed handle the same way the server does (trim + lowercase) so the client preview
// matches what will be stored.
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

// Local, pre-submit validation mirroring the server (charset + length). Returns the typed reason or
// null when the (normalized) handle looks valid. Only UX — the server still re-checks + owns
// uniqueness (`taken`), which the client can't know without asking.
export function localHandleError(raw: string): "charset" | "length" | null {
  const h = normalizeHandle(raw);
  if (h.length < HANDLE_MIN || h.length > HANDLE_MAX) return "length";
  if (!HANDLE_RE.test(h)) return "charset";
  return null;
}

// Display-name precedence (#189) — the ONE place that decides which name to show for the caller,
// so the account menu, the profile card, and any future surface agree. Order: handle → displayName
// → email → a real login → the friendly fallback. Crucially it NEVER surfaces a passkey account's
// synthetic `acct_<uuid>` login (that's an internal slug, not a human identity); an admin's real
// Tailscale login (e.g. "leo@github") still shows when nothing friendlier is set. Pure + tiny so
// it's trivially unit-tested and reused everywhere.
export function displayNameOf(user: Me["user"], fallback: string): string {
  if (user.handle) return user.handle;
  if (user.displayName) return user.displayName;
  if (user.email) return user.email;
  // A real login (admin's Tailscale identity) is fine to show; the synthetic account slug is not.
  if (user.login && !user.login.startsWith("acct_")) return user.login;
  return fallback;
}

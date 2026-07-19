import { authHeaders } from "./api";

// Passkey (WebAuthn) sign-in (#20) — the browser half. It drives the two ceremonies through
// `navigator.credentials`, converting the base64url wire shapes the server speaks to/from the
// ArrayBuffers the platform API wants, and posts the results to /api/auth/passkey/*. All the security
// checks live server-side (verify.ts); this is transport + encoding only.

export interface Passkey {
  id: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

// --- base64url <-> ArrayBuffer (the WebAuthn wire encoding) -----------------------------------
function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBuf(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Whether this browser can do WebAuthn at all. Guards the passkey affordances so they never show on
// an unsupported browser (the server availability probe covers the deploy-config side separately).
export function passkeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials &&
    typeof navigator.credentials.get === "function"
  );
}

// PUBLIC availability probe — is the server configured for passkeys (WEBAUTHN_RP_ID set)? Used by the
// pre-auth login screen to decide whether to show the passkey button. Never throws.
export async function fetchPasskeyAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/passkey/available", { credentials: "include" });
    if (!res.ok) return false;
    return ((await res.json()) as { available?: boolean }).available === true;
  } catch {
    return false;
  }
}

export async function listPasskeys(): Promise<{ available: boolean; passkeys: Passkey[] }> {
  const res = await fetch("/api/auth/passkey", { headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error(`/api/auth/passkey -> ${res.status}`);
  return (await res.json()) as { available: boolean; passkeys: Passkey[] };
}

export async function deletePasskey(id: string): Promise<void> {
  const res = await fetch(`/api/auth/passkey/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`delete-passkey -> ${res.status}`);
}

export type RegisterResult = { ok: true; passkey: Passkey } | { ok: false; reason: "unsupported" | "cancelled" | "error" };

// Register a new passkey for the signed-in account: fetch options, run the create ceremony, verify.
// A user cancelling the OS prompt is a benign "cancelled" (not an error) so the UI stays quiet.
export async function registerPasskey(label?: string): Promise<RegisterResult> {
  if (!passkeySupported()) return { ok: false, reason: "unsupported" };

  let options: Record<string, unknown>;
  try {
    const res = await fetch("/api/auth/passkey/register/options", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      credentials: "include",
    });
    if (!res.ok) return { ok: false, reason: "error" };
    options = ((await res.json()) as { options: Record<string, unknown> }).options;
  } catch {
    return { ok: false, reason: "error" };
  }

  let credential: PublicKeyCredential | null;
  try {
    const user = options.user as { id: string; name: string; displayName: string };
    const exclude = (options.excludeCredentials as { type: string; id: string }[] | undefined) ?? [];
    const publicKey = {
      ...options,
      challenge: b64urlToBuf(options.challenge as string),
      user: { ...user, id: b64urlToBuf(user.id) },
      excludeCredentials: exclude.map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
    } as unknown as PublicKeyCredentialCreationOptions;
    credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  } catch {
    return { ok: false, reason: "cancelled" };
  }
  if (!credential) return { ok: false, reason: "cancelled" };

  const response = credential.response as AuthenticatorAttestationResponse;
  const payload = {
    attestationObject: bufToB64url(response.attestationObject),
    clientDataJSON: bufToB64url(response.clientDataJSON),
    transports: typeof response.getTransports === "function" ? response.getTransports() : undefined,
    label,
  };
  try {
    const res = await fetch("/api/auth/passkey/register/verify", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, reason: "error" };
    return { ok: true, passkey: ((await res.json()) as { passkey: Passkey }).passkey };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type SignUpResult =
  | { ok: true; status: "authed" }
  | { ok: false; reason: "unsupported" | "unavailable" | "cancelled" | "error" };

// PUBLIC passkey SIGN-UP (#169) — a visitor with no account registers a passkey and the server CREATES
// their account + mints the session. No email, no invite. Mirrors registerPasskey but hits the public
// /signup/* ceremony (no auth header, no excludeCredentials — a brand-new visitor has nothing to add
// to or exclude). A cancelled OS prompt is benign; all security checks are server-side (verify.ts).
export async function signUpWithPasskey(label?: string): Promise<SignUpResult> {
  if (!passkeySupported()) return { ok: false, reason: "unsupported" };

  let options: Record<string, unknown>;
  try {
    const res = await fetch("/api/auth/passkey/signup/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
    });
    if (res.status === 503) return { ok: false, reason: "unavailable" };
    if (!res.ok) return { ok: false, reason: "error" };
    options = ((await res.json()) as { options: Record<string, unknown> }).options;
  } catch {
    return { ok: false, reason: "error" };
  }

  let credential: PublicKeyCredential | null;
  try {
    const user = options.user as { id: string; name: string; displayName: string };
    const publicKey = {
      ...options,
      challenge: b64urlToBuf(options.challenge as string),
      user: { ...user, id: b64urlToBuf(user.id) },
      excludeCredentials: [],
    } as unknown as PublicKeyCredentialCreationOptions;
    credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  } catch {
    return { ok: false, reason: "cancelled" };
  }
  if (!credential) return { ok: false, reason: "cancelled" };

  const response = credential.response as AuthenticatorAttestationResponse;
  const payload = {
    attestationObject: bufToB64url(response.attestationObject),
    clientDataJSON: bufToB64url(response.clientDataJSON),
    transports: typeof response.getTransports === "function" ? response.getTransports() : undefined,
    label,
  };
  try {
    const res = await fetch("/api/auth/passkey/signup/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, reason: "error" };
    return { ok: true, status: "authed" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type PasskeyLoginResult =
  | { ok: true; status: "authed" | "inactive" }
  | { ok: false; reason: "unsupported" | "unavailable" | "cancelled" | "error" };

// Sign in with a passkey (no email, no code): fetch a challenge, run the get ceremony, verify → the
// server mints the session cookie. Discoverable credentials, so the browser offers the account.
export async function loginWithPasskey(): Promise<PasskeyLoginResult> {
  if (!passkeySupported()) return { ok: false, reason: "unsupported" };

  let options: Record<string, unknown>;
  try {
    const res = await fetch("/api/auth/passkey/login/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
    });
    if (res.status === 503) return { ok: false, reason: "unavailable" };
    if (!res.ok) return { ok: false, reason: "error" };
    options = ((await res.json()) as { options: Record<string, unknown> }).options;
  } catch {
    return { ok: false, reason: "error" };
  }

  let assertion: PublicKeyCredential | null;
  try {
    const publicKey = {
      ...options,
      challenge: b64urlToBuf(options.challenge as string),
      allowCredentials: [],
    } as unknown as PublicKeyCredentialRequestOptions;
    assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  } catch {
    return { ok: false, reason: "cancelled" };
  }
  if (!assertion) return { ok: false, reason: "cancelled" };

  const response = assertion.response as AuthenticatorAssertionResponse;
  const payload = {
    id: assertion.id, // base64url(rawId), the credential id the server stored
    authenticatorData: bufToB64url(response.authenticatorData),
    clientDataJSON: bufToB64url(response.clientDataJSON),
    signature: bufToB64url(response.signature),
    userHandle: response.userHandle ? bufToB64url(response.userHandle) : null,
  };
  try {
    const res = await fetch("/api/auth/passkey/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, reason: "error" };
    const data = (await res.json()) as { status?: string };
    return { ok: true, status: data.status === "authed" ? "authed" : "inactive" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

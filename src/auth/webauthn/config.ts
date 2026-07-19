import { config } from "../../config.ts";

// WebAuthn / passkey config (#20). These read the environment LIVE (not the frozen `config`
// snapshot) on purpose: WEBAUTHN_RP_ID is a pure deploy toggle — set it and passkeys light up with
// no code change — and reading it live lets the tests exercise BOTH the dark and lit paths without a
// module reload. The rest of the ceremony parameters are derived here so the routes never touch env.

// The Relying Party ID — the registrable domain the app is served from (host only, no scheme/port).
// It MUST match the browser address-bar host when a passkey is registered/used. Empty ⇒ passkeys are
// DARK: no options are minted, no route verifies an assertion, and /api/me reports unavailable.
export function webauthnRpId(): string {
  return (process.env.WEBAUTHN_RP_ID ?? "").trim();
}

export function webauthnAvailable(): boolean {
  return webauthnRpId().length > 0;
}

// Display name shown in the OS passkey prompt — the fixed product name (not a secret).
export function webauthnRpName(): string {
  return "a7t.chat";
}

// The exact browser origin an assertion's clientData MUST report — derived from APP_URL (the app's
// public base URL) so it always tracks where the SPA is served. A mismatch (a passkey replayed from
// another origin) fails verification.
export function webauthnOrigin(): string {
  try {
    return new URL(config.appUrl).origin;
  } catch {
    return config.appUrl;
  }
}

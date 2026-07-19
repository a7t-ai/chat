import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "../../db/index.ts";
import { users } from "../../db/schema.ts";
import type { User } from "../../db/schema.ts";
import { trustedClientIp } from "../client-ip.ts";
import { setSessionCookie } from "../cookie.ts";
import { isViaEdge } from "../middleware.ts";
import { createSession, MAX_USER_AGENT_LENGTH } from "../session.service.ts";
import { consumeChallenge, createChallenge } from "./challenge.service.ts";
import { webauthnAvailable, webauthnOrigin, webauthnRpId, webauthnRpName } from "./config.ts";
import {
  deleteCredential,
  excludeCredentialIds,
  getCredentialByCredentialId,
  listCredentials,
  storeCredential,
  updateSignCount,
} from "./credential.service.ts";
import { bufferToBase64url, decodeClientData, verifyAuthentication, verifyRegistration, WebauthnError } from "./verify.ts";

// Passkey (WebAuthn) auth (#20, #169). Mounted at /api/auth/passkey. Passkeys are the ONLY account
// credential now — email OTP + invites were removed (#169). Three surfaces:
//   - PUBLIC SIGN-UP (carved out of the gate in auth/middleware.ts — the front door): a visitor with
//     NO account registers a passkey and that CREATES a new user with access granted directly (no
//     invite) AND mints a session. Role is decided atomically (see createPasskeyAccount): the FIRST
//     account created via the PRIVATE (non-edge) path is the owner (`role='admin'`); everyone else,
//     and anyone via the public edge, is `role='account'`. This is account creation.
//   - PUBLIC SIGN-IN (also carved out — same class): an availability probe + the two login-ceremony
//     steps. login/verify mints a session ONLY when an assertion verifies against a stored credential.
//   - AUTHED (behind the gate): register an ADDITIONAL passkey on the logged-in account, list them,
//     delete one — every query scoped to auth.user.id.
//
// The whole feature is DARK unless WEBAUTHN_RP_ID is set: every route short-circuits to 503 (or a
// benign `available:false`) so no account/session can ever be minted on an unconfigured server.
const passkey = new Hono();

const REGISTER_TIMEOUT_MS = 60_000;

function userAgentOf(c: Context): string | null {
  const ua = c.req.header("user-agent");
  return ua ? ua.slice(0, MAX_USER_AGENT_LENGTH) : null;
}

// Bound + whitelist the optional transports hint (untrusted, display-only). Stored as JSON or null.
function normalizeTransports(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const allowed = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card", "cable"]);
  const list = value.filter((x): x is string => typeof x === "string" && allowed.has(x)).slice(0, 8);
  return list.length > 0 ? JSON.stringify(list) : null;
}

// Bound the optional user-supplied label (a friendly device name); empty/oversized degrades to null.
function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().slice(0, 64);
  return s.length > 0 ? s : null;
}

// Create a brand-new account for a passkey sign-up, deciding its role ATOMICALLY (#191). Access is
// granted DIRECTLY (accessGrantedAt = now) — a passkey sign-up IS the grant; there is no invite step
// anymore (#169). `login` is a synthetic slug (account users have no Tailscale login, no email).
// `plan` + the guardrail columns take their schema defaults (plan=ultra on the OSS build; the null
// guardrails resolve to the config.freeTier bounds).
//
// OWNER BOOTSTRAP: the FIRST passkey account created via the PRIVATE (non-edge) path becomes the
// single owner (`role='admin'`); every later sign-up — and ANY sign-up that arrived via the public
// edge, even the very first account — is a plain `role='account'`. So a public visitor can NEVER
// steal ownership before the installer signs up on the tailnet. The "is there an owner yet?" check
// and the insert run in ONE `db.transaction`: SQLite serializes write transactions, so two concurrent
// first-sign-ups yield EXACTLY ONE owner (the second sees the first's committed admin row and falls to
// 'account'). The transactional check is the primary race guard — a partial unique index on
// role='admin' is deliberately NOT used because the DEV_ADMIN_LOGIN break-glass legitimately creates a
// SECOND role='admin' row, which such an index would reject and thereby break owner recovery.
// Owner-TRANSFER is not built yet (a future admin action); if the owner row is later deleted, its
// admin flag goes with it and the NEXT non-edge sign-up claims the vacant slot — an acceptable
// self-host re-bootstrap (documented in .env.example / CLAUDE.md).
function createPasskeyAccount(now: Date, viaEdge: boolean): User {
  const created = db.transaction((tx) => {
    const ownerExists = tx.select({ id: users.id }).from(users).where(eq(users.role, "admin")).get();
    const role: "admin" | "account" = !ownerExists && !viaEdge ? "admin" : "account";
    return tx.insert(users).values({ login: `acct_${randomUUID()}`, role, accessGrantedAt: now }).returning().get();
  });
  if (!created) throw new WebauthnError("failed to create account", 500);
  return created;
}

// ---------------------------------------------------------------------------
// PUBLIC: availability probe — lets the pre-auth login screen show the passkey buttons only when the
// server has passkeys configured. Reveals only a boolean the buttons' presence would imply anyway.
// ---------------------------------------------------------------------------
passkey.get("/available", (c) => c.json({ available: webauthnAvailable() }));

// ---------------------------------------------------------------------------
// PUBLIC SIGN-UP: begin registration for a visitor with no account. The challenge is anonymous
// (userId null) — the account does not exist yet; it is created at /signup/verify. The WebAuthn user
// handle is a throwaway random id (login resolves by credential id, so it never needs to match the
// account we mint). No excludeCredentials — a brand-new visitor has nothing to exclude.
// ---------------------------------------------------------------------------
passkey.post("/signup/options", (c) => {
  if (!webauthnAvailable()) return c.json({ error: "passkeys are not enabled" }, 503);
  const created = createChallenge({ purpose: "register", userId: null, ip: trustedClientIp(c) });
  if (!created.ok) return c.json({ error: "too many requests" }, 429);

  const options = {
    rp: { id: webauthnRpId(), name: webauthnRpName() },
    user: {
      id: bufferToBase64url(Buffer.from(randomUUID(), "utf8")),
      name: "a7t.chat",
      displayName: "a7t.chat",
    },
    challenge: created.challenge,
    pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 only (see verify.ts header)
    timeout: REGISTER_TIMEOUT_MS,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
  };
  return c.json({ options });
});

// ---------------------------------------------------------------------------
// PUBLIC SIGN-UP: finish registration — verify the attestation, CREATE the account, persist the
// credential to it, and mint a session. The consumed challenge MUST be an anonymous sign-up challenge
// (userId null) — an authed-register challenge (userId set) is rejected here, so the two register
// paths can't be crossed. The account is created only AFTER verification succeeds; a failed credential
// store rolls the account back so a partial sign-up never leaves an orphan row.
// ---------------------------------------------------------------------------
passkey.post("/signup/verify", async (c) => {
  if (!webauthnAvailable()) return c.json({ error: "passkeys are not enabled" }, 503);
  const body = (await c.req.json().catch(() => ({}))) as {
    attestationObject?: unknown;
    clientDataJSON?: unknown;
    transports?: unknown;
    label?: unknown;
  };
  if (typeof body.attestationObject !== "string" || typeof body.clientDataJSON !== "string") {
    return c.json({ error: "invalid registration" }, 400);
  }

  let client;
  try {
    client = decodeClientData(body.clientDataJSON);
  } catch {
    return c.json({ error: "invalid registration" }, 400);
  }
  // Single-use consume + confirm it's an ANONYMOUS sign-up challenge we issued (userId null). This is
  // the authoritative anti-replay check; verifyRegistration re-checks challenge/origin/rpId/flags.
  const challengeRow = consumeChallenge({ challenge: client.challenge, purpose: "register" });
  if (!challengeRow || challengeRow.userId !== null) {
    return c.json({ error: "invalid or expired challenge" }, 400);
  }

  try {
    const verified = verifyRegistration({
      attestationObject: body.attestationObject,
      clientDataJSON: body.clientDataJSON,
      expectedChallenge: client.challenge,
      expectedOrigin: webauthnOrigin(),
      expectedRpId: webauthnRpId(),
      requireUV: true,
    });
    // Reject an already-registered credential BEFORE creating an account (never an orphan row).
    if (getCredentialByCredentialId(verified.credentialId)) {
      return c.json({ error: "passkey already registered" }, 409);
    }

    const now = new Date();
    // Decide the owner slot with the SAME public-edge discriminator the auth gate uses: a sign-up over
    // the public edge is NEVER the owner, even if it's the very first account (#191).
    const user = createPasskeyAccount(now, isViaEdge(c));
    try {
      storeCredential({
        userId: user.id,
        credentialId: verified.credentialId,
        publicKey: verified.publicKeyJwk,
        signCount: verified.signCount,
        transports: normalizeTransports(body.transports),
        label: normalizeLabel(body.label),
      });
    } catch (e) {
      // Roll back the just-created account so a failed credential store leaves no orphan.
      db.delete(users).where(eq(users.id, user.id)).run();
      throw e;
    }

    const { token } = createSession({ userId: user.id, ip: trustedClientIp(c), userAgent: userAgentOf(c), now });
    setSessionCookie(c, token);
    return c.json({ ok: true, status: "authed" });
  } catch (e) {
    if (e instanceof WebauthnError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// AUTHED: begin registration — mint creation options bound to the caller's account (add a passkey to
// an account that already exists, e.g. a second device).
// ---------------------------------------------------------------------------
passkey.post("/register/options", (c) => {
  if (!webauthnAvailable()) return c.json({ error: "passkeys are not enabled" }, 503);
  const auth = c.get("auth");
  const created = createChallenge({ purpose: "register", userId: auth.user.id, ip: trustedClientIp(c) });
  if (!created.ok) return c.json({ error: "too many requests" }, 429);

  const options = {
    rp: { id: webauthnRpId(), name: webauthnRpName() },
    // The WebAuthn user handle — the account id as bytes (base64url on the wire). We resolve login by
    // credential id, not this handle, so its only job is to key the credential on the authenticator.
    user: {
      id: bufferToBase64url(Buffer.from(auth.user.id, "utf8")),
      name: auth.user.email ?? auth.user.login,
      displayName: auth.user.displayName ?? auth.user.email ?? "a7t.chat",
    },
    challenge: created.challenge,
    pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 only (see verify.ts header)
    timeout: REGISTER_TIMEOUT_MS,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    // Don't let the same authenticator enrol twice on one account.
    excludeCredentials: excludeCredentialIds(auth.user.id).map((id) => ({ type: "public-key", id })),
  };
  return c.json({ options });
});

// ---------------------------------------------------------------------------
// AUTHED: finish registration — verify the attestation + persist the credential to the caller.
// ---------------------------------------------------------------------------
passkey.post("/register/verify", async (c) => {
  if (!webauthnAvailable()) return c.json({ error: "passkeys are not enabled" }, 503);
  const auth = c.get("auth");
  const body = (await c.req.json().catch(() => ({}))) as {
    attestationObject?: unknown;
    clientDataJSON?: unknown;
    transports?: unknown;
    label?: unknown;
  };
  if (typeof body.attestationObject !== "string" || typeof body.clientDataJSON !== "string") {
    return c.json({ error: "invalid registration" }, 400);
  }

  // Pull the challenge from the (validated) clientData, then single-use-consume it and confirm it was
  // one WE issued to THIS account for a registration ceremony. This is the authoritative anti-replay
  // check; verifyRegistration re-checks challenge/origin/rpId/flags on top.
  let client;
  try {
    client = decodeClientData(body.clientDataJSON);
  } catch {
    return c.json({ error: "invalid registration" }, 400);
  }
  const challengeRow = consumeChallenge({ challenge: client.challenge, purpose: "register" });
  if (!challengeRow || challengeRow.userId !== auth.user.id) {
    return c.json({ error: "invalid or expired challenge" }, 400);
  }

  try {
    const verified = verifyRegistration({
      attestationObject: body.attestationObject,
      clientDataJSON: body.clientDataJSON,
      expectedChallenge: client.challenge,
      expectedOrigin: webauthnOrigin(),
      expectedRpId: webauthnRpId(),
      requireUV: true,
    });
    const stored = storeCredential({
      userId: auth.user.id,
      credentialId: verified.credentialId,
      publicKey: verified.publicKeyJwk,
      signCount: verified.signCount,
      transports: normalizeTransports(body.transports),
      label: normalizeLabel(body.label),
    });
    return c.json({
      ok: true,
      passkey: { id: stored.id, label: stored.label, createdAt: stored.createdAt.getTime(), lastUsedAt: null },
    });
  } catch (e) {
    if (e instanceof WebauthnError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// AUTHED: list / delete the caller's passkeys.
// ---------------------------------------------------------------------------
passkey.get("/", (c) => {
  if (!webauthnAvailable()) return c.json({ available: false, passkeys: [] });
  const auth = c.get("auth");
  return c.json({ available: true, passkeys: listCredentials(auth.user.id) });
});

passkey.delete("/:id", (c) => {
  const auth = c.get("auth");
  const removed = deleteCredential(auth.user.id, c.req.param("id"));
  return c.json({ ok: true, removed });
});

// ---------------------------------------------------------------------------
// PUBLIC SIGN-IN: begin login — mint an authentication challenge (usernameless / discoverable credentials).
// ---------------------------------------------------------------------------
passkey.post("/login/options", (c) => {
  if (!webauthnAvailable()) return c.json({ error: "passkeys are not enabled" }, 503);
  const created = createChallenge({ purpose: "authenticate", ip: trustedClientIp(c) });
  if (!created.ok) return c.json({ error: "too many requests" }, 429);
  return c.json({
    options: { challenge: created.challenge, rpId: webauthnRpId(), timeout: REGISTER_TIMEOUT_MS, userVerification: "required" },
  });
});

// ---------------------------------------------------------------------------
// PUBLIC SIGN-IN: finish login — verify the assertion, then mint a session for the credential's owner.
// Every failure returns an IDENTICAL generic 401 (no account/credential-existence oracle). A normal
// account is access-granted, so `status` is "authed"; a session for an owner whose access was later
// revoked reports "inactive" (the gate then walls it — the client shows the owner-recovery message).
// ---------------------------------------------------------------------------
passkey.post("/login/verify", async (c) => {
  if (!webauthnAvailable()) return c.json({ error: "passkeys are not enabled" }, 503);
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: unknown;
    authenticatorData?: unknown;
    clientDataJSON?: unknown;
    signature?: unknown;
  };
  if (
    typeof body.id !== "string" ||
    typeof body.authenticatorData !== "string" ||
    typeof body.clientDataJSON !== "string" ||
    typeof body.signature !== "string"
  ) {
    return c.json({ error: "invalid assertion" }, 400);
  }

  let client;
  try {
    client = decodeClientData(body.clientDataJSON);
  } catch {
    return c.json({ error: "invalid assertion" }, 401);
  }
  const challengeRow = consumeChallenge({ challenge: client.challenge, purpose: "authenticate" });
  if (!challengeRow) return c.json({ error: "invalid assertion" }, 401);

  const cred = getCredentialByCredentialId(body.id);
  if (!cred) return c.json({ error: "invalid assertion" }, 401);

  try {
    const { newSignCount } = verifyAuthentication({
      authenticatorData: body.authenticatorData,
      clientDataJSON: body.clientDataJSON,
      signature: body.signature,
      expectedChallenge: client.challenge,
      expectedOrigin: webauthnOrigin(),
      expectedRpId: webauthnRpId(),
      publicKeyJwk: cred.publicKey,
      storedSignCount: cred.signCount,
      requireUV: true,
    });
    const now = new Date();
    updateSignCount(cred.id, newSignCount, now);

    const user = db.select().from(users).where(eq(users.id, cred.userId)).get();
    if (!user) return c.json({ error: "invalid assertion" }, 401);

    const { token } = createSession({ userId: user.id, ip: trustedClientIp(c), userAgent: userAgentOf(c), now });
    setSessionCookie(c, token);
    return c.json({ ok: true, status: user.accessGrantedAt ? "authed" : "inactive" });
  } catch {
    // Any verification failure collapses to the same generic 401 — no reason is leaked.
    return c.json({ error: "invalid assertion" }, 401);
  }
});

export default passkey;

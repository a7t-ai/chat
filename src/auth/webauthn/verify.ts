import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { decodeCbor } from "./cbor.ts";

// WebAuthn ceremony verification (#20) — the pure, self-contained core the passkey routes call.
// It parses + validates a registration attestation and an authentication assertion using ONLY
// node:crypto (no dependency), mirroring how the rest of a7t.chat's crypto is hand-rolled + tested.
//
// SCOPE: we deliberately support exactly ONE credential algorithm — ES256 (COSE alg -7): an EC P-256
// key with an ECDSA/SHA-256 signature. That is what every platform passkey (Touch ID / Windows Hello
// / Android / iCloud Keychain) and virtually every security key produces, and pinning to it keeps the
// verification surface small and auditable. `pubKeyCredParams` on the register options offers ONLY
// alg -7, so the browser never mints anything else; an authenticator that can't do ES256 simply
// can't register (a documented limitation, not a silent failure).
//
// SECURITY invariants enforced here (every one throws WebauthnError on violation — fail closed):
//   - clientData.type is the exact expected ceremony ("webauthn.create" / "webauthn.get")
//   - clientData.challenge equals the challenge WE issued (the route also single-use-consumes it)
//   - clientData.origin equals OUR origin (a passkey replayed from another site is rejected)
//   - authData.rpIdHash equals SHA-256(rpId) (bound to our Relying Party)
//   - the User Present flag is set; User Verified is required for passkeys (biometric/PIN)
//   - on authentication, the assertion signature verifies against the STORED public key
//   - the signature counter is monotonic when non-zero (clone detection)

// Only the statuses the routes actually emit — a literal union so Hono's `c.json(body, status)`
// accepts `err.status` directly (a bare `number` doesn't satisfy its ContentfulStatusCode).
export type WebauthnErrorStatus = 400 | 401 | 409 | 500;

export class WebauthnError extends Error {
  constructor(
    message: string,
    public readonly status: WebauthnErrorStatus,
  ) {
    super(message);
    this.name = "WebauthnError";
  }
}

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

function b64urlToBuffer(s: string): Buffer {
  // Buffer.from(..,"base64url") never throws; a malformed input yields best-effort bytes, which
  // downstream checks (CBOR decode / JSON parse / signature verify) then reject.
  return Buffer.from(s, "base64url");
}

export function bufferToBase64url(buf: Buffer): string {
  return buf.toString("base64url");
}

// The decoded, checked-shape clientDataJSON fields we consume. Extra fields (tokenBinding, …) are
// ignored by design.
export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

// Decode + shape-validate clientDataJSON (base64url) into its three load-bearing fields. Throws
// WebauthnError(400) on any non-JSON / wrong-shape input so the route can surface a clean rejection.
export function decodeClientData(clientDataJSONB64u: string): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlToBuffer(clientDataJSONB64u).toString("utf8"));
  } catch {
    throw new WebauthnError("malformed clientDataJSON", 400);
  }
  if (typeof parsed !== "object" || parsed === null) throw new WebauthnError("malformed clientDataJSON", 400);
  const o = parsed as Record<string, unknown>;
  if (typeof o.type !== "string" || typeof o.challenge !== "string" || typeof o.origin !== "string") {
    throw new WebauthnError("malformed clientDataJSON", 400);
  }
  return { type: o.type, challenge: o.challenge, origin: o.origin };
}

interface AuthDataFlags {
  up: boolean; // user present
  uv: boolean; // user verified
  at: boolean; // attested credential data present
  ed: boolean; // extension data present
}

export interface ParsedAuthData {
  rpIdHash: Buffer;
  flags: AuthDataFlags;
  signCount: number;
  credentialId?: Buffer;
  cosePublicKey?: Map<unknown, unknown>;
}

// Parse the authenticator data structure (§6.1). Layout: rpIdHash(32) | flags(1) | signCount(4) |
// [attested credential data: aaguid(16) | credIdLen(2) | credId | COSE key] | [extensions].
export function parseAuthData(authData: Buffer): ParsedAuthData {
  if (authData.length < 37) throw new WebauthnError("authenticator data too short", 400);
  const rpIdHash = Buffer.from(authData.subarray(0, 32));
  const flagsByte = authData.readUInt8(32);
  const flags: AuthDataFlags = {
    up: (flagsByte & 0x01) !== 0,
    uv: (flagsByte & 0x04) !== 0,
    at: (flagsByte & 0x40) !== 0,
    ed: (flagsByte & 0x80) !== 0,
  };
  const signCount = authData.readUInt32BE(33);

  const result: ParsedAuthData = { rpIdHash, flags, signCount };
  if (flags.at) {
    if (authData.length < 55) throw new WebauthnError("attested credential data truncated", 400);
    const credIdLen = authData.readUInt16BE(53);
    const credIdStart = 55;
    const credIdEnd = credIdStart + credIdLen;
    if (credIdLen === 0 || authData.length < credIdEnd) {
      throw new WebauthnError("attested credential id truncated", 400);
    }
    result.credentialId = Buffer.from(authData.subarray(credIdStart, credIdEnd));
    // The COSE public key is the next CBOR item; decodeCbor stops at its end, ignoring any trailing
    // extension bytes.
    const cose = decodeCbor(authData.subarray(credIdEnd));
    if (!(cose instanceof Map)) throw new WebauthnError("malformed credential public key", 400);
    result.cosePublicKey = cose;
  }
  return result;
}

// Convert a COSE_Key map to a JWK, enforcing ES256 / EC P-256. Rejects any other key type/curve/alg.
function coseToJwk(cose: Map<unknown, unknown>): { kty: "EC"; crv: "P-256"; x: string; y: string } {
  const kty = cose.get(1); // 2 = EC2
  const alg = cose.get(3); // -7 = ES256
  const crv = cose.get(-1); // 1 = P-256
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (kty !== 2 || alg !== -7 || crv !== 1) {
    throw new WebauthnError("unsupported credential algorithm (only ES256/P-256 is accepted)", 400);
  }
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
    throw new WebauthnError("malformed credential public key coordinates", 400);
  }
  return { kty: "EC", crv: "P-256", x: bufferToBase64url(x), y: bufferToBase64url(y) };
}

function assertCeremony(client: ClientData, expectedType: string, expectedChallenge: string, expectedOrigin: string): void {
  if (client.type !== expectedType) throw new WebauthnError("unexpected ceremony type", 400);
  if (client.challenge !== expectedChallenge) throw new WebauthnError("challenge mismatch", 400);
  if (client.origin !== expectedOrigin) throw new WebauthnError("origin mismatch", 400);
}

function assertRpAndFlags(parsed: ParsedAuthData, expectedRpId: string, requireUV: boolean): void {
  if (!parsed.rpIdHash.equals(sha256(Buffer.from(expectedRpId, "utf8")))) {
    throw new WebauthnError("relying-party mismatch", 400);
  }
  if (!parsed.flags.up) throw new WebauthnError("user presence required", 400);
  if (requireUV && !parsed.flags.uv) throw new WebauthnError("user verification required", 400);
}

export interface VerifyRegistrationInput {
  attestationObject: string; // base64url
  clientDataJSON: string; // base64url
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRpId: string;
  requireUV: boolean;
}

export interface VerifiedRegistration {
  credentialId: string; // base64url
  publicKeyJwk: string; // JSON string of the EC2 JWK
  signCount: number;
}

// Verify a registration attestation (attestation format is not verified — we request "none", the
// standard consumer-passkey flow — but the challenge/origin/rpId/flags binding is fully enforced;
// see the module header). Returns the credential id + public key to persist.
export function verifyRegistration(input: VerifyRegistrationInput): VerifiedRegistration {
  const client = decodeClientData(input.clientDataJSON);
  assertCeremony(client, "webauthn.create", input.expectedChallenge, input.expectedOrigin);

  const attestation = decodeCbor(b64urlToBuffer(input.attestationObject));
  if (!(attestation instanceof Map)) throw new WebauthnError("malformed attestation object", 400);
  const authDataRaw = attestation.get("authData");
  if (!Buffer.isBuffer(authDataRaw)) throw new WebauthnError("missing authenticator data", 400);

  const parsed = parseAuthData(authDataRaw);
  assertRpAndFlags(parsed, input.expectedRpId, input.requireUV);
  if (!parsed.flags.at || !parsed.credentialId || !parsed.cosePublicKey) {
    throw new WebauthnError("missing attested credential data", 400);
  }

  const jwk = coseToJwk(parsed.cosePublicKey);
  return {
    credentialId: bufferToBase64url(parsed.credentialId),
    publicKeyJwk: JSON.stringify(jwk),
    signCount: parsed.signCount,
  };
}

export interface VerifyAuthenticationInput {
  authenticatorData: string; // base64url
  clientDataJSON: string; // base64url
  signature: string; // base64url (DER-encoded ECDSA)
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRpId: string;
  publicKeyJwk: string; // the stored EC2 JWK JSON
  storedSignCount: number;
  requireUV: boolean;
}

// Verify an authentication assertion: the signature must verify against the stored public key over
// (authenticatorData || SHA-256(clientDataJSON)), and every ceremony/flag/counter invariant holds.
// Returns the new signature counter to persist.
export function verifyAuthentication(input: VerifyAuthenticationInput): { newSignCount: number } {
  const client = decodeClientData(input.clientDataJSON);
  assertCeremony(client, "webauthn.get", input.expectedChallenge, input.expectedOrigin);

  const authData = b64urlToBuffer(input.authenticatorData);
  const parsed = parseAuthData(authData);
  assertRpAndFlags(parsed, input.expectedRpId, input.requireUV);

  let publicKey;
  try {
    publicKey = createPublicKey({ key: JSON.parse(input.publicKeyJwk), format: "jwk" });
  } catch {
    throw new WebauthnError("stored credential key is invalid", 500);
  }

  const signedData = Buffer.concat([authData, sha256(b64urlToBuffer(input.clientDataJSON))]);
  const signature = b64urlToBuffer(input.signature);
  // node's default dsaEncoding for verify is "der", which is exactly how WebAuthn encodes the ES256
  // signature — so we verify it directly.
  const ok = cryptoVerify("sha256", signedData, publicKey, signature);
  if (!ok) throw new WebauthnError("assertion signature invalid", 401);

  // Clone detection: a non-zero counter must strictly increase. Platform passkeys legitimately keep
  // the counter at 0 forever, so 0↔0 is accepted (replay is already precluded by the single-use
  // challenge the route consumes before this runs).
  const newSignCount = parsed.signCount;
  if ((newSignCount !== 0 || input.storedSignCount !== 0) && newSignCount <= input.storedSignCount) {
    throw new WebauthnError("credential counter regressed (possible clone)", 401);
  }
  return { newSignCount };
}

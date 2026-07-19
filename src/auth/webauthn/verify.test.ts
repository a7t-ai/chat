import { describe, expect, test } from "bun:test";
import {
  bufferToBase64url,
  decodeClientData,
  parseAuthData,
  verifyAuthentication,
  verifyRegistration,
  WebauthnError,
} from "./verify.ts";
import { buildAuthData, DEFAULT_ORIGIN, DEFAULT_RP_ID, FLAG_AT, FLAG_UP, FLAG_UV, makeAuthenticator } from "./testkit.ts";

const RP_ID = DEFAULT_RP_ID;
const ORIGIN = DEFAULT_ORIGIN;

function reg(auth: ReturnType<typeof makeAuthenticator>, challenge: string, over = {}) {
  return { ...auth.register({ challenge, ...over }), expectedChallenge: challenge };
}

describe("decodeClientData", () => {
  test("decodes the three load-bearing fields, ignoring extras", () => {
    const b64 = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: "abc", origin: ORIGIN, extra: 1 })).toString("base64url");
    expect(decodeClientData(b64)).toEqual({ type: "webauthn.get", challenge: "abc", origin: ORIGIN });
  });
  test("throws on non-JSON", () => {
    const b64 = Buffer.from("not json").toString("base64url");
    expect(() => decodeClientData(b64)).toThrow(WebauthnError);
  });
  test("throws on a JSON non-object", () => {
    const b64 = Buffer.from(JSON.stringify("hi")).toString("base64url");
    expect(() => decodeClientData(b64)).toThrow(WebauthnError);
  });
  test("throws when a field is missing/wrong type", () => {
    const b64 = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: 5, origin: ORIGIN })).toString("base64url");
    expect(() => decodeClientData(b64)).toThrow(/malformed/);
  });
});

describe("parseAuthData", () => {
  test("parses flags + signCount without attested data", () => {
    const ad = buildAuthData({ rpId: RP_ID, flags: FLAG_UP | FLAG_UV, signCount: 7 });
    const p = parseAuthData(ad);
    expect(p.flags).toEqual({ up: true, uv: true, at: false, ed: false });
    expect(p.signCount).toBe(7);
    expect(p.credentialId).toBeUndefined();
  });
  test("throws on a too-short buffer", () => {
    expect(() => parseAuthData(Buffer.alloc(10))).toThrow(/too short/);
  });
  test("throws when attested-data flag is set but the buffer is truncated", () => {
    const ad = buildAuthData({ rpId: RP_ID, flags: FLAG_UP | FLAG_AT, signCount: 0 });
    // Chop off the credential id + key, keeping the AT flag → truncated.
    expect(() => parseAuthData(ad.subarray(0, 50))).toThrow(WebauthnError);
  });
});

describe("verifyRegistration", () => {
  const auth = makeAuthenticator();
  const base = { expectedOrigin: ORIGIN, expectedRpId: RP_ID, requireUV: true };

  test("accepts a valid attestation and returns the credential + public key", () => {
    const { attestationObject, clientDataJSON, expectedChallenge } = reg(auth, "chal-1");
    const out = verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, ...base });
    expect(out.credentialId).toBe(auth.credentialIdB64u);
    expect(out.signCount).toBe(0);
    expect(JSON.parse(out.publicKeyJwk)).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  test("rejects the wrong ceremony type", () => {
    const { attestationObject, clientDataJSON, expectedChallenge } = reg(auth, "chal-t", { type: "webauthn.get" });
    expect(() => verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, ...base })).toThrow(/ceremony/);
  });
  test("rejects a challenge mismatch", () => {
    const { attestationObject, clientDataJSON } = reg(auth, "chal-a");
    expect(() => verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge: "other", ...base })).toThrow(/challenge/);
  });
  test("rejects an origin mismatch", () => {
    const { attestationObject, clientDataJSON, expectedChallenge } = reg(auth, "chal-o", { origin: "https://evil.example" });
    expect(() => verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, ...base })).toThrow(/origin/);
  });
  test("rejects a relying-party (rpId) mismatch", () => {
    const { attestationObject, clientDataJSON, expectedChallenge } = reg(auth, "chal-r", { rpId: "evil.example" });
    expect(() => verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, ...base })).toThrow(/relying-party/);
  });
  test("rejects when user verification is required but absent", () => {
    const { attestationObject, clientDataJSON, expectedChallenge } = reg(auth, "chal-uv", { flags: FLAG_UP | FLAG_AT });
    expect(() => verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, ...base })).toThrow(/user verification/);
  });
  test("rejects when user presence is absent", () => {
    const { attestationObject, clientDataJSON, expectedChallenge } = reg(auth, "chal-up", { flags: FLAG_UV | FLAG_AT });
    expect(() => verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, ...base })).toThrow(/user presence/);
  });
  test("rejects when attested credential data is missing (no AT flag)", () => {
    const { attestationObject, clientDataJSON, expectedChallenge } = reg(auth, "chal-noat", { flags: FLAG_UP | FLAG_UV });
    expect(() => verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, ...base })).toThrow(/attested/);
  });
  test("allows skipping UV when requireUV is false", () => {
    const { attestationObject, clientDataJSON, expectedChallenge } = reg(auth, "chal-nouv", { flags: FLAG_UP | FLAG_AT });
    const out = verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, ...base, requireUV: false });
    expect(out.credentialId).toBe(auth.credentialIdB64u);
  });
});

describe("verifyAuthentication", () => {
  const auth = makeAuthenticator();
  // Register once to obtain the stored public key.
  const stored = verifyRegistration({
    ...auth.register({ challenge: "reg" }),
    expectedChallenge: "reg",
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    requireUV: true,
  });
  const base = {
    expectedOrigin: ORIGIN,
    expectedRpId: RP_ID,
    publicKeyJwk: stored.publicKeyJwk,
    requireUV: true,
  };

  test("accepts a valid assertion and returns the new counter", () => {
    const a = auth.assert({ challenge: "log-1", signCount: 5 });
    const out = verifyAuthentication({ ...a, expectedChallenge: "log-1", storedSignCount: 0, ...base });
    expect(out.newSignCount).toBe(5);
  });

  test("rejects a tampered signature", () => {
    const a = auth.assert({ challenge: "log-2", tamperSignature: true });
    expect(() => verifyAuthentication({ ...a, expectedChallenge: "log-2", storedSignCount: 0, ...base })).toThrow(/signature/);
  });

  test("rejects an assertion signed for a different challenge (replay across ceremonies)", () => {
    const a = auth.assert({ challenge: "log-3" });
    // The server expected a different challenge than the one the authenticator signed.
    expect(() => verifyAuthentication({ ...a, expectedChallenge: "server-issued", storedSignCount: 0, ...base })).toThrow(/challenge/);
  });

  test("rejects a wrong-key assertion (another authenticator)", () => {
    const other = makeAuthenticator();
    const a = other.assert({ challenge: "log-4" });
    expect(() => verifyAuthentication({ ...a, expectedChallenge: "log-4", storedSignCount: 0, ...base })).toThrow(/signature/);
  });

  test("rejects a counter that did not advance (clone detection)", () => {
    const a = auth.assert({ challenge: "log-5", signCount: 5 });
    expect(() => verifyAuthentication({ ...a, expectedChallenge: "log-5", storedSignCount: 5, ...base })).toThrow(/counter/);
  });

  test("accepts an always-zero counter (platform passkey)", () => {
    const a = auth.assert({ challenge: "log-6", signCount: 0 });
    const out = verifyAuthentication({ ...a, expectedChallenge: "log-6", storedSignCount: 0, ...base });
    expect(out.newSignCount).toBe(0);
  });

  test("rejects the wrong ceremony type on the assertion", () => {
    const a = auth.assert({ challenge: "log-7", type: "webauthn.create" });
    expect(() => verifyAuthentication({ ...a, expectedChallenge: "log-7", storedSignCount: 0, ...base })).toThrow(/ceremony/);
  });

  test("rejects when the stored key JWK is corrupt", () => {
    const a = auth.assert({ challenge: "log-8" });
    expect(() =>
      verifyAuthentication({ ...a, expectedChallenge: "log-8", storedSignCount: 0, ...base, publicKeyJwk: "{not json" }),
    ).toThrow(/stored credential/);
  });

  test("rejects a UV-absent assertion when UV is required", () => {
    const a = auth.assert({ challenge: "log-9", flags: FLAG_UP });
    expect(() => verifyAuthentication({ ...a, expectedChallenge: "log-9", storedSignCount: 0, ...base })).toThrow(/user verification/);
  });
});

describe("bufferToBase64url", () => {
  test("round-trips through base64url", () => {
    const b = Buffer.from([1, 2, 3, 250]);
    expect(bufferToBase64url(b)).toBe(b.toString("base64url"));
  });
});

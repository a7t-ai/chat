import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";

// A "virtual authenticator" for the WebAuthn tests — it synthesizes the SAME attestation objects and
// assertions a real Touch ID / security key produces, using node:crypto, so the verifier's crypto
// path is exercised end to end with no external fixtures and full determinism. Not shipped: this
// lives only to be imported by the *.test.ts files (which is what loads + covers it).

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

// A minimal CBOR ENCODER — the inverse of cbor.ts, only the items an attestation object + COSE key
// need (ints, byte/text strings, maps). Length is encoded as 1 byte (<24) or a 2-byte uint (fits
// every payload here); anything larger is a test bug.
function head(major: number, len: number): Buffer {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 0x1_0000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(len, 1);
    return b;
  }
  throw new Error("testkit: length too large");
}

function encode(value: number | string | Buffer | Map<unknown, unknown>): Buffer {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("testkit: non-integer");
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  // map
  const parts: Buffer[] = [head(5, value.size)];
  for (const [k, v] of value) parts.push(encode(k as never), encode(v as never));
  return Buffer.concat(parts);
}

// WebAuthn authenticator-data flag bits.
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;

export interface AuthDataParts {
  rpId: string;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  coseKey?: Map<number, number | Buffer>;
}

export function buildAuthData(p: AuthDataParts): Buffer {
  const rpIdHash = sha256(Buffer.from(p.rpId, "utf8"));
  const flags = Buffer.from([p.flags]);
  const sc = Buffer.alloc(4);
  sc.writeUInt32BE(p.signCount >>> 0, 0);
  const parts = [rpIdHash, flags, sc];
  if (p.credentialId && p.coseKey) {
    const aaguid = Buffer.alloc(16); // all-zero aaguid (attestation "none")
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(p.credentialId.length, 0);
    parts.push(aaguid, credLen, p.credentialId, encode(p.coseKey));
  }
  return parts.reduce<Buffer>((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
}

export interface RegisterOverrides {
  rpId?: string;
  origin?: string;
  challenge: string;
  type?: string;
  flags?: number;
  signCount?: number;
}

export interface AssertOverrides {
  rpId?: string;
  origin?: string;
  challenge: string;
  type?: string;
  flags?: number;
  signCount?: number;
  tamperSignature?: boolean;
}

export interface VirtualAuthenticator {
  credentialId: Buffer;
  credentialIdB64u: string;
  publicKeyJwk: string;
  register(o: RegisterOverrides): { attestationObject: string; clientDataJSON: string };
  assert(o: AssertOverrides): { id: string; authenticatorData: string; clientDataJSON: string; signature: string };
}

export const DEFAULT_RP_ID = "a7t.chat";
export const DEFAULT_ORIGIN = "https://a7t.chat";

// Create a fresh virtual authenticator with a real EC P-256 keypair.
export function makeAuthenticator(): VirtualAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const cose = new Map<number, number | Buffer>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y],
  ]);
  const credentialId = randomBytes(20);
  const priv: KeyObject = privateKey;

  function clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  }

  return {
    credentialId,
    credentialIdB64u: credentialId.toString("base64url"),
    publicKeyJwk: JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }),
    register(o) {
      const authData = buildAuthData({
        rpId: o.rpId ?? DEFAULT_RP_ID,
        flags: o.flags ?? FLAG_UP | FLAG_UV | FLAG_AT,
        signCount: o.signCount ?? 0,
        credentialId,
        coseKey: cose,
      });
      const attObj = encode(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      const cd = clientData(o.type ?? "webauthn.create", o.challenge, o.origin ?? DEFAULT_ORIGIN);
      return { attestationObject: attObj.toString("base64url"), clientDataJSON: cd.toString("base64url") };
    },
    assert(o) {
      const authData = buildAuthData({
        rpId: o.rpId ?? DEFAULT_RP_ID,
        flags: o.flags ?? FLAG_UP | FLAG_UV,
        signCount: o.signCount ?? 0,
      });
      const cd = clientData(o.type ?? "webauthn.get", o.challenge, o.origin ?? DEFAULT_ORIGIN);
      const signed = Buffer.concat([authData, sha256(cd)]);
      let signature = createSign("SHA256").update(signed).sign(priv);
      if (o.tamperSignature) {
        const last = signature.length - 1;
        signature = Buffer.concat([signature.subarray(0, last), Buffer.from([(signature[last] ?? 0) ^ 0xff])]);
      }
      return {
        id: credentialId.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        clientDataJSON: cd.toString("base64url"),
        signature: signature.toString("base64url"),
      };
    },
  };
}

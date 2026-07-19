import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.ts";

// Authenticated encryption for BYOK secrets at rest (#14). A stored provider key is NEVER
// persisted in plaintext — only the AES-256-GCM package produced here lands in the DB, and only
// the server holding BYOK_ENCRYPTION_KEY can recover it. GCM's auth tag also makes the ciphertext
// tamper-evident: any bit-flip (or a wrong key) fails `decryptSecret` rather than returning
// garbage, so a corrupted/rotated-away row fails closed (the service treats that as "no key").
//
// Package format: `${iv}.${tag}.${ct}`, each part base64. A random 96-bit IV per encryption means
// the same key encrypts to a different ciphertext every time (no equality leak).

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce (GCM standard)
const TAG_LEN = 16; // 128-bit auth tag

// The 32-byte key, or null when BYOK_ENCRYPTION_KEY isn't a valid 64-char hex string. A null key
// means the feature is OFF everywhere (encrypt/decrypt refuse; the service reports unavailable),
// which is the safe default — we never invent an ephemeral key, since that would silently make
// already-stored keys undecryptable after a restart.
function encryptionKey(): Buffer | null {
  const hex = config.byok.encryptionKey.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

export function encryptionAvailable(): boolean {
  return encryptionKey() !== null;
}

export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("BYOK encryption key is not configured");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

// Recover the plaintext. THROWS on a malformed package, a wrong key, or any tampering (the GCM
// tag check in `final()`), so callers that must fail closed simply catch and treat it as absent.
export function decryptSecret(packed: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("BYOK encryption key is not configured");
  const parts = packed.split(".");
  if (parts.length !== 3) throw new Error("malformed BYOK ciphertext");
  const iv = Buffer.from(parts[0]!, "base64");
  const tag = Buffer.from(parts[1]!, "base64");
  const ct = Buffer.from(parts[2]!, "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new Error("malformed BYOK ciphertext");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

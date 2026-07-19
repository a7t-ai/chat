import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import { decryptSecret, encryptionAvailable, encryptSecret } from "./crypto.ts";

// Flip the configured key for a single test, then restore. config is `as const`; tests mutate it
// via a cast, the same pattern the middleware/server tests use.
function withKey<T>(hex: string, fn: () => T): T {
  const b = config.byok as unknown as { encryptionKey: string };
  const prev = b.encryptionKey;
  b.encryptionKey = hex;
  try {
    return fn();
  } finally {
    b.encryptionKey = prev;
  }
}

const VALID = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

describe("byok/crypto", () => {
  test("available only with a valid 64-hex key", () => {
    expect(encryptionAvailable()).toBe(true); // setup.ts configures one
    withKey("", () => expect(encryptionAvailable()).toBe(false));
    withKey("tooshort", () => expect(encryptionAvailable()).toBe(false));
    withKey("z".repeat(64), () => expect(encryptionAvailable()).toBe(false)); // non-hex
    withKey(`  ${VALID}  `, () => expect(encryptionAvailable()).toBe(true)); // trimmed
  });

  test("round-trips a secret", () => {
    const secret = "sk-live-abcdef0123456789";
    const packed = encryptSecret(secret);
    expect(packed).not.toContain(secret); // never plaintext
    expect(packed.split(".")).toHaveLength(3);
    expect(decryptSecret(packed)).toBe(secret);
  });

  test("encrypting the same value twice yields different ciphertext (random IV)", () => {
    const a = encryptSecret("same-key-value");
    const b = encryptSecret("same-key-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-key-value");
    expect(decryptSecret(b)).toBe("same-key-value");
  });

  test("tampering with the ciphertext fails the auth tag", () => {
    const packed = encryptSecret("secret");
    const [iv, tag, ct] = packed.split(".");
    // Flip a byte of the ciphertext body → GCM final() throws.
    const badCt = Buffer.from(ct!, "base64");
    badCt[0]! ^= 0xff;
    const tampered = `${iv}.${tag}.${badCt.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  test("a wrong key can't decrypt", () => {
    const packed = encryptSecret("secret");
    const otherKey = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    expect(() => withKey(otherKey, () => decryptSecret(packed))).toThrow();
  });

  test("malformed packages throw", () => {
    expect(() => decryptSecret("only.two")).toThrow("malformed");
    expect(() => decryptSecret("aa.bb.cc")).toThrow("malformed"); // iv/tag wrong length
  });

  test("encrypt/decrypt refuse when no key is configured", () => {
    withKey("", () => {
      expect(() => encryptSecret("x")).toThrow("not configured");
      expect(() => decryptSecret("a.b.c")).toThrow("not configured");
    });
  });
});

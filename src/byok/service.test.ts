import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { providerKeys, users } from "../db/schema.ts";
import {
  ByokError,
  byokAvailable,
  configuredProviders,
  deleteProviderKey,
  getDecryptedProviderKey,
  listProviderKeys,
  setProviderKey,
} from "./service.ts";

function makeUser(): string {
  return db.insert(users).values({ login: `byok-${Math.random()}`, role: "account" }).returning().get()!.id;
}

afterEach(() => {
  db.delete(providerKeys).run();
  db.delete(users).run();
  (config.byok as unknown as { encryptionKey: string }).encryptionKey =
    process.env.BYOK_ENCRYPTION_KEY ?? "";
});

describe("byok/service", () => {
  test("byokAvailable reflects the encryption key config", () => {
    expect(byokAvailable()).toBe(true);
    (config.byok as unknown as { encryptionKey: string }).encryptionKey = "";
    expect(byokAvailable()).toBe(false);
  });

  test("set → list returns a masked view, never the ciphertext or plaintext", () => {
    const u = makeUser();
    const stored = setProviderKey(u, "openai", "sk-secret-value-1234");
    expect(stored).toMatchObject({ provider: "openai", last4: "1234" });

    const keys = listProviderKeys(u);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ provider: "openai", last4: "1234" });
    // Nothing that could reconstruct the secret is exposed.
    expect(JSON.stringify(keys)).not.toContain("secret-value");
    expect(JSON.stringify(keys)).not.toContain("ciphertext");
  });

  test("the DB row stores encrypted bytes, not the raw key", () => {
    const u = makeUser();
    setProviderKey(u, "openai", "sk-plaintext-abcd");
    const row = db.select().from(providerKeys).where(eq(providerKeys.userId, u)).get();
    expect(row!.ciphertext).not.toContain("sk-plaintext");
    expect(row!.ciphertext.split(".")).toHaveLength(3);
  });

  test("re-setting a provider updates in place (unique per user+provider)", () => {
    const u = makeUser();
    setProviderKey(u, "openai", "sk-first-0000");
    setProviderKey(u, "openai", "sk-second-9999");
    const keys = listProviderKeys(u);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.last4).toBe("9999");
    expect(getDecryptedProviderKey(u, "openai")).toBe("sk-second-9999");
  });

  test("keys are scoped per user — one account never sees another's", () => {
    const a = makeUser();
    const b = makeUser();
    setProviderKey(a, "openai", "sk-alice-key-aaaa");
    expect(listProviderKeys(b)).toHaveLength(0);
    expect(getDecryptedProviderKey(b, "openai")).toBeNull();
    expect(getDecryptedProviderKey(a, "openai")).toBe("sk-alice-key-aaaa");
  });

  test("rejects an unknown provider and an out-of-bounds key", () => {
    const u = makeUser();
    expect(() => setProviderKey(u, "acme", "sk-whatever-1234")).toThrow(ByokError);
    expect(() => setProviderKey(u, "openai", "short")).toThrow("invalid API key");
    expect(() => setProviderKey(u, "openai", " ".repeat(20))).toThrow("invalid API key"); // trims to empty
    expect(() => setProviderKey(u, "openai", "x".repeat(501))).toThrow("invalid API key");
  });

  test("refuses to store when BYOK is not configured (503)", () => {
    const u = makeUser();
    (config.byok as unknown as { encryptionKey: string }).encryptionKey = "";
    try {
      setProviderKey(u, "openai", "sk-secret-value-1234");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ByokError);
      expect((e as ByokError).status).toBe(503);
    }
  });

  test("delete removes the row and is idempotent", () => {
    const u = makeUser();
    setProviderKey(u, "openai", "sk-secret-value-1234");
    expect(deleteProviderKey(u, "openai")).toBe(true);
    expect(deleteProviderKey(u, "openai")).toBe(false); // already gone
    expect(listProviderKeys(u)).toHaveLength(0);
  });

  test("configuredProviders lists just the provider ids", () => {
    const u = makeUser();
    setProviderKey(u, "openai", "sk-secret-value-1234");
    setProviderKey(u, "groq", "gsk_secret_value_5678");
    expect(configuredProviders(u).sort()).toEqual(["groq", "openai"]);
  });

  test("getDecryptedProviderKey fails closed to null on a corrupt/rotated row", () => {
    const u = makeUser();
    // A row whose ciphertext can't be decrypted with the current key (garbage / rotated away).
    db.insert(providerKeys).values({ userId: u, provider: "openai", ciphertext: "not.valid.cipher", last4: "0000" }).run();
    expect(getDecryptedProviderKey(u, "openai")).toBeNull();
    expect(listProviderKeys(u)).toHaveLength(1); // still listed (masked) — only decryption fails closed
  });

  test("getDecryptedProviderKey returns null when BYOK is off", () => {
    const u = makeUser();
    setProviderKey(u, "openai", "sk-secret-value-1234");
    (config.byok as unknown as { encryptionKey: string }).encryptionKey = "";
    expect(getDecryptedProviderKey(u, "openai")).toBeNull();
  });
});

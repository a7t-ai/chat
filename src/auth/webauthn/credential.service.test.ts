import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../../db/index.ts";
import { users, webauthnCredentials } from "../../db/schema.ts";
import {
  deleteCredential,
  excludeCredentialIds,
  getCredentialByCredentialId,
  listCredentials,
  storeCredential,
  updateSignCount,
} from "./credential.service.ts";
import { WebauthnError } from "./verify.ts";

afterEach(() => {
  db.delete(webauthnCredentials).run();
  db.delete(users).run();
});

function makeUser(): string {
  const row = db.insert(users).values({ login: `u-${Math.random().toString(36).slice(2)}`, role: "account" }).returning().get();
  return row!.id;
}

const JWK = JSON.stringify({ kty: "EC", crv: "P-256", x: "AA", y: "BB" });

describe("storeCredential", () => {
  test("stores + returns the row, and listCredentials masks to a safe view", () => {
    const userId = makeUser();
    const row = storeCredential({ userId, credentialId: "cred-1", publicKey: JWK, signCount: 3, label: "Laptop" });
    expect(row.userId).toBe(userId);
    const list = listCredentials(userId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: row.id, label: "Laptop", lastUsedAt: null });
    // The public-key material is never in the client view.
    expect(JSON.stringify(list[0])).not.toContain("P-256");
  });

  test("rejects a duplicate credential id (globally unique) with 409", () => {
    const a = makeUser();
    const b = makeUser();
    storeCredential({ userId: a, credentialId: "dup", publicKey: JWK, signCount: 0 });
    expect(() => storeCredential({ userId: b, credentialId: "dup", publicKey: JWK, signCount: 0 })).toThrow(WebauthnError);
    try {
      storeCredential({ userId: b, credentialId: "dup", publicKey: JWK, signCount: 0 });
    } catch (e) {
      expect((e as WebauthnError).status).toBe(409);
    }
  });
});

describe("lookup + exclude", () => {
  test("getCredentialByCredentialId resolves the owning account", () => {
    const userId = makeUser();
    storeCredential({ userId, credentialId: "look", publicKey: JWK, signCount: 0 });
    expect(getCredentialByCredentialId("look")?.userId).toBe(userId);
    expect(getCredentialByCredentialId("missing")).toBeUndefined();
  });

  test("excludeCredentialIds lists only the account's credential ids", () => {
    const a = makeUser();
    const b = makeUser();
    storeCredential({ userId: a, credentialId: "a1", publicKey: JWK, signCount: 0 });
    storeCredential({ userId: a, credentialId: "a2", publicKey: JWK, signCount: 0 });
    storeCredential({ userId: b, credentialId: "b1", publicKey: JWK, signCount: 0 });
    expect(excludeCredentialIds(a).sort()).toEqual(["a1", "a2"]);
  });
});

describe("updateSignCount", () => {
  test("advances the counter + stamps last-used", () => {
    const userId = makeUser();
    const row = storeCredential({ userId, credentialId: "c", publicKey: JWK, signCount: 0 });
    const now = new Date("2026-03-03T03:03:03Z");
    updateSignCount(row.id, 42, now);
    const after = getCredentialByCredentialId("c");
    expect(after?.signCount).toBe(42);
    expect(after?.lastUsedAt?.getTime()).toBe(now.getTime());
  });
});

describe("deleteCredential", () => {
  test("removes only the caller's own credential", () => {
    const a = makeUser();
    const b = makeUser();
    const row = storeCredential({ userId: a, credentialId: "del", publicKey: JWK, signCount: 0 });
    // Another account can't delete it (scoped) — no-op, no oracle.
    expect(deleteCredential(b, row.id)).toBe(false);
    expect(deleteCredential(a, row.id)).toBe(true);
    expect(getCredentialByCredentialId("del")).toBeUndefined();
    // Deleting again is a clean false.
    expect(deleteCredential(a, row.id)).toBe(false);
  });
});

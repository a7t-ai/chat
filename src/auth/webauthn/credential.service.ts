import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { webauthnCredentials } from "../../db/schema.ts";
import type { WebauthnCredential } from "../../db/schema.ts";
import { WebauthnError } from "./verify.ts";

// The passkey credential vault (#20): store / list / resolve / remove a user's registered passkeys.
// Reads/writes are scoped to the owning account EXCEPT `getCredentialByCredentialId`, which is the
// login lookup — a passkey login is usernameless, so it resolves the account FROM the credential id
// (globally unique) rather than the other way round. Only the PUBLIC key is stored; there is no
// secret here.

// The client-facing view of a passkey — never the public-key material, just enough to manage it.
export interface PasskeyView {
  id: string;
  label: string | null;
  createdAt: number; // epoch ms
  lastUsedAt: number | null; // epoch ms, null until first use
}

function toView(row: WebauthnCredential): PasskeyView {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.getTime(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
  };
}

// The caller's passkeys, newest first. Scoped to `userId` — never another account's.
export function listCredentials(userId: string): PasskeyView[] {
  return db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .orderBy(desc(webauthnCredentials.createdAt))
    .all()
    .map(toView);
}

// The credential ids already registered to this account — fed to the register options'
// `excludeCredentials` so an authenticator won't create a duplicate on the same account.
export function excludeCredentialIds(userId: string): string[] {
  return db
    .select({ credentialId: webauthnCredentials.credentialId })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
    .all()
    .map((r) => r.credentialId);
}

// The login lookup: resolve a credential (and thus its owning account) from its globally-unique id.
export function getCredentialByCredentialId(credentialId: string): WebauthnCredential | undefined {
  return db.select().from(webauthnCredentials).where(eq(webauthnCredentials.credentialId, credentialId)).get();
}

export interface StoreCredentialInput {
  userId: string;
  credentialId: string;
  publicKey: string; // JWK JSON
  signCount: number;
  transports?: string | null;
  label?: string | null;
}

// Persist a freshly-verified passkey. A credential id already on file — for THIS or ANY account — is
// a conflict (409): the credential is globally unique, so re-registering it is a no-op the client
// should treat as "already added". The unique index is the ultimate arbiter (a race falls through to
// the same 409).
export function storeCredential(input: StoreCredentialInput): WebauthnCredential {
  if (getCredentialByCredentialId(input.credentialId)) {
    throw new WebauthnError("passkey already registered", 409);
  }
  try {
    const row = db
      .insert(webauthnCredentials)
      .values({
        userId: input.userId,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        signCount: input.signCount,
        transports: input.transports ?? null,
        label: input.label ?? null,
      })
      .returning()
      .get();
    if (!row) throw new WebauthnError("failed to store passkey", 500);
    return row;
  } catch (e) {
    if (e instanceof WebauthnError) throw e;
    // Unique-constraint race: another concurrent register committed the same credential id first.
    throw new WebauthnError("passkey already registered", 409);
  }
}

// Advance a credential's signature counter + stamp last-used, after a successful assertion.
export function updateSignCount(id: string, signCount: number, now: Date = new Date()): void {
  db.update(webauthnCredentials).set({ signCount, lastUsedAt: now }).where(eq(webauthnCredentials.id, id)).run();
}

// Remove one of the caller's passkeys. Scoped to `userId`, so another account's id is a no-op
// (returns false) — never an existence oracle, never a cross-account delete.
export function deleteCredential(userId: string, id: string): boolean {
  const removed = db
    .delete(webauthnCredentials)
    .where(and(eq(webauthnCredentials.userId, userId), eq(webauthnCredentials.id, id)))
    .returning({ id: webauthnCredentials.id })
    .all();
  return removed.length > 0;
}

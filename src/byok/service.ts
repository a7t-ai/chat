import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { providerKeys } from "../db/schema.ts";
import { decryptSecret, encryptionAvailable, encryptSecret } from "./crypto.ts";
import { isProvider } from "./providers.ts";

// The BYOK key vault (#14): store / list / remove a paid account's own frontier-provider keys, and
// the ONE seam the chat runner consults to spend one (`getDecryptedProviderKey`). Everything is
// scoped by `userId`, so an account can only ever touch its OWN keys — there is no path that
// returns another user's key or ciphertext. The plaintext key leaves this module in exactly one
// direction: `getDecryptedProviderKey`, for the turn that runs on it. Listing returns only the
// provider + a `last4` masking hint, never the ciphertext.

export class ByokError extends Error {
  // Only the statuses the routes actually emit (bad request / feature dark) — a literal union so
  // Hono's `c.json(body, status)` accepts it directly.
  constructor(message: string, public readonly status: 400 | 503) {
    super(message);
    this.name = "ByokError";
  }
}

// A stored key as the client sees it — provider + a non-sensitive masking hint. Never the secret.
export interface StoredKey {
  provider: string;
  last4: string;
  updatedAt: Date;
}

// Bounds on a raw provider key. Real frontier keys are ~40–200 chars; the window is generous but
// rejects the obviously-empty (a fat-fingered blank) and the obviously-abusive (a megabyte blob
// that would bloat the column / the encrypt call).
const MIN_KEY_LEN = 8;
const MAX_KEY_LEN = 500;

// Whether BYOK can operate at all on this server (an encryption key is configured). Mirrors the
// web-search `available` gate: with no key, storing is refused and the feature stays dark.
export function byokAvailable(): boolean {
  return encryptionAvailable();
}

// Store (or replace) the caller's key for a provider. Validates the provider against the catalog
// and the key against length bounds, encrypts, and upserts on (userId, provider). Returns the
// masked view. Throws ByokError (4xx/503) on any rejection.
export function setProviderKey(userId: string, provider: string, rawKey: string): StoredKey {
  if (!byokAvailable()) throw new ByokError("BYOK is not configured on this server", 503);
  if (!isProvider(provider)) throw new ByokError("unknown provider", 400);
  const value = rawKey.trim();
  if (value.length < MIN_KEY_LEN || value.length > MAX_KEY_LEN) {
    throw new ByokError("invalid API key", 400);
  }
  const ciphertext = encryptSecret(value);
  const last4 = value.slice(-4);
  const now = new Date();
  db.insert(providerKeys)
    .values({ userId, provider, ciphertext, last4, updatedAt: now })
    .onConflictDoUpdate({
      target: [providerKeys.userId, providerKeys.provider],
      set: { ciphertext, last4, updatedAt: now },
    })
    .run();
  return { provider, last4, updatedAt: now };
}

// The caller's stored keys, masked — provider + last4 + when it was set. Never the ciphertext.
export function listProviderKeys(userId: string): StoredKey[] {
  return db
    .select({ provider: providerKeys.provider, last4: providerKeys.last4, updatedAt: providerKeys.updatedAt })
    .from(providerKeys)
    .where(eq(providerKeys.userId, userId))
    .all();
}

// Remove the caller's key for a provider. Returns whether a row was actually deleted.
export function deleteProviderKey(userId: string, provider: string): boolean {
  const removed = db
    .delete(providerKeys)
    .where(and(eq(providerKeys.userId, userId), eq(providerKeys.provider, provider)))
    .returning({ id: providerKeys.id })
    .all();
  return removed.length > 0;
}

// The provider ids the caller has configured — for the /api/me presence hint (drives which
// providers the settings panel shows as connected).
export function configuredProviders(userId: string): string[] {
  return listProviderKeys(userId).map((k) => k.provider);
}

// The consumption seam: the decrypted key for (user, provider), or null if there is none / BYOK is
// off / the stored ciphertext no longer decrypts (a rotated-away or corrupt key). Fail-closed by
// design — a null here routes the turn back to the shared local router rather than erroring, so a
// bad row can never break a generation.
export function getDecryptedProviderKey(userId: string, provider: string): string | null {
  if (!byokAvailable()) return null;
  const row = db
    .select({ ciphertext: providerKeys.ciphertext })
    .from(providerKeys)
    .where(and(eq(providerKeys.userId, userId), eq(providerKeys.provider, provider)))
    .get();
  if (!row) return null;
  try {
    return decryptSecret(row.ciphertext);
  } catch {
    return null; // corrupt / rotated key → treat as absent
  }
}

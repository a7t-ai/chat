import { and, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";

// User directory (#190) — the "find each other on this instance" surface built on account handles
// (#189). This module is the QUERY + SHAPE boundary: it returns ONLY public identity fields (handle,
// a public display name, and the stable user id) so a caller can browse who else is here (and, next,
// invite them to collaborate — #177). It is deliberately narrow: NEVER email (accounts carry none),
// NEVER the synthetic `acct_<uuid>` login, NEVER plan/usage/preferences or any private data. Every
// listed row is an account that OPTED IN by setting a handle — a handle-less row is never surfaced
// (it would be a raw uuid or nothing), so there is no way to enumerate anonymous accounts. Results
// are always bounded (search + a hard cap) and scoped to exclude the caller (you don't find yourself).

// The hard cap on how many directory rows one call can return, so the listing is always bounded no
// matter the instance size. Search narrows within this ceiling; there is no offset/paging yet (the
// bounded search is the scoping mechanism), and the cap is the ceiling for #177's invite picker too.
export const DIRECTORY_LIMIT = 50;

// The longest search needle we honor. A directory search is a short handle/name fragment; anything
// longer is clamped so a caller can't push a pathological pattern into the LIKE.
export const DIRECTORY_QUERY_MAX = 64;

// One directory row — the ONLY fields that ever leave this module. `id` is the stable user id
// (what #177's invite will bind to), `handle` the opted-in public handle, `name` the public display
// name (see `directoryName`). No email, no login, no plan — nothing private.
export interface DirectoryEntry {
  id: string;
  handle: string;
  name: string;
}

// PURE: the public display name for a directory row. Mirrors the SAFE half of the client's
// `displayNameOf` precedence (`web/src/lib/identity.ts`) — a real display name the user set, else
// their handle — but DELIBERATELY stops there: it never falls through to email or the synthetic
// `acct_<uuid>` login, so a directory row can never leak a private identifier even if a future caller
// widened the projection. Every listed row has a handle, so this always resolves to a real string.
export function directoryName(row: { handle: string | null; displayName: string | null }): string {
  const dn = row.displayName?.trim();
  if (dn && dn.length > 0) return dn;
  return row.handle ?? "";
}

// PURE: normalize a raw `?q=` into a bounded, lowercased LIKE needle with the LIKE wildcards
// (`%` `_`) and the escape char (`\`) neutralized — or null when empty. Lowercasing matches the way
// handles are stored (and the `lower(handle)` index), and escaping means a user typing "a_b" or
// "50%" searches for those literal characters, not a wildcard. Clamped to DIRECTORY_QUERY_MAX.
export function directoryQuery(raw: unknown): string | null {
  const q = (typeof raw === "string" ? raw : "").trim().toLowerCase().slice(0, DIRECTORY_QUERY_MAX);
  if (q.length === 0) return null;
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// List directory entries — accounts that set a handle, excluding the caller — optionally filtered by
// a handle/name search, always capped. The WHERE is scoped three ways: `handle IS NOT NULL` (only
// opted-in rows; the many legacy null-handle rows never surface), `id != caller` (you don't find
// yourself), and — when searching — a lowercased, wildcard-escaped LIKE across handle + display name.
// Ordered by lower(handle) for a stable listing. The projection is handle + display name + id ONLY;
// email/login/plan/usage never enter the query, so they can't leak.
export function listDirectory(callerId: string, rawQuery?: unknown, limit = DIRECTORY_LIMIT): DirectoryEntry[] {
  const needle = directoryQuery(rawQuery);
  const where = [isNotNull(users.handle), ne(users.id, callerId)];
  if (needle) {
    const like = `%${needle}%`;
    where.push(
      or(
        sql`lower(${users.handle}) like ${like} escape '\\'`,
        sql`lower(${users.displayName}) like ${like} escape '\\'`,
      )!,
    );
  }
  const rows = db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName })
    .from(users)
    .where(and(...where))
    .orderBy(sql`lower(${users.handle})`)
    .limit(Math.max(1, Math.min(limit, DIRECTORY_LIMIT)))
    .all();
  return rows.map((r) => ({ id: r.id, handle: r.handle as string, name: directoryName(r) }));
}

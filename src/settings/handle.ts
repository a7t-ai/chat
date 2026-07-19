import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";

// Account handles (#189) — a user-chosen, unique, CHANGEABLE public identifier layered on top of a
// passkey account's synthetic `acct_<uuid>` login. This module is the SECURITY / ROBUSTNESS boundary
// for the feature, mirroring `preferences.ts`: `validateHandle` is a PURE, exhaustively unit-tested
// gate (charset + length + canonical lowercasing) that every write crosses, and `setHandle` layers
// the uniqueness pre-check + the caller-scoped DB write on top. Server-side validation is
// authoritative; the client's checks are only UX. Foundation for the user directory (#190) and
// identity-bound collaboration invites (#177).

// ---- Bounds (the enforced limits) -----------------------------------------

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;
// The ONLY allowed charset: lowercase ASCII letters, digits, and underscore. Deliberately tight —
// no dots/dashes/unicode — so a handle is a safe, unambiguous URL/mention token for the directory
// and invites. We lowercase BEFORE testing, so a user typing "Leo_42" claims "leo_42".
export const HANDLE_RE = /^[a-z0-9_]+$/;

// Why a candidate failed, in a form the API + UI can map to a friendly, localizable message. A handle
// is purely public identity (#189) now — the owner is designated at sign-up, not by holding a special
// handle (#191) — so there is no reservation: validation + uniqueness are the only outcomes.
export type HandleError = "charset" | "length" | "taken";

export type HandleValidation = { ok: true; handle: string } | { ok: false; error: "charset" | "length" };

// PURE: normalize (trim + lowercase) then enforce length + charset. Lowercasing first makes handles
// case-insensitive at the source (the stored value is always the canonical lowercase form) and is
// checked BEFORE charset so an uppercase-only input degrades to a valid lowercase handle rather than
// a spurious charset error. No I/O — this is the piece we test to death.
export function validateHandle(raw: unknown): HandleValidation {
  const h = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  if (h.length < HANDLE_MIN || h.length > HANDLE_MAX) return { ok: false, error: "length" };
  if (!HANDLE_RE.test(h)) return { ok: false, error: "charset" };
  return { ok: true, handle: h };
}

// Is the (already-normalized, lowercase) handle free for `userId` to claim? Case-insensitive — the
// comparison is on lower(handle), matching the DB's unique index — and a user may KEEP their own
// handle (re-saving the same value is never a collision). Scoped so this only ever answers about
// OTHER accounts' rows.
export function handleAvailable(handle: string, userId: string): boolean {
  const clash = db
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.handle}) = ${handle}`, ne(users.id, userId)))
    .get();
  return clash === null || clash === undefined;
}

export type SetHandleResult = { ok: true; handle: string } | { ok: false; error: HandleError };

// Set (or change) a user's handle. Validate → friendly uniqueness pre-check → write, scoped to
// `userId` (a caller can only ever set their OWN handle). The `lower(handle)` UNIQUE index is the
// AUTHORITATIVE guard: a concurrent claim that slips past the pre-check still fails closed at the DB,
// and we surface that as the same friendly `taken` rather than a 500. Uniqueness + charset + length
// are all enforced here on the server, never trusting the client.
export function setHandle(userId: string, raw: unknown): SetHandleResult {
  const v = validateHandle(raw);
  if (!v.ok) return v;
  // A handle is purely public identity (#189): the owner is designated at sign-up (#191), never by
  // holding a special handle, so there is nothing to reserve — validation + uniqueness are the guards.
  if (!handleAvailable(v.handle, userId)) return { ok: false, error: "taken" };
  try {
    db.update(users).set({ handle: v.handle }).where(eq(users.id, userId)).run();
  } catch {
    // The unique index is the real backstop — a race that beat the pre-check trips the constraint
    // here. Report the friendly collision, not an unhandled 500.
    return { ok: false, error: "taken" };
  }
  return { ok: true, handle: v.handle };
}

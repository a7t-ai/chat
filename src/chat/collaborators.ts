import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  type Collaborator,
  type CollaboratorRole,
  conversationCollaborators,
  type Conversation,
  conversations,
  users,
} from "../db/schema.ts";

// The Share PRIMITIVE's data layer — the identity-bound collaboration grant, the parallel to
// the public, no-login PUBLISH primitive in `shares.ts`. A grant binds a SPECIFIC account to a
// SPECIFIC conversation so the invitee reaches the SAME object (it surfaces in their own app),
// authenticated and revocable — never a link. Everything owner-facing is scoped by the owner's
// id so one account can never grant, read, or revoke another account's collaborators; the
// invitee-facing reads are scoped by the collaborator's id. The access resolver is the single
// seam the conversation read/stream routes consult to admit owner OR collaborator.

// The role tiers, lowest → highest privilege. `view` (read + watch live) is the wired path
// today; `suggest`/`edit`/`prompt` are reserved for the collaborative-chat layer (#46) that
// builds on this primitive. Ordered so a numeric rank can answer "does this role include X?".
export const COLLABORATOR_ROLES: readonly CollaboratorRole[] = ["view", "suggest", "edit", "prompt"];

export function isCollaboratorRole(value: unknown): value is CollaboratorRole {
  return typeof value === "string" && (COLLABORATOR_ROLES as readonly string[]).includes(value);
}

// Privilege rank — higher includes everything lower. Used by the capability helpers so the
// route layer never hard-codes a role string.
function roleRank(role: CollaboratorRole): number {
  return COLLABORATOR_ROLES.indexOf(role);
}

// May a holder of this role START a turn in the shared conversation? Only `prompt` (the top
// tier). The owner is always allowed and is handled separately (they aren't a collaborator).
export function canPrompt(role: CollaboratorRole): boolean {
  return roleRank(role) >= roleRank("prompt");
}

// May a holder of this role EDIT the conversation's content — today, tick a shared TODO
// checkbox (#131)? `edit` and above (edit/prompt); `view`/`suggest` stay read + live-watch only.
// The owner is always allowed and is handled separately (they aren't a collaborator). Kept as a
// capability helper so the route never hard-codes a role string.
export function canEditContent(role: CollaboratorRole): boolean {
  return roleRank(role) >= roleRank("edit");
}

// Every role grants read + live-watch of the shared conversation — that is the floor of the
// primitive (the invitee always at least sees the object). Kept explicit so the seam reads
// clearly and a future "no-access pending" tier could return false here.
export function canView(_role: CollaboratorRole): boolean {
  return true;
}

// A collaborator row joined to the invited user's identity — what the OWNER sees when managing
// who they shared a conversation with. The owner invited these people by their public HANDLE
// (#189), so echoing the handle + a public display name back is expected; email is NEVER included
// (passkey accounts carry none, and collaboration is identity-bound by handle, not by email).
export interface CollaboratorListing {
  userId: string;
  handle: string | null;
  displayName: string | null;
  role: CollaboratorRole;
  createdAt: Date;
}

// A conversation shared WITH the caller — the invitee's "shared with me" view. Carries the
// owner's display name (identity-bound collaboration deliberately reveals who shared it, unlike
// the identity-free PUBLISH snapshot) but never the owner's email or any other account detail.
export interface SharedConversationListing {
  id: string;
  title: string | null;
  model: string | null;
  updatedAt: Date;
  role: CollaboratorRole;
  ownerName: string; // owner's displayName ?? login — the minimal identity, never their email
}

// The resolved access for a (user, conversation) pair: the conversation plus the caller's role
// on it ("owner" when they own it, else their granted collaborator role). null = no access at
// all (unknown conversation, or one neither owned nor shared with the caller). This is the ONE
// function the conversation read/stream routes use to admit a caller — it replaces the bare
// `WHERE id=? AND user_id=<caller>` owner-only check with "owner OR collaborator".
export type ConversationAccess =
  | { conversation: Conversation; role: "owner" }
  | { conversation: Conversation; role: CollaboratorRole };

export function resolveConversationAccess(userId: string, conversationId: string): ConversationAccess | null {
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv) return null;
  if (conv.userId === userId) return { conversation: conv, role: "owner" };
  const grant = getCollaboration(userId, conversationId);
  if (grant) return { conversation: conv, role: grant.role };
  return null;
}

// May `userId` START a turn (send a prompt) in `conversationId`? This is the ONE seam the
// chat send path (POST /chat) consults for an existing conversation — the authorized
// collaborative WRITE (#46), distinct from the read/watch resolver above. Three outcomes:
//   - ok: the owner (always) OR a collaborator whose role includes `prompt` (canPrompt).
//   - forbidden: the caller CAN see the conversation (a view/suggest/edit grant) but may not
//     send — a clean 403, never an existence oracle (they already know it exists).
//   - not_found: no access at all (unknown conversation, or one neither owned nor shared) —
//     the same 404 a stranger sees, so ownership is never leaked.
// The conversation carries its OWNER (`conversation.userId`); the caller is the prompter. The
// route uses the owner for memory (facts/summary/recall/embeddings stay the owner's) and the
// prompter's auth for budget / rate limit / model allowlist / usage attribution.
export type PromptAccess =
  | { ok: true; conversation: Conversation; role: "owner" | CollaboratorRole }
  | { ok: false; reason: "not_found" | "forbidden" };

export function resolvePromptAccess(userId: string, conversationId: string): PromptAccess {
  const access = resolveConversationAccess(userId, conversationId);
  if (!access) return { ok: false, reason: "not_found" };
  if (access.role === "owner" || canPrompt(access.role)) {
    return { ok: true, conversation: access.conversation, role: access.role };
  }
  return { ok: false, reason: "forbidden" };
}

// The grant for a specific (collaborator, conversation) pair, or null. Scoped by the
// collaborator's id — the invitee-side lookup the access resolver rides on.
export function getCollaboration(userId: string, conversationId: string): Collaborator | null {
  const row = db
    .select()
    .from(conversationCollaborators)
    .where(and(eq(conversationCollaborators.conversationId, conversationId), eq(conversationCollaborators.userId, userId)))
    .get();
  return row ?? null;
}

// Does `ownerId` actually own `conversationId`? The guard every owner-facing mutation runs
// first, so a non-owner can never invite/list/change/revoke collaborators on a chat that
// isn't theirs (the route surfaces a false here as a 404 — no existence oracle).
function ownsConversation(ownerId: string, conversationId: string): boolean {
  const owns = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, ownerId)))
    .get();
  return !!owns;
}

export type InviteResult =
  | { ok: true; collaborator: Collaborator }
  | { ok: false; reason: "not_owner" | "no_account" | "self" };

// Invite an existing account (by its public HANDLE, #189) to collaborate on a conversation the
// caller owns. Identity-bound: the handle must resolve to a real account — there are no pending
// invites here (that's a deliberate follow-up), so the grant always points at a known identity.
// Resolving by handle (not email) is what makes this work for passkey accounts, which carry no
// email at all (#177). Idempotent UPSERT: re-inviting someone already on the conversation UPDATES
// their role in place (the unique(conversationId,userId) index guarantees one grant per person).
//   - not_owner: the conversation isn't the caller's (route → 404, no existence oracle).
//   - no_account: no account has that handle (route → 404 with a clear message, no existence oracle).
//   - self: you can't invite yourself to your own conversation.
export function inviteCollaborator(
  ownerId: string,
  conversationId: string,
  handle: string,
  role: CollaboratorRole,
): InviteResult {
  if (!ownsConversation(ownerId, conversationId)) return { ok: false, reason: "not_owner" };

  // Match CASE-INSENSITIVELY on the stored (always-lowercased) handle — the same `lower(handle)` the
  // unique index enforces (src/settings/handle.ts), so "Leo_42" resolves the account that claimed
  // "leo_42". A handle-less legacy account can never be found here (it opted out of the directory),
  // and a miss is a clean no_account → 404, never an existence oracle.
  const needle = handle.trim().toLowerCase();
  const target = needle ? db.select().from(users).where(sql`lower(${users.handle}) = ${needle}`).get() : undefined;
  if (!target) return { ok: false, reason: "no_account" };
  if (target.id === ownerId) return { ok: false, reason: "self" };

  const existing = getCollaboration(target.id, conversationId);
  if (existing) {
    if (existing.role !== role) {
      db.update(conversationCollaborators).set({ role }).where(eq(conversationCollaborators.id, existing.id)).run();
      return { ok: true, collaborator: { ...existing, role } };
    }
    return { ok: true, collaborator: existing };
  }

  try {
    const created = db
      .insert(conversationCollaborators)
      .values({ conversationId, userId: target.id, role, invitedBy: ownerId })
      .returning()
      .get();
    return { ok: true, collaborator: created };
  } catch {
    // Race: a concurrent invite for the same (conversation, person) won the unique index between
    // our find and this insert. Resolve to the row that landed rather than 500.
    const row = getCollaboration(target.id, conversationId);
    if (row) return { ok: true, collaborator: row };
    throw new Error("failed to create collaborator");
  }
}

// The owner's view of who can reach a conversation they own (drives the "manage people" UI).
// Returns null when the conversation isn't the caller's, so the route 404s rather than leaking
// the collaborator list of someone else's chat. Newest grant first.
export function listCollaborators(ownerId: string, conversationId: string): CollaboratorListing[] | null {
  if (!ownsConversation(ownerId, conversationId)) return null;
  const rows = db
    .select({
      userId: conversationCollaborators.userId,
      handle: users.handle,
      displayName: users.displayName,
      role: conversationCollaborators.role,
      createdAt: conversationCollaborators.createdAt,
    })
    .from(conversationCollaborators)
    .innerJoin(users, eq(conversationCollaborators.userId, users.id))
    .where(eq(conversationCollaborators.conversationId, conversationId))
    .orderBy(desc(conversationCollaborators.createdAt))
    .all();
  return rows;
}

// The invitee's "shared with me": every conversation shared WITH this user, with the owner's
// display name + the caller's role. Scoped by the collaborator id, so it only ever returns
// grants made to THIS caller. Most-recently-active conversation first.
export function listSharedWithUser(userId: string): SharedConversationListing[] {
  const rows = db
    .select({
      id: conversations.id,
      title: conversations.title,
      model: conversations.model,
      updatedAt: conversations.updatedAt,
      role: conversationCollaborators.role,
      ownerDisplayName: users.displayName,
      ownerLogin: users.login,
    })
    .from(conversationCollaborators)
    .innerJoin(conversations, eq(conversationCollaborators.conversationId, conversations.id))
    .innerJoin(users, eq(conversations.userId, users.id))
    .where(eq(conversationCollaborators.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .all();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    model: r.model,
    updatedAt: r.updatedAt,
    role: r.role,
    ownerName: r.ownerDisplayName ?? r.ownerLogin,
  }));
}

// Change a collaborator's role (owner-only). Returns false when the conversation isn't the
// caller's OR the target isn't actually a collaborator on it — the route 404s either way.
export function updateCollaboratorRole(
  ownerId: string,
  conversationId: string,
  collaboratorUserId: string,
  role: CollaboratorRole,
): boolean {
  if (!ownsConversation(ownerId, conversationId)) return false;
  const updated = db
    .update(conversationCollaborators)
    .set({ role })
    .where(
      and(
        eq(conversationCollaborators.conversationId, conversationId),
        eq(conversationCollaborators.userId, collaboratorUserId),
      ),
    )
    .returning({ id: conversationCollaborators.id })
    .all();
  return updated.length > 0;
}

// Revoke a collaborator (owner-only) — DELETE the grant so the invitee loses access the instant
// their next request resolves (the access seam re-checks every call). Returns whether a grant
// was actually removed; a non-owner or unknown target is a no-op false (route → 404).
export function removeCollaborator(ownerId: string, conversationId: string, collaboratorUserId: string): boolean {
  if (!ownsConversation(ownerId, conversationId)) return false;
  const removed = db
    .delete(conversationCollaborators)
    .where(
      and(
        eq(conversationCollaborators.conversationId, conversationId),
        eq(conversationCollaborators.userId, collaboratorUserId),
      ),
    )
    .returning({ id: conversationCollaborators.id })
    .all();
  return removed.length > 0;
}

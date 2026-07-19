import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { conversations, type Share, shares } from "../db/schema.ts";
import { toggleConversationTodo } from "./todos.ts";

// The shareable-live-collab primitive's data layer. A share is the opt-in, revocable grant
// that turns a PRIVATE conversation into one anyone with the link can watch live. The slug
// is a public, unguessable URL token — it is the capability itself (a read-only watch link),
// so it is stored in plaintext and re-displayable, unlike the hashed-at-rest invite/session
// tokens. Everything here is scoped to the owner; the public read path looks up by slug only.

// 16 random bytes (128 bits) as url-safe base64 → unguessable but link-friendly. No prefix:
// a share slug is a public link token, not an `a7t_`-style bearer credential.
export function generateSlug(): string {
  return randomBytes(16).toString("base64url");
}

// The public watch URL for a slug — used in the owner's "copy link" affordance. Built from
// APP_URL so it points at the real origin (a7t.chat) regardless of how the app is reached.
export function shareUrl(slug: string): string {
  return `${config.appUrl.replace(/\/+$/, "")}/s/${slug}`;
}

// The owner's existing share for a conversation they own (null when not shared, or when the
// conversation isn't theirs). Scoped by userId so one account can never read another's share.
export function getShareForConversation(userId: string, conversationId: string): Share | null {
  const row = db
    .select()
    .from(shares)
    .where(and(eq(shares.conversationId, conversationId), eq(shares.userId, userId)))
    .get();
  return row ?? null;
}

// Look up a share by its public slug — the ONLY entry point the no-login watch path uses.
// Returns null for an unknown/revoked (deleted) slug, which the route surfaces as a 404.
export function getShareBySlug(slug: string): Share | null {
  const row = db.select().from(shares).where(eq(shares.slug, slug)).get();
  return row ?? null;
}

// Opt in to sharing a conversation the caller owns. Find-or-create: idempotent, so re-sharing
// an already-shared conversation returns the SAME slug (the link is stable while shared).
// Returns null when the conversation isn't the caller's (so the route 404s rather than
// minting a share that points at someone else's chat). At most one share per conversation
// (enforced by the unique conversationId index + this find-first).
export function createShare(userId: string, conversationId: string): Share | null {
  const owns = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .get();
  if (!owns) return null;

  const existing = getShareForConversation(userId, conversationId);
  if (existing) return existing;

  try {
    return db
      .insert(shares)
      .values({ conversationId, userId, slug: generateSlug() })
      .returning()
      .get();
  } catch {
    // Race: a concurrent share-create for the same conversation won the unique(conversationId)
    // index between our find and this insert. Resolve to the row that landed (stable link),
    // never a 500.
    return getShareForConversation(userId, conversationId);
  }
}

// Stop sharing — DELETE the row so the old slug dies immediately (a revoked link must 404,
// not linger). Scoped to the owner; returns whether a share was actually removed.
export function deleteShare(userId: string, conversationId: string): boolean {
  const existing = getShareForConversation(userId, conversationId);
  if (!existing) return false;
  db.delete(shares).where(eq(shares.id, existing.id)).run();
  return true;
}

// Tick/untick a TODO checkbox on a shared page (#45) — the ONE write the public watch link
// permits. Scoped to `conversationId` (resolved from the share slug by the caller), so a write
// token minted for one share can never edit another conversation's messages. Delegates to the
// shared `toggleConversationTodo` primitive (src/chat/todos.ts) — the same narrow, single-checkbox
// write the owner-side route rides — so a leaked token can only toggle checkboxes, never arbitrary
// content. Returns the updated content, or null when the message isn't in this conversation or the
// index is out of range (the route surfaces that as a clean 404 no-op).
export function toggleSharedTodo(
  conversationId: string,
  messageId: string,
  index: number,
  done: boolean,
): { content: string } | null {
  return toggleConversationTodo(conversationId, messageId, index, done);
}

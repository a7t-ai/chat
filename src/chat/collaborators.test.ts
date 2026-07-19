import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { conversationCollaborators, conversations, users } from "../db/schema.ts";
import {
  canEditContent,
  canPrompt,
  canView,
  COLLABORATOR_ROLES,
  getCollaboration,
  inviteCollaborator,
  isCollaboratorRole,
  listCollaborators,
  listSharedWithUser,
  removeCollaborator,
  resolveConversationAccess,
  resolvePromptAccess,
  updateCollaboratorRole,
} from "./collaborators.ts";

// The Share PRIMITIVE's data layer: identity-bound grants resolved by public HANDLE (#189, #177),
// owner-scoping (no cross-user grant/read/revoke), the access resolver (owner OR collaborator), and
// revoke-by-delete. Uses the isolated temp DB (setup.ts). This is the security-critical seam —
// cross-user isolation + the "handle in, never email out" payload shape are tested hard.

let seq = 0;
function makeUser(opts: { handle?: string; email?: string; displayName?: string; login?: string } = {}): string {
  seq++;
  return db
    .insert(users)
    .values({
      login: opts.login ?? `u-${seq}-${Math.random()}`,
      role: "account",
      handle: opts.handle ?? null,
      email: opts.email ?? null,
      displayName: opts.displayName ?? null,
    })
    .returning()
    .get().id;
}
function makeConversation(userId: string, fields: { title?: string; model?: string } = {}): string {
  return db.insert(conversations).values({ userId, ...fields }).returning().get().id;
}

describe("role helpers", () => {
  test("COLLABORATOR_ROLES is the lowest→highest tier order", () => {
    expect(COLLABORATOR_ROLES).toEqual(["view", "suggest", "edit", "prompt"]);
  });

  test("isCollaboratorRole accepts only the four known roles", () => {
    for (const r of COLLABORATOR_ROLES) expect(isCollaboratorRole(r)).toBe(true);
    expect(isCollaboratorRole("owner")).toBe(false);
    expect(isCollaboratorRole("admin")).toBe(false);
    expect(isCollaboratorRole("")).toBe(false);
    expect(isCollaboratorRole(undefined)).toBe(false);
    expect(isCollaboratorRole(3)).toBe(false);
  });

  test("canPrompt is true only for the top (prompt) tier", () => {
    expect(canPrompt("prompt")).toBe(true);
    expect(canPrompt("edit")).toBe(false);
    expect(canPrompt("suggest")).toBe(false);
    expect(canPrompt("view")).toBe(false);
  });

  test("canView is true for every role (read is the floor of the primitive)", () => {
    for (const r of COLLABORATOR_ROLES) expect(canView(r)).toBe(true);
  });

  test("canEditContent is true for edit and above (the content-write tiers, #131)", () => {
    expect(canEditContent("edit")).toBe(true);
    expect(canEditContent("prompt")).toBe(true);
    // view/suggest stay read + live-watch only — no content write (a TODO tick is a write).
    expect(canEditContent("view")).toBe(false);
    expect(canEditContent("suggest")).toBe(false);
  });
});

describe("inviteCollaborator (by handle)", () => {
  test("grants an existing account access to the owner's conversation", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "alice" });
    const conv = makeConversation(owner);
    const res = inviteCollaborator(owner, conv, "alice", "view");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.collaborator.userId).toBe(invitee);
    expect(res.collaborator.role).toBe("view");
    expect(res.collaborator.invitedBy).toBe(owner);
  });

  test("resolves the handle case-insensitively (matching the lower(handle) index)", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "bob" }); // stored canonical lowercase
    const conv = makeConversation(owner);
    const res = inviteCollaborator(owner, conv, "  BOB  ", "edit");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.collaborator.userId).toBe(invitee);
  });

  test("refuses a conversation the caller does not own (no cross-user grant)", () => {
    const owner = makeUser();
    const other = makeUser();
    const invitee = makeUser({ handle: "carol" });
    const conv = makeConversation(owner);
    const res = inviteCollaborator(other, conv, "carol", "view");
    expect(res).toEqual({ ok: false, reason: "not_owner" });
    expect(getCollaboration(invitee, conv)).toBeNull();
  });

  test("refuses a handle with no matching account (no existence oracle)", () => {
    const owner = makeUser();
    const conv = makeConversation(owner);
    expect(inviteCollaborator(owner, conv, "nobody", "view")).toEqual({ ok: false, reason: "no_account" });
  });

  test("cannot reach a handle-less account (they opted out of the directory)", () => {
    const owner = makeUser();
    // An account that exists but never claimed a handle: it must be UNREACHABLE by invite. Even
    // though it has a legacy email, there is no way to name it (we resolve by handle only).
    makeUser({ email: "handleless@a7t.ai", displayName: "No Handle" });
    const conv = makeConversation(owner);
    expect(inviteCollaborator(owner, conv, "nohandle", "view")).toEqual({ ok: false, reason: "no_account" });
  });

  test("an empty/whitespace handle never matches (clean no_account, not the first row)", () => {
    const owner = makeUser();
    makeUser({ handle: "someone" });
    const conv = makeConversation(owner);
    expect(inviteCollaborator(owner, conv, "   ", "view")).toEqual({ ok: false, reason: "no_account" });
  });

  test("refuses inviting yourself to your own conversation", () => {
    const owner = makeUser({ handle: "selfowner" });
    const conv = makeConversation(owner);
    expect(inviteCollaborator(owner, conv, "SelfOwner", "view")).toEqual({ ok: false, reason: "self" });
  });

  test("is an idempotent upsert — re-inviting UPDATES the role in place (one grant per person)", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "dave" });
    const conv = makeConversation(owner);
    const first = inviteCollaborator(owner, conv, "dave", "view");
    const second = inviteCollaborator(owner, conv, "dave", "prompt");
    expect(first.ok && second.ok).toBe(true);
    expect(getCollaboration(invitee, conv)?.role).toBe("prompt");
    expect(
      db.select().from(conversationCollaborators).where(eq(conversationCollaborators.conversationId, conv)).all(),
    ).toHaveLength(1);
  });

  test("re-inviting with the SAME role is a no-op success (same grant)", () => {
    const owner = makeUser();
    makeUser({ handle: "erin" });
    const conv = makeConversation(owner);
    const first = inviteCollaborator(owner, conv, "erin", "suggest");
    const second = inviteCollaborator(owner, conv, "erin", "suggest");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.collaborator.id).toBe(first.collaborator.id);
  });
});

describe("resolveConversationAccess", () => {
  test("the owner resolves to role 'owner'", () => {
    const owner = makeUser();
    const conv = makeConversation(owner);
    const access = resolveConversationAccess(owner, conv);
    expect(access?.role).toBe("owner");
    expect(access?.conversation.id).toBe(conv);
  });

  test("a collaborator resolves to their granted role", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "frank" });
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "frank", "edit");
    expect(resolveConversationAccess(invitee, conv)?.role).toBe("edit");
  });

  test("a stranger (no grant) gets null — never another user's conversation", () => {
    const owner = makeUser();
    const stranger = makeUser();
    const conv = makeConversation(owner);
    expect(resolveConversationAccess(stranger, conv)).toBeNull();
  });

  test("an unknown conversation id is null", () => {
    const u = makeUser();
    expect(resolveConversationAccess(u, "does-not-exist")).toBeNull();
  });
});

// resolvePromptAccess — the authorized collaborative WRITE seam (#46). The owner always may
// send; a `prompt` collaborator may; a view/suggest/edit collaborator is `forbidden` (they can
// already read it, so this leaks nothing); anyone else is `not_found` (no existence oracle).
describe("resolvePromptAccess", () => {
  test("the owner may always send (role 'owner')", () => {
    const owner = makeUser();
    const conv = makeConversation(owner);
    const res = resolvePromptAccess(owner, conv);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.role).toBe("owner");
      expect(res.conversation.id).toBe(conv);
    }
  });

  test("a 'prompt' collaborator may send (role 'prompt')", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "prompter" });
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "prompter", "prompt");
    const res = resolvePromptAccess(invitee, conv);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.role).toBe("prompt");
      expect(res.conversation.userId).toBe(owner); // the conversation stays owned by its owner
    }
  });

  test("view / suggest / edit collaborators are forbidden (can read, may not send)", () => {
    for (const role of ["view", "suggest", "edit"] as const) {
      const owner = makeUser();
      const invitee = makeUser({ handle: `ro_${role}` });
      const conv = makeConversation(owner);
      inviteCollaborator(owner, conv, `ro_${role}`, role);
      expect(resolvePromptAccess(invitee, conv)).toEqual({ ok: false, reason: "forbidden" });
    }
  });

  test("a stranger with no grant is not_found (same as a missing conversation — no oracle)", () => {
    const owner = makeUser();
    const stranger = makeUser();
    const conv = makeConversation(owner);
    expect(resolvePromptAccess(stranger, conv)).toEqual({ ok: false, reason: "not_found" });
    expect(resolvePromptAccess(stranger, "does-not-exist")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("listCollaborators", () => {
  test("the owner sees who they invited (handle + display name + role) — NEVER an email", () => {
    const owner = makeUser();
    // Gina has a legacy email column set: it must NEVER surface in the owner-facing payload.
    makeUser({ handle: "gina", displayName: "Gina", email: "gina-secret@a7t.ai" });
    const hank = makeUser({ handle: "hank" });
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "gina", "view");
    inviteCollaborator(owner, conv, "hank", "prompt");
    const list = listCollaborators(owner, conv);
    expect(list).not.toBeNull();
    expect(list).toHaveLength(2);
    const gina = list!.find((c) => c.handle === "gina")!;
    expect(gina.displayName).toBe("Gina");
    expect(gina.role).toBe("view");
    const hankRow = list!.find((c) => c.userId === hank)!;
    expect(hankRow.handle).toBe("hank");
    expect(hankRow.role).toBe("prompt");
    // The collaborator payload reveals handle/display name but never an email (#177 security prop).
    expect(JSON.stringify(list)).not.toContain("gina-secret@a7t.ai");
    expect(JSON.stringify(list)).not.toContain("email");
  });

  test("newest grant first (ordered by createdAt desc)", () => {
    const owner = makeUser();
    const early = makeUser({ handle: "early" });
    const late = makeUser({ handle: "late" });
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "early", "view");
    inviteCollaborator(owner, conv, "late", "view");
    // Force distinct timestamps (a single test runs well within one ms, so the default
    // createdAt would tie and the order be undefined).
    db.update(conversationCollaborators).set({ createdAt: new Date(1000) }).where(eq(conversationCollaborators.userId, early)).run();
    db.update(conversationCollaborators).set({ createdAt: new Date(2000) }).where(eq(conversationCollaborators.userId, late)).run();
    const list = listCollaborators(owner, conv)!;
    expect(list.map((c) => c.userId)).toEqual([late, early]);
  });

  test("a non-owner gets null (never another chat's collaborator list)", () => {
    const owner = makeUser();
    const other = makeUser();
    const conv = makeConversation(owner);
    expect(listCollaborators(other, conv)).toBeNull();
  });

  test("an owner with no collaborators yet sees an empty list (not null)", () => {
    const owner = makeUser();
    const conv = makeConversation(owner);
    expect(listCollaborators(owner, conv)).toEqual([]);
  });
});

describe("listSharedWithUser", () => {
  test("returns conversations shared WITH the caller, with the owner's name + role", () => {
    const owner = makeUser({ displayName: "Owner Oona", login: "oona" });
    const invitee = makeUser({ handle: "ivy" });
    const conv = makeConversation(owner, { title: "Shared chat" });
    inviteCollaborator(owner, conv, "ivy", "view");
    const shared = listSharedWithUser(invitee);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.id).toBe(conv);
    expect(shared[0]!.title).toBe("Shared chat");
    expect(shared[0]!.role).toBe("view");
    expect(shared[0]!.ownerName).toBe("Owner Oona");
  });

  test("falls back to the owner's login when they have no display name (never their email)", () => {
    const owner = makeUser({ login: "owner-login", email: "secret-owner@a7t.ai" });
    const invitee = makeUser({ handle: "jack" });
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "jack", "view");
    const shared = listSharedWithUser(invitee);
    expect(shared[0]!.ownerName).toBe("owner-login");
    // The owner's email is NEVER part of the shared-with-me payload.
    expect(JSON.stringify(shared)).not.toContain("secret-owner@a7t.ai");
  });

  test("is scoped to the caller — never returns grants made to someone else", () => {
    const owner = makeUser();
    makeUser({ handle: "kate" });
    const outsider = makeUser();
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "kate", "view");
    expect(listSharedWithUser(outsider)).toHaveLength(0);
  });

  test("orders by the conversation's most-recent activity", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "liam" });
    const older = makeConversation(owner);
    const newer = makeConversation(owner);
    db.update(conversations).set({ updatedAt: new Date(1000) }).where(eq(conversations.id, older)).run();
    db.update(conversations).set({ updatedAt: new Date(2000) }).where(eq(conversations.id, newer)).run();
    inviteCollaborator(owner, older, "liam", "view");
    inviteCollaborator(owner, newer, "liam", "view");
    const shared = listSharedWithUser(invitee);
    expect(shared.map((s) => s.id)).toEqual([newer, older]);
  });
});

describe("updateCollaboratorRole", () => {
  test("the owner can change a collaborator's role", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "mona" });
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "mona", "view");
    expect(updateCollaboratorRole(owner, conv, invitee, "edit")).toBe(true);
    expect(getCollaboration(invitee, conv)?.role).toBe("edit");
  });

  test("a non-owner cannot change roles", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "nora" });
    const attacker = makeUser();
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "nora", "view");
    expect(updateCollaboratorRole(attacker, conv, invitee, "prompt")).toBe(false);
    expect(getCollaboration(invitee, conv)?.role).toBe("view");
  });

  test("returns false for a target who isn't a collaborator", () => {
    const owner = makeUser();
    const stranger = makeUser();
    const conv = makeConversation(owner);
    expect(updateCollaboratorRole(owner, conv, stranger, "edit")).toBe(false);
  });
});

describe("removeCollaborator", () => {
  test("the owner revokes a grant and access dies immediately", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "omar" });
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "omar", "view");
    expect(resolveConversationAccess(invitee, conv)?.role).toBe("view");
    expect(removeCollaborator(owner, conv, invitee)).toBe(true);
    expect(resolveConversationAccess(invitee, conv)).toBeNull();
    expect(getCollaboration(invitee, conv)).toBeNull();
  });

  test("a non-owner cannot revoke (the grant survives)", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "pat" });
    const attacker = makeUser();
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "pat", "view");
    expect(removeCollaborator(attacker, conv, invitee)).toBe(false);
    expect(getCollaboration(invitee, conv)).not.toBeNull();
  });

  test("is a no-op false when there's nothing to revoke", () => {
    const owner = makeUser();
    const stranger = makeUser();
    const conv = makeConversation(owner);
    expect(removeCollaborator(owner, conv, stranger)).toBe(false);
  });
});

describe("cascades", () => {
  test("deleting the conversation drops its grants", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "quinn" });
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "quinn", "view");
    db.delete(conversations).where(eq(conversations.id, conv)).run();
    expect(getCollaboration(invitee, conv)).toBeNull();
  });

  test("deleting the collaborator account drops their grants", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "rita" });
    const conv = makeConversation(owner);
    inviteCollaborator(owner, conv, "rita", "view");
    db.delete(users).where(eq(users.id, invitee)).run();
    expect(
      db.select().from(conversationCollaborators).where(eq(conversationCollaborators.conversationId, conv)).all(),
    ).toHaveLength(0);
  });

  test("deleting the inviter nulls invitedBy but keeps the grant (access survives)", () => {
    const owner = makeUser();
    const invitee = makeUser({ handle: "sam" });
    const conv = makeConversation(owner);
    // Re-own the conversation to a separate account so deleting the inviter doesn't cascade the
    // conversation (we only want to test the invitedBy set-null on the grant).
    const coOwner = makeUser();
    db.update(conversations).set({ userId: coOwner }).where(eq(conversations.id, conv)).run();
    db.insert(conversationCollaborators).values({ conversationId: conv, userId: invitee, role: "view", invitedBy: owner }).run();
    db.delete(users).where(eq(users.id, owner)).run();
    const grant = getCollaboration(invitee, conv);
    expect(grant).not.toBeNull();
    expect(grant!.invitedBy).toBeNull();
  });
});

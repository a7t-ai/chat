import { Trash2, UserPlus, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  type Collaborator,
  type CollaboratorRole,
  type DirectoryUser,
  fetchDirectory,
  inviteCollaborator,
  type InviteFailure,
  listCollaborators,
  removeCollaborator,
  updateCollaboratorRole,
} from "../lib/api";
import { displayNameOf } from "../lib/identity";
import { type MessageKey, useT } from "../lib/i18n";
import { Button, IconButton, InlineMessage, Input, Select } from "./ui";

// Owner-side control for the Share PRIMITIVE — inviting a SPECIFIC account (by its public HANDLE,
// #189) to collaborate on this conversation, the identity-bound parallel to ShareControl's public
// watch link. A small "People" button opens a popover: invite by handle at a role, then see +
// manage who has access. The handle field is backed by the instance directory (#190) as a native
// datalist autocomplete, so the owner can pick a known handle instead of typing it blind. The
// popover lazy-loads the collaborator list (and the directory) on open, so the conversation list
// isn't taxed with a lookup per row. Only shown for a real, owned conversation. The row identity is
// rendered through `displayNameOf` (handle / display name) — never an email (there is none).

const ROLES: CollaboratorRole[] = ["view", "suggest", "edit", "prompt"];
const ROLE_LABEL: Record<CollaboratorRole, MessageKey> = {
  view: "collab.role.view",
  suggest: "collab.role.suggest",
  edit: "collab.role.edit",
  prompt: "collab.role.prompt",
};
const FAILURE_KEY: Record<InviteFailure, MessageKey> = {
  no_account: "collab.errNoAccount",
  self: "collab.errSelf",
  error: "collab.error",
};

// How many directory suggestions to surface in the autocomplete at once (the directory itself is
// already server-capped; this just keeps the datalist tidy).
const MAX_SUGGESTIONS = 8;

// The name to show for one collaborator row. Routed through the shared identity helper so the label
// is the handle / display name the owner knows them by — NEVER an email (the payload carries none).
function collaboratorName(c: Collaborator): string {
  return displayNameOf(
    { id: c.userId, login: c.userId, displayName: c.displayName, handle: c.handle, email: null },
    c.handle ?? c.userId,
  );
}

export function CollaboratorsPanel({ conversationId }: { conversationId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Collaborator[]>([]);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  async function refresh() {
    try {
      setList(await listCollaborators(conversationId));
    } catch {
      setError("collab.error");
    }
  }

  async function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setError(null);
    setList([]);
    setHandle("");
    // Load the directory for the invite autocomplete. A failure here is non-fatal — the field still
    // works as a plain handle text input, so we swallow it (the collaborator list surfaces its own).
    fetchDirectory()
      .then(setDirectory)
      .catch(() => setDirectory([]));
    await refresh();
  }

  // Normalize a typed handle the way the server resolves it: trim, drop a leading "@" (people paste
  // it that way), lowercase. Case-insensitivity matches the `lower(handle)` unique index (#189).
  function normalize(raw: string): string {
    return raw.trim().replace(/^@+/, "").toLowerCase();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const target = normalize(handle);
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await inviteCollaborator(conversationId, target, role);
      if (!res.ok) {
        setError(FAILURE_KEY[res.reason]);
        return;
      }
      setHandle("");
      await refresh();
    } catch {
      setError("collab.error");
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(userId: string, next: CollaboratorRole) {
    setError(null);
    // Optimistic: reflect the new role immediately, then reconcile from the server.
    setList((cur) => cur.map((c) => (c.userId === userId ? { ...c, role: next } : c)));
    try {
      await updateCollaboratorRole(conversationId, userId, next);
      await refresh();
    } catch {
      setError("collab.error");
      await refresh();
    }
  }

  async function remove(userId: string) {
    setError(null);
    try {
      await removeCollaborator(conversationId, userId);
      await refresh();
    } catch {
      setError("collab.error");
    }
  }

  // Directory rows that match what's typed (handle OR display name), minus anyone already invited,
  // capped for a tidy datalist. A blank needle offers the (capped) directory as-is.
  const needle = normalize(handle);
  const invited = new Set(list.map((c) => c.userId));
  const suggestions = directory
    .filter((u) => !invited.has(u.id))
    .filter((u) => !needle || u.handle.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle))
    .slice(0, MAX_SUGGESTIONS);

  return (
    <div className="collab-control menu">
      <IconButton
        size="sm"
        active={list.length > 0}
        className="collab-btn"
        onClick={toggleOpen}
        aria-expanded={open}
        label={t("collab.button")}
        title={t("collab.title")}
      >
        <Users size={18} strokeWidth={1.75} aria-hidden="true" />
      </IconButton>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu-pop collab-pop" role="dialog" aria-label={t("collab.title")}>
            <div className="share-head">
              <div className="share-head-row">
                <span className="share-head-ico" aria-hidden="true">
                  <Users size={16} strokeWidth={1.75} />
                </span>
                <div className="share-title">{t("collab.title")}</div>
              </div>
              <p className="share-intro muted">{t("collab.intro")}</p>
            </div>
            <form className="collab-invite" onSubmit={submit}>
              <Input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder={t("collab.handlePlaceholder")}
                aria-label={t("collab.handlePlaceholder")}
                list="collab-directory"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {/* Native autocomplete backed by the instance directory (#190): pick a known handle,
                  or type a fresh one. Options carry the display name as their label. */}
              <datalist id="collab-directory">
                {suggestions.map((u) => (
                  <option key={u.id} value={u.handle} label={u.name === u.handle ? undefined : u.name} />
                ))}
              </datalist>
              <Select
                className="collab-role"
                value={role}
                onChange={(e) => setRole(e.target.value as CollaboratorRole)}
                aria-label={t("collab.title")}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(ROLE_LABEL[r])}
                  </option>
                ))}
              </Select>
              <Button variant="primary" size="sm" className="collab-invite-btn" type="submit" disabled={busy}>
                <UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />
                {busy ? t("collab.inviting") : t("collab.invite")}
              </Button>
            </form>
            {error && (
              <InlineMessage variant="danger" role="alert">
                {t(error)}
              </InlineMessage>
            )}
            {list.length === 0 ? (
              <p className="muted small collab-none">{t("collab.none")}</p>
            ) : (
              <ul className="collab-list">
                {list.map((c) => {
                  const name = collaboratorName(c);
                  const at = c.handle ? `@${c.handle}` : c.userId;
                  return (
                    <li key={c.userId} className="collab-row">
                      <span className="collab-who" title={at}>
                        {name}
                        {/* Surface the display name as a muted second identity when it adds info
                            beyond the primary (handle) label — never an email. */}
                        {c.displayName && c.displayName !== name && (
                          <span className="collab-handle muted small"> {c.displayName}</span>
                        )}
                      </span>
                      <Select
                        className="collab-role small"
                        value={c.role}
                        onChange={(e) => changeRole(c.userId, e.target.value as CollaboratorRole)}
                        aria-label={at}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {t(ROLE_LABEL[r])}
                          </option>
                        ))}
                      </Select>
                      <IconButton size="sm" className="collab-remove" onClick={() => remove(c.userId)} label={t("collab.remove")}>
                        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

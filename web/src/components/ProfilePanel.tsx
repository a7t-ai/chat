import { useState } from "react";
import { type HandleError, type Me, setHandle } from "../lib/api";
import { displayNameOf, HANDLE_MAX, localHandleError, normalizeHandle } from "../lib/identity";
import { type MessageKey, useT } from "../lib/i18n";
import { Button, Field, InlineMessage, Input, Modal, PanelActions } from "./ui";
import { ProfileCard } from "./ProfileCard";

// The typed handle errors → their localized message keys.
const HANDLE_ERR_KEY: Record<HandleError, MessageKey> = {
  charset: "profile.handleErrCharset",
  length: "profile.handleErrLength",
  taken: "profile.handleErrTaken",
  error: "profile.handleErrGeneric",
};

// In-app profile card (#12) + the account handle editor (#189). The caller's own self-service view:
// it shows only the CALLER's own identity (avatar + name + email) and their plan tier — read straight
// from /api/me (no extra fetch) — and lets them set/change their public handle. Opened from the
// account menu and the command palette; mirrors the overlay/panel + Esc-to-close pattern of the other
// dialogs. The OSS build has no paywall (#166), so the plan badge is informational only. `onUserChange`
// (optional) lets the parent patch `me` in place so the account menu + this card reflect a new handle
// immediately, without a full /api/me refetch.
export function ProfilePanel({
  me,
  onClose,
  embedded,
  onUserChange,
}: {
  me: Me;
  onClose: () => void;
  embedded?: boolean;
  onUserChange?: (patch: Partial<Me["user"]>) => void;
}) {
  const t = useT();

  const savedHandle = me.user.handle ?? "";
  const [draft, setDraft] = useState(savedHandle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<HandleError | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  // Name via the shared display precedence (handle → displayName → email → fallback) so the card
  // never shows a passkey account's synthetic `acct_<uuid>` login.
  const name = displayNameOf(me.user, t("identity.fallback"));
  // Show the email as a secondary line only when it's distinct from the name shown above.
  const email = me.user.email && me.user.email !== name ? me.user.email : null;

  // Plan tier from the server (defaults to "free" for shape stability with older responses).
  const plan = me.plan ?? "free";
  const PLAN_LABEL = { owner: "plan.owner", free: "plan.free", plus: "plan.plus", pro: "plan.pro", ultra: "plan.ultra" } as const;
  const PLAN_HINT = { owner: "plan.ownerHint", free: "plan.freeHint", plus: "plan.plusHint", pro: "plan.proHint", ultra: "plan.ultraHint" } as const;
  const planLabel = t(PLAN_LABEL[plan]);
  const planHint = t(PLAN_HINT[plan]);

  const normalized = normalizeHandle(draft);
  const localErr = normalized.length > 0 ? localHandleError(draft) : null;
  // Enable Save only when there's a real, valid change to persist (server owns uniqueness).
  const canSave = !saving && normalized.length > 0 && normalized !== savedHandle && localErr === null;

  async function save() {
    const err = localHandleError(draft);
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    setError(null);
    setSavedNote(false);
    const res = await setHandle(normalized);
    setSaving(false);
    if (res.ok) {
      setDraft(res.handle);
      setSavedNote(true);
      onUserChange?.({ handle: res.handle }); // keep the account menu + card in sync in-session
    } else {
      setError(res.error);
    }
  }

  return (
    <Modal bare={embedded} title={t("profile.title")} onClose={onClose} closeLabel={t("common.close")} className="profile-panel">
      <ProfileCard name={name} email={email} plan={plan} planLabel={planLabel} />
      <p className="muted small">{planHint}</p>

      {/* The field label ("Handle") titles this section — no redundant SectionHeading above it. */}
      <Field label={t("profile.handle")} htmlFor="profile-handle" hint={t("profile.handleHint")} error={localErr ? t(HANDLE_ERR_KEY[localErr]) : undefined}>
        <Input
          id="profile-handle"
          value={draft}
          maxLength={HANDLE_MAX}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t("profile.handlePlaceholder")}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
            setSavedNote(false);
          }}
        />
      </Field>
      {/* CTA on the right (the DS PanelActions standard), with the outcome message on its own line
          below — a tidy status row instead of green text crammed beside the button. */}
      <PanelActions>
        <Button variant="primary" size="sm" disabled={!canSave} onClick={save}>
          {t("profile.handleSave")}
        </Button>
      </PanelActions>
      {/* A server-side error (notably `taken`, which the local check can't know) — or the saved note. */}
      {error && !localErr && (
        <InlineMessage variant="danger" role="alert" className="ui-anim-slide-down">
          {t(HANDLE_ERR_KEY[error])}
        </InlineMessage>
      )}
      {savedNote && !error && (
        <InlineMessage variant="success" role="status" className="ui-anim-slide-down">
          {t("profile.handleSaved")}
        </InlineMessage>
      )}
    </Modal>
  );
}

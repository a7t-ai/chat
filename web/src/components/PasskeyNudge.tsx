import { Fingerprint, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Me } from "../lib/api";
import { useT } from "../lib/i18n";
import { listPasskeys, passkeySupported, registerPasskey } from "../lib/webauthn";
import { Button, InlineMessage } from "./ui";

// Where a dismissal is remembered so the nudge never nags again (mirrors the suggestion engine's
// per-capability dismissal). A single flag — the nudge is one-shot, not per-anything.
const DISMISS_KEY = "a7t_passkey_nudge_dismissed";

// Any localStorage failure (private mode, quota, corrupt value) degrades to "not dismissed" — the
// worst case is the nudge showing again, which is harmless.
function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function persistDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // ignore — the in-memory state still hides it for this session
  }
}

// Post-login passkey nudge (#149): once an account signs in with NO registered passkey, a subtle,
// dismissible prompt invites them to set one up for faster future sign-ins (#20/#145). It only ever
// appears where it can be acted on — an account caller, passkeys configured server-side
// (`me.passkeys.available`), and a browser that supports WebAuthn (`passkeySupported()`). The CTA
// reuses the exact `registerPasskey()` ceremony from the manager. Adding a passkey OR dismissing
// hides it, and the dismissal is remembered so it never returns. Not Clippy: one subtle banner.
export function PasskeyNudge({ me }: { me: Me }) {
  const t = useT();
  // The cheap, content-free gate — no network probe unless every precondition already holds, so it
  // stays silent on non-account callers, dark servers, and unsupported browsers.
  const eligible = me.role === "account" && me.passkeys?.available === true && passkeySupported();
  const [dismissed, setDismissed] = useState(() => isDismissed());
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eligible || dismissed) return;
    let alive = true;
    // Reveal only for an account that genuinely has ZERO passkeys. `listPasskeys()` is the authed
    // source of truth for both availability and the count (`/api/me` carries availability but not
    // the count). Any failure stays quiet — we never nag on an error.
    listPasskeys()
      .then(({ available, passkeys }) => {
        if (alive && available && passkeys.length === 0) setShow(true);
      })
      .catch(() => {
        /* stay hidden */
      });
    return () => {
      alive = false;
    };
  }, [eligible, dismissed]);

  if (!eligible || dismissed || !show) return null;

  function dismiss() {
    persistDismissed();
    setDismissed(true);
  }

  async function onSetUp() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const r = await registerPasskey();
      if (r.ok) {
        // Success — they now have a passkey, so the nudge has served its purpose. Persist the
        // dismissal too so a stale `/api/me` (which lacks the count) can't resurface it on reload.
        persistDismissed();
        setShow(false);
      } else if (r.reason === "cancelled") {
        // The user backed out of the OS prompt — stay quiet, leave the nudge in place.
      } else if (r.reason === "unsupported") {
        setError(t("passkeys.unsupported"));
      } else {
        setError(t("passkeys.addError"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="passkey-nudge" role="note" aria-label={t("passkeyNudge.title")}>
      <span className="passkey-nudge-ico" aria-hidden="true">
        <Fingerprint size={18} strokeWidth={1.75} />
      </span>
      <div className="passkey-nudge-text">
        <span className="passkey-nudge-title">{t("passkeyNudge.title")}</span>
        <span className="passkey-nudge-body muted">{t("passkeyNudge.body")}</span>
        {error && (
          <InlineMessage variant="danger" role="alert" className="ui-anim-slide-down">
            {error}
          </InlineMessage>
        )}
      </div>
      <div className="passkey-nudge-actions">
        <Button size="sm" disabled={busy} onClick={onSetUp}>
          {busy ? t("passkeys.adding") : t("passkeyNudge.cta")}
        </Button>
      </div>
      <button
        type="button"
        className="passkey-nudge-dismiss"
        onClick={dismiss}
        aria-label={t("passkeyNudge.dismiss")}
        title={t("passkeyNudge.dismiss")}
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

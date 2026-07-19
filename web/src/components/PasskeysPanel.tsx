import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { deletePasskey, listPasskeys, type Passkey, passkeySupported, registerPasskey } from "../lib/webauthn";
import { Button, InlineMessage, Input, Modal } from "./ui";

// Passkey (WebAuthn) sign-in manager (#20): the signed-in account's "add / remove passkeys" panel.
// A passkey is a phishing-resistant, passwordless credential (Touch ID / Windows Hello / a security
// key) — an alternative to the email one-time code. This lists the account's registered passkeys and
// lets it enrol a new one or remove an existing one. Every call is scoped to the caller server-side.
export function PasskeysPanel({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A friendly device name the user types before enrolling (e.g. "MacBook Touch ID"). Optional —
  // an empty name enrols an unnamed passkey (the server stores null → the generic fallback label).
  const [name, setName] = useState("");

  async function refresh() {
    try {
      const { available: a, passkeys: list } = await listPasskeys();
      setAvailable(a);
      setPasskeys(list);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function onAdd() {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // Trim and drop an empty name so the server stores null (rendered as the generic fallback).
      const r = await registerPasskey(name.trim() || undefined);
      if (r.ok) {
        setName("");
        setNotice(t("passkeys.added"));
        await refresh();
      } else if (r.reason === "cancelled") {
        // The user dismissed the OS prompt — stay quiet, no error.
      } else if (r.reason === "unsupported") {
        setError(t("passkeys.unsupported"));
      } else {
        setError(t("passkeys.addError"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (busy) return;
    if (!window.confirm(t("passkeys.deleteConfirm"))) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await deletePasskey(id);
      await refresh();
    } catch {
      setError(t("passkeys.deleteError"));
    } finally {
      setBusy(false);
    }
  }

  const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

  return (
    <Modal bare={embedded} title={t("passkeys.title")} onClose={onClose} closeLabel={t("common.close")}>
      <p className="muted small">{t("passkeys.subtitle")}</p>

      {loadError ? (
        <InlineMessage variant="danger" role="alert">
          {t("passkeys.loadError")}
        </InlineMessage>
      ) : available === false ? (
        <InlineMessage variant="info">{t("passkeys.unavailable")}</InlineMessage>
      ) : (
        <>
          {passkeys.length === 0 ? (
            <p className="muted small">{t("passkeys.empty")}</p>
          ) : (
            <ul className="passkey-list">
              {passkeys.map((pk) => (
                <li key={pk.id} className="passkey-row row">
                  <div>
                    <div className="passkey-label">{pk.label || t("passkeys.unnamed")}</div>
                    <div className="muted small">
                      {t("passkeys.added2", { date: fmtDate(pk.createdAt) })}
                      {pk.lastUsedAt ? ` · ${t("passkeys.lastUsed", { date: fmtDate(pk.lastUsedAt) })}` : ""}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDelete(pk.id)}>
                    {t("common.delete")}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="passkey-add">
            <Input
              className="passkey-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("passkeys.namePlaceholder")}
              aria-label={t("passkeys.nameLabel")}
              maxLength={64}
              disabled={busy || !passkeySupported()}
            />
            <Button disabled={busy || !passkeySupported()} onClick={onAdd}>
              {busy ? t("passkeys.adding") : t("passkeys.add")}
            </Button>
          </div>
          {!passkeySupported() && <p className="muted small">{t("passkeys.unsupported")}</p>}
        </>
      )}

      {notice && (
        <InlineMessage variant="success" role="status" className="ui-anim-slide-down">
          {notice}
        </InlineMessage>
      )}
      {error && (
        <InlineMessage variant="danger" role="alert" className="ui-anim-slide-down">
          {error}
        </InlineMessage>
      )}
    </Modal>
  );
}

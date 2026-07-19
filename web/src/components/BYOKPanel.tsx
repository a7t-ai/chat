import { useEffect, useState } from "react";
import { type ByokKey, type ByokProvider, deleteByokKey, listByok, type Me, setByokKey } from "../lib/api";
import { useT } from "../lib/i18n";
import { Button, InlineMessage, Input, Modal, PanelActions, Select } from "./ui";

// Bring-your-own-key (#14): the "Keys" settings panel. The account brings its own frontier-provider
// API keys so its chats run on its own accounts instead of the shared local models. Keys are stored
// ENCRYPTED server-side and only ever come back masked (provider + last4) — this panel never sees or
// renders a plaintext key. The dark-gate (`me.byok.available`) mirrors passkeys/search: with no
// server encryption key the feature is off and we show a graceful "not configured" note instead of
// the form. Everything else (the catalog to offer + the caller's masked keys) comes from
// GET /api/byok; every call is scoped to the caller server-side and re-checks the entitlement.
export function BYOKPanel({ me, onClose, embedded }: { me: Me; onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const available = me.byok?.available ?? false;
  const [providers, setProviders] = useState<ByokProvider[]>([]);
  const [keys, setKeys] = useState<ByokKey[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The add form: the selected provider (empty ⇒ the first in the catalog) and the raw key input.
  const [provider, setProvider] = useState("");
  const [keyInput, setKeyInput] = useState("");

  async function refresh() {
    try {
      const { providers: p, keys: k } = await listByok();
      setProviders(p);
      setKeys(k);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    // Only reach for the catalog + keys when the feature is live — a dark server never gets a fetch.
    if (available) void refresh();
  }, [available]);

  const selected = provider || providers[0]?.id || "";
  const hint = providers.find((p) => p.id === selected)?.keyHint ?? "";
  const labelOf = (id: string) => providers.find((p) => p.id === id)?.label ?? id;

  async function onAdd() {
    if (busy) return;
    const key = keyInput.trim();
    if (!selected || key.length === 0) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await setByokKey(selected, key);
      setKeyInput(""); // clear the secret from the field the moment it's stored
      setNotice(t("byok.added"));
      await refresh();
    } catch {
      setError(t("byok.addError"));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(p: string) {
    if (busy) return;
    if (!window.confirm(t("byok.deleteConfirm"))) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await deleteByokKey(p);
      await refresh();
    } catch {
      setError(t("byok.deleteError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal bare={embedded} title={t("byok.title")} onClose={onClose} closeLabel={t("common.close")}>
      <p className="muted small">{t("byok.subtitle")}</p>

      {!available ? (
        <InlineMessage variant="info">{t("byok.unavailable")}</InlineMessage>
      ) : (
        <>
          {loadError && (
            <InlineMessage variant="danger" role="alert">
              {t("byok.loadError")}
            </InlineMessage>
          )}

          {keys.length === 0 ? (
            <p className="muted small">{t("byok.empty")}</p>
          ) : (
            <table className="keys-table">
              <thead>
                <tr>
                  <th>{t("byok.colProvider")}</th>
                  <th>{t("byok.colKey")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.provider}>
                    <td>{labelOf(k.provider)}</td>
                    <td className="byok-key-mask">{`•••• ${k.last4}`}</td>
                    <td className="files-actions">
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDelete(k.provider)}>
                        {t("common.delete")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="byok-add">
            <Select value={selected} aria-label={t("byok.providerLabel")} disabled={busy} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            <Input
              className="byok-key-input"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={hint || t("byok.keyPlaceholder")}
              aria-label={t("byok.keyLabel")}
              autoComplete="off"
              maxLength={500}
              disabled={busy}
            />
          </div>
          <PanelActions>
            <Button variant="primary" disabled={busy || keyInput.trim().length === 0} onClick={onAdd}>
              {busy ? t("byok.adding") : t("byok.add")}
            </Button>
          </PanelActions>
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

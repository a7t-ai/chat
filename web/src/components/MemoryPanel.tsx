import { useEffect, useState } from "react";
import { forgetAllMemory, forgetFact, listMemory, type RememberedFact } from "../lib/api";
import { useT } from "../lib/i18n";
import { setPreferences, usePreferences } from "../lib/preferences";
import { Button, InlineMessage, Modal, PanelActions, Toggle } from "./ui";

// Archivist memory (#27): the transparency + control surface. SEE everything a7t.chat has durably
// learned about you (the derived "facts" tier), FORGET any one of them, forget everything, or switch
// memory off entirely. The on/off switch rides preferences (memory.enabled) so it syncs across your
// instances; the see/forget list talks to /api/memory. Every call is scoped to the caller server-side.
export function MemoryPanel({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const prefs = usePreferences();
  const enabled = prefs.memory.enabled;
  const [facts, setFacts] = useState<RememberedFact[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setFacts((await listMemory()).facts);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  const rows = facts ?? [];

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError(t("memory.error"));
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  function forgetOne(f: RememberedFact) {
    if (busy) return;
    if (!window.confirm(t("memory.forgetOneConfirm"))) return;
    void run(() => forgetFact(f.id));
  }
  function forgetEverything() {
    if (busy || rows.length === 0) return;
    if (!window.confirm(t("memory.forgetAllConfirm", { count: rows.length }))) return;
    void run(async () => {
      await forgetAllMemory();
    });
  }

  return (
    <Modal bare={embedded} title={t("memory.title")} onClose={onClose} closeLabel={t("common.close")}>
      <p className="muted small">{t("memory.subtitle")}</p>

      <Toggle
        label={t("memory.enabledLabel")}
        hint={t("memory.enabledHint")}
        checked={enabled}
        onChange={(v) => setPreferences({ memory: { enabled: v } })}
      />
      {!enabled && <p className="muted small">{t("memory.disabledNote")}</p>}

      <div className="row files-toolbar">
        <span className="muted small">{t("memory.count", { count: rows.length })}</span>
        <PanelActions>
          <Button variant="danger" size="sm" onClick={forgetEverything} disabled={busy || rows.length === 0}>
            {t("memory.forgetAll")}
          </Button>
        </PanelActions>
      </div>

      {error && <InlineMessage variant="danger" role="alert">{error}</InlineMessage>}
      {loadError && <InlineMessage variant="danger" role="alert">{t("memory.loadError")}</InlineMessage>}

      {rows.length === 0 ? (
        <p className="muted small">{t("memory.empty")}</p>
      ) : (
        <table className="keys-table memory-table">
          <thead>
            <tr>
              <th>{t("memory.colFact")}</th>
              <th>{t("memory.colLearned")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id}>
                <td>{f.content}</td>
                <td className="muted small">{new Date(f.createdAt).toLocaleDateString()}</td>
                <td className="files-actions">
                  <Button variant="ghost" size="sm" onClick={() => forgetOne(f)} disabled={busy}>
                    {t("memory.forget")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

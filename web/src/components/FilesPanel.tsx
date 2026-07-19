import { useEffect, useState } from "react";
import { deleteFile, fileDownloadUrl, type FilesListing, listFiles } from "../lib/api";
import { useT } from "../lib/i18n";
import { Button, InlineMessage, Modal, PanelActions } from "./ui";

// Attachments / file manager (#15): the per-account "your files" panel — LIST + MANAGE. Uploading
// happens in the prompt field (attach on a message), not here; this page lists what you've uploaded
// and lets you select files to delete (or delete all). Deleting a file never touches the
// conversations that already reference it. Every call is scoped to the caller server-side.

// Human-readable byte size (1 KB = 1024 B). Kept small + dependency-free.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

export function FilesPanel({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const [listing, setListing] = useState<FilesListing | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setListing(await listFiles());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  const files = listing?.files ?? [];
  const allSelected = files.length > 0 && selected.size === files.length;

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((s) => (s.size === files.length ? new Set() : new Set(files.map((f) => f.id))));
  }

  // Delete a set of files (no bulk endpoint yet — a scoped per-id loop). The caller confirms first;
  // clears the selection + refreshes after. On any failure, surface the generic error and re-sync.
  async function deleteIds(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      for (const id of ids) await deleteFile(id);
      setSelected(new Set());
    } catch {
      setError(t("files.deleteError"));
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  function deleteSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(t("files.deleteSelectedConfirm", { count: selected.size }))) return;
    void deleteIds([...selected]);
  }
  function deleteAll() {
    if (files.length === 0) return;
    if (!window.confirm(t("files.deleteAllConfirm", { count: files.length }))) return;
    void deleteIds(files.map((f) => f.id));
  }

  return (
    <Modal bare={embedded} title={t("files.title")} onClose={onClose} closeLabel={t("common.close")}>
      <div className="row files-toolbar">
        <span className="muted small">
          {listing
            ? t("files.usage", {
                count: listing.usage.count,
                max: listing.limits.maxCount,
                used: formatBytes(listing.usage.totalBytes),
              })
            : t("files.subtitle")}
        </span>
        <PanelActions>
          <Button variant="ghost" size="sm" onClick={deleteSelected} disabled={busy || selected.size === 0}>
            {selected.size > 0 ? t("files.deleteSelectedN", { count: selected.size }) : t("files.deleteSelected")}
          </Button>
          <Button variant="danger" size="sm" onClick={deleteAll} disabled={busy || files.length === 0}>
            {t("files.deleteAll")}
          </Button>
        </PanelActions>
      </div>
      <p className="muted small files-note">{t("files.note")}</p>

      {error && <InlineMessage variant="danger" role="alert">{error}</InlineMessage>}
      {loadError && <InlineMessage variant="danger" role="alert">{t("files.loadError")}</InlineMessage>}

      {files.length === 0 ? (
        <p className="muted small">{t("files.empty")}</p>
      ) : (
        <table className="keys-table files-table">
          <thead>
            <tr>
              <th className="files-check-col">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label={t("files.selectAll")} />
              </th>
              <th>{t("files.colName")}</th>
              <th>{t("files.colSize")}</th>
              <th>{t("files.colAdded")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td className="files-check-col">
                  <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} aria-label={f.filename} />
                </td>
                <td>{f.filename}</td>
                <td className="muted small">{formatBytes(f.size)}</td>
                <td className="muted small">{new Date(f.createdAt).toLocaleDateString()}</td>
                <td className="files-actions">
                  <a className="btn ghost small" href={fileDownloadUrl(f.id)} download={f.filename}>
                    {t("files.download")}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

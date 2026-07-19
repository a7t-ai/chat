import { useCallback, useEffect, useRef, useState } from "react";
import { type UploadResult, uploadFile } from "./api";

// In-prompt attachments (#129 / prompt-field file selector). One pending file the user
// picked (via the composer's attach button or a drag-and-drop) — it uploads through the
// SAME pipeline as the file manager (`uploadFile` -> POST /api/files, scoped + quota-checked
// server-side), then rides along in the composer's little gallery where it can be removed.
// The upload happens optimistically the moment it's added, so each chip carries its own
// status: uploading -> ready (a server file id) or error (a localizable reason).

export type AttachmentStatus = "uploading" | "ready" | "error";

// Per-message cap (#136). The backend keeps the real quota (25 MB/file, 200 MB + 200 files per
// account); this is a lightweight UX ceiling so a single message can't balloon into dozens of
// chips. Adds past the cap are refused with a visible notice, never silently dropped.
export const MAX_ATTACHMENTS = 10;

// Whether the active model can actually READ attachments — "Omni" in the catalog sense (#63/#136):
// its `input` modalities include a NON-text kind (image/audio/video/document). `undefined` means the
// model catalog hasn't loaded yet, so we stay OPTIMISTIC (enabled) and let the loaded state correct
// it — the send-time gate is the hard backstop that stops text-blind attachments reaching a text model.
export function modelAcceptsAttachments(input: readonly string[] | undefined): boolean {
  if (!input) return true; // catalog not loaded yet — don't punish the user mid-load
  return input.some((m) => m !== "text");
}

export interface Attachment {
  // Client-only id — the stable key for rendering + removal. Not the server file id (that
  // only exists once the upload lands, and only for the ones that succeed).
  localId: string;
  name: string;
  size: number;
  isImage: boolean;
  // Object URL for an image preview thumbnail; revoked on remove/clear so it can't leak.
  previewUrl?: string;
  status: AttachmentStatus;
  // Set only on `status === "error"` — maps to the shared files.error* copy.
  errorReason?: "too_large" | "quota" | "error";
  // The stored file's id once the upload succeeded (`status === "ready"`).
  fileId?: string;
}

// A drag carries real files (not just selected text / a link) when its dataTransfer
// advertises the "Files" type. Reading `.files` mid-drag is unreliable (empty until drop
// in most browsers for privacy), so the overlay gates on the type list — the standard
// drop-zone technique. Ignoring non-file drags is an explicit acceptance criterion.
export function dragHasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = dt.types;
  if (!types) return false;
  // `types` is a DOMStringList (array-like, no .includes in older DOM) — scan by index.
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}

// Pull the real File objects out of a drop. Prefer `.files` (populated on drop); fall back
// to the `.items` list, taking only the file-kind entries so a mixed text+file drag never
// yields a phantom entry.
export function filesFromDataTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  if (dt.files && dt.files.length > 0) return Array.from(dt.files);
  const out: File[] = [];
  const items = dt.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

// The composer's attachment state: the live list plus add/remove/clear. Each `addFiles`
// entry uploads immediately and patches its own chip as the request resolves.
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  // True when the last add hit the per-message cap (some/all files refused). Drives the
  // composer's inline "Up to N files per message" notice; cleared once there's room again.
  const [limitHit, setLimitHit] = useState(false);
  const idRef = useRef(0);
  // Live mirror of the list length so `addFiles` can decide the cap WITHOUT reading `items`
  // inside a state updater (side effects there double-fire under StrictMode). Bumped
  // optimistically on add and re-synced from the committed list below.
  const countRef = useRef(0);
  // Object URLs we minted, so remove/clear can revoke exactly ours (idempotent via the Set,
  // which keeps React StrictMode's double-invoked updaters from double-revoking).
  const urlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    countRef.current = items.length;
  }, [items]);

  const patch = useCallback((localId: string, next: Partial<Attachment>) => {
    setItems((prev) => prev.map((a) => (a.localId === localId ? { ...a, ...next } : a)));
  }, []);

  const revoke = useCallback((url: string | undefined) => {
    if (url && urlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      urlsRef.current.delete(url);
    }
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (!files || files.length === 0) return;
      // Enforce the per-message cap (#136): take only what fits, refuse the rest with a notice.
      const room = MAX_ATTACHMENTS - countRef.current;
      if (room <= 0) {
        setLimitHit(true);
        return;
      }
      const accepted = files.slice(0, room);
      setLimitHit(accepted.length < files.length);
      // Account for the additions up front so a second add in the same tick still caps correctly.
      countRef.current += accepted.length;
      for (const file of accepted) {
        idRef.current += 1;
        const localId = `att_${idRef.current}`;
        const isImage = file.type.startsWith("image/");
        let previewUrl: string | undefined;
        if (isImage) {
          try {
            previewUrl = URL.createObjectURL(file);
            urlsRef.current.add(previewUrl);
          } catch {
            // Object URLs unsupported (or blocked) — fall back to a plain chip, no thumbnail.
          }
        }
        setItems((prev) => [
          ...prev,
          { localId, name: file.name, size: file.size, isImage, previewUrl, status: "uploading" },
        ]);
        uploadFile(file)
          .then((res: UploadResult) => {
            if (res.ok) patch(localId, { status: "ready", fileId: res.file.id });
            else patch(localId, { status: "error", errorReason: res.reason });
          })
          .catch(() => patch(localId, { status: "error", errorReason: "error" }));
      }
    },
    [patch],
  );

  const remove = useCallback(
    (localId: string) => {
      // Removing a file frees a slot, so the cap notice no longer applies.
      setLimitHit(false);
      setItems((prev) => {
        const target = prev.find((a) => a.localId === localId);
        revoke(target?.previewUrl);
        return prev.filter((a) => a.localId !== localId);
      });
    },
    [revoke],
  );

  const clear = useCallback(() => {
    setLimitHit(false);
    setItems((prev) => {
      for (const a of prev) revoke(a.previewUrl);
      return [];
    });
  }, [revoke]);

  // Revoke any surviving preview URLs when the composer unmounts (e.g. switching to a
  // read-only shared chat) without an explicit clear — so a mid-drop navigation can't leak.
  const urls = urlsRef;
  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current.clear();
    },
    [urls],
  );

  return { items, addFiles, remove, clear, limitHit };
}

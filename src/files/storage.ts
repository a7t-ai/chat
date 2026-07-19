import { mkdir, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { config } from "../config.ts";

// Attachments storage (#15) — the "local now, cloud later" seam. A FileStorage backend persists an
// opaque byte blob under a SERVER-generated key; the DB row (src/db/schema.ts `files`) holds the
// key + metadata. Swapping to S3/R2/GCS later is a NEW implementation of this interface and nothing
// else changes — the service + routes only ever touch the interface. Reads return the full bytes
// (this is a single-box, small-file store: uploads are bounded by config.files.maxFileBytes), so a
// cloud backend that can't hand back a local path still fits.
export interface FileStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

// The storage key for a user's file: `<userId>/<id>`. Both are UUIDs (crypto.randomUUID → only
// hex + hyphen), so the key can NEVER contain a path separator or `..` — there is no traversal
// surface. Kept a pure function so the invariant is unit-testable.
export function storageKeyFor(userId: string, id: string): string {
  return `${userId}/${id}`;
}

// Resolve a backend-relative key to an absolute path UNDER `root`, refusing anything that escapes
// it. Defense in depth: keys are server-generated UUID pairs, but this guard means even a future
// caller passing a crafted key (`../`, an absolute path) can never read/write outside the store.
export function resolveWithin(root: string, key: string): string {
  const base = resolve(root);
  const full = resolve(base, key);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error("invalid storage key");
  }
  return full;
}

// Local-disk backend (the default). Root is read lazily from config each call so a test (or a
// reconfigured deploy) can point it at a different directory without reconstructing the instance.
export class LocalFileStorage implements FileStorage {
  constructor(private readonly rootFn: () => string = () => config.files.dir) {}

  private full(key: string): string {
    return resolveWithin(this.rootFn(), key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const full = this.full(key);
    await mkdir(dirname(full), { recursive: true });
    await Bun.write(full, bytes);
  }

  async read(key: string): Promise<Uint8Array | null> {
    const f = Bun.file(this.full(key));
    if (!(await f.exists())) return null;
    return new Uint8Array(await f.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.full(key));
    } catch {
      // Already gone — the metadata row is the source of truth, so a missing blob is a no-op.
    }
  }
}

// The default storage the service uses; a test can pass its own FileStorage to exercise the
// service without disk I/O.
export const defaultStorage: FileStorage = new LocalFileStorage();

const MAX_FILENAME_LEN = 200;
const MAX_CONTENT_TYPE_LEN = 128;

// Sanitize an untrusted upload filename to a safe DISPLAY name (this is metadata only — the on-disk
// key is server-generated, never the filename). Drops any directory components a client might send,
// strips control chars (\p{Cc}, unsafe in a header) + double quotes (the Content-Disposition
// delimiter), collapses whitespace, and bounds the length. `toWellFormed()` runs AFTER the slice so
// a truncation that splits a surrogate pair can't leave a lone surrogate (which would later throw in
// `encodeURIComponent` when serving the download). An empty / dots-only result → "file".
export function sanitizeFilename(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const base = s.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/\p{Cc}/gu, "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FILENAME_LEN)
    .toWellFormed()
    .trim();
  if (!cleaned || /^\.+$/.test(cleaned)) return "file";
  return cleaned;
}

// Bound + normalize the client-provided MIME type (untrusted). Keeps only a conservative
// type/subtype token shape (dropping any `; charset=…` parameters); anything malformed/empty/oversized
// degrades to a generic binary type. Downloads are ALWAYS served as an attachment with nosniff
// regardless, so this is a display hint, not a security control.
export function sanitizeContentType(raw: unknown): string {
  const base = (typeof raw === "string" ? raw : "").trim().toLowerCase().split(";")[0]!.trim();
  if (
    base.length > 0 &&
    base.length <= MAX_CONTENT_TYPE_LEN &&
    /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(base)
  ) {
    return base;
  }
  return "application/octet-stream";
}

// A safe Content-Disposition value forcing a DOWNLOAD. Always `attachment` — user-uploaded bytes
// are never rendered inline (an HTML/SVG upload rendered inline would be stored-XSS on the app
// origin). Emits an ASCII-fallback `filename` (non-ASCII + delimiters replaced) AND an RFC 5987
// `filename*` so a Unicode name survives without letting raw bytes into the header. `toWellFormed()`
// guards the `encodeURIComponent` call: a lone surrogate (e.g. from a mid-pair truncation) would
// otherwise throw a `URIError` and 500 the download.
export function contentDisposition(filename: string): string {
  const safe = filename.toWellFormed();
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

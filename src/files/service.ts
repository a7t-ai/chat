import { and, desc, eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { type FileRecord, files } from "../db/schema.ts";
import {
  defaultStorage,
  type FileStorage,
  sanitizeContentType,
  sanitizeFilename,
  storageKeyFor,
} from "./storage.ts";

// The attachments / file-manager service (#15): per-account upload / list / download / delete over
// the pluggable storage backend. EVERYTHING is scoped by `userId` — there is no path that reads or
// mutates another account's file. Limits (per-file size, per-account footprint + count) are the
// abuse guard and are enforced HERE, before a byte is written.

export class FileError extends Error {
  // Only the statuses the routes emit — a literal union so Hono's `c.json(body, status)` takes it.
  constructor(
    message: string,
    public readonly status: 400 | 404 | 413,
  ) {
    super(message);
    this.name = "FileError";
  }
}

// The client-facing view of a stored file — metadata only, never the bytes or the storage key.
export interface FileMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number; // epoch ms
}

// The per-account footprint + the configured ceilings, for the UI meter (and the upload guard).
export interface FileUsage {
  count: number;
  totalBytes: number;
}

export interface FileLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxCount: number;
}

function toMeta(row: FileRecord): FileMeta {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    createdAt: row.createdAt.getTime(),
  };
}

export function fileLimits(): FileLimits {
  return {
    maxFileBytes: config.files.maxFileBytes,
    maxTotalBytes: config.files.maxTotalBytes,
    maxCount: config.files.maxCount,
  };
}

// The caller's files, newest first — metadata only.
export function listFiles(userId: string): FileMeta[] {
  return db
    .select()
    .from(files)
    .where(eq(files.userId, userId))
    .orderBy(desc(files.createdAt))
    .all()
    .map(toMeta);
}

// The caller's current footprint (count + summed bytes). Used both for the UI meter and to enforce
// the per-account quota on upload.
export function fileUsage(userId: string): FileUsage {
  const rows = db.select({ size: files.size }).from(files).where(eq(files.userId, userId)).all();
  return { count: rows.length, totalBytes: rows.reduce((sum, r) => sum + r.size, 0) };
}

export interface UploadInput {
  filename: unknown; // untrusted client name; sanitized here
  contentType: unknown; // untrusted MIME hint; sanitized here
  bytes: Uint8Array;
}

// Store one uploaded file for the caller. Validates size + the per-account quota BEFORE writing,
// generates the id + storage key server-side (never from the filename), writes the bytes, then
// records the metadata row. If the row insert fails the just-written blob is removed so a failed
// upload can't orphan bytes on disk. Throws FileError (400 empty / 413 too-large / 413 quota).
export async function createFile(
  userId: string,
  input: UploadInput,
  storage: FileStorage = defaultStorage,
): Promise<FileMeta> {
  const size = input.bytes.byteLength;
  if (size <= 0) throw new FileError("the file is empty", 400);
  if (size > config.files.maxFileBytes) throw new FileError("file too large", 413);

  // Per-account quota — count + total bytes. Both are checked against the incoming file so the
  // limits are never exceeded even by one byte / one file.
  const usage = fileUsage(userId);
  if (usage.count + 1 > config.files.maxCount) throw new FileError("file quota exceeded", 413);
  if (usage.totalBytes + size > config.files.maxTotalBytes) throw new FileError("storage quota exceeded", 413);

  const id = crypto.randomUUID();
  const storageKey = storageKeyFor(userId, id);
  const filename = sanitizeFilename(input.filename);
  const contentType = sanitizeContentType(input.contentType);

  await storage.put(storageKey, input.bytes);
  try {
    const row = db
      .insert(files)
      .values({ id, userId, filename, contentType, size, storageKey })
      .returning()
      .get();
    if (!row) throw new Error("failed to record file");
    return toMeta(row);
  } catch (e) {
    // Roll back the orphaned blob so a failed metadata write leaves nothing behind.
    await storage.remove(storageKey);
    throw e;
  }
}

// The bytes + display metadata for a download, scoped to the caller. Returns null when the file
// isn't the caller's / doesn't exist (a clean 404, no existence oracle) OR its blob is missing on
// the backend (a corrupt/half-deleted row → treat as gone rather than 500).
export async function getFileForDownload(
  userId: string,
  id: string,
  storage: FileStorage = defaultStorage,
): Promise<{ filename: string; contentType: string; size: number; bytes: Uint8Array } | null> {
  const row = db
    .select()
    .from(files)
    .where(and(eq(files.userId, userId), eq(files.id, id)))
    .get();
  if (!row) return null;
  const bytes = await storage.read(row.storageKey);
  if (!bytes) return null;
  return { filename: row.filename, contentType: row.contentType, size: row.size, bytes };
}

// Delete the caller's file (row + its bytes). Returns false when the file isn't the caller's /
// doesn't exist, so the route can 404 without leaking whether the id exists for another account.
export async function deleteFile(
  userId: string,
  id: string,
  storage: FileStorage = defaultStorage,
): Promise<boolean> {
  const removed = db
    .delete(files)
    .where(and(eq(files.userId, userId), eq(files.id, id)))
    .returning({ storageKey: files.storageKey })
    .all();
  if (removed.length === 0) return false;
  // Row is gone (the source of truth); best-effort unlink the bytes.
  await storage.remove(removed[0]!.storageKey);
  return true;
}

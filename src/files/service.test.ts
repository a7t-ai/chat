import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { files, users } from "../db/schema.ts";
import type { FileStorage } from "./storage.ts";
import {
  createFile,
  deleteFile,
  FileError,
  fileLimits,
  fileUsage,
  getFileForDownload,
  listFiles,
} from "./service.ts";

// An in-memory FileStorage so the service is exercised without touching disk — deterministic + fast.
class MemStorage implements FileStorage {
  store = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.store.set(key, bytes);
  }
  async read(key: string) {
    return this.store.get(key) ?? null;
  }
  async remove(key: string) {
    this.store.delete(key);
  }
}

let storage: MemStorage;

function makeUser(): string {
  return db.insert(users).values({ login: `files-${Math.random()}`, role: "account" }).returning().get()!.id;
}

const limits = { ...fileLimits() };

beforeEach(() => {
  storage = new MemStorage();
});
afterEach(() => {
  db.delete(files).run();
  db.delete(users).run();
  // Restore any limit we tweaked for a quota test.
  (config.files as unknown as typeof limits).maxFileBytes = limits.maxFileBytes;
  (config.files as unknown as typeof limits).maxTotalBytes = limits.maxTotalBytes;
  (config.files as unknown as typeof limits).maxCount = limits.maxCount;
});

describe("files/service — createFile + listFiles", () => {
  test("stores bytes + metadata and lists it back (newest first)", async () => {
    const u = makeUser();
    const a = await createFile(u, { filename: "a.txt", contentType: "text/plain", bytes: new Uint8Array([1, 2]) }, storage);
    const b = await createFile(u, { filename: "b.png", contentType: "image/png", bytes: new Uint8Array([3]) }, storage);
    expect(a).toMatchObject({ filename: "a.txt", contentType: "text/plain", size: 2 });
    expect(b).toMatchObject({ filename: "b.png", contentType: "image/png", size: 1 });
    // The bytes are actually on the backend under the server-generated key.
    expect(storage.store.size).toBe(2);
    const list = listFiles(u);
    // Both are listed; ordering is createdAt-desc (the two above may share a millisecond, so
    // assert membership rather than a sub-millisecond tiebreak).
    expect([...list.map((f) => f.filename)].sort()).toEqual(["a.txt", "b.png"]);
    // The storage key is never surfaced to the client.
    expect(JSON.stringify(list)).not.toContain("storageKey");
  });

  test("sanitizes an untrusted filename + content type", async () => {
    const u = makeUser();
    const f = await createFile(
      u,
      { filename: "../../etc/passwd", contentType: "text/html; charset=utf-8", bytes: new Uint8Array([1]) },
      storage,
    );
    expect(f.filename).toBe("passwd");
    expect(f.contentType).toBe("text/html");
  });

  test("rejects an empty file (400)", async () => {
    const u = makeUser();
    await expect(
      createFile(u, { filename: "x", contentType: "text/plain", bytes: new Uint8Array([]) }, storage),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("rejects a file over the per-file byte cap (413)", async () => {
    const u = makeUser();
    (config.files as unknown as { maxFileBytes: number }).maxFileBytes = 4;
    await expect(
      createFile(u, { filename: "x", contentType: "text/plain", bytes: new Uint8Array([1, 2, 3, 4, 5]) }, storage),
    ).rejects.toMatchObject({ status: 413 });
    expect(storage.store.size).toBe(0); // nothing written when the size check fails
  });

  test("enforces the per-account file COUNT quota (413)", async () => {
    const u = makeUser();
    (config.files as unknown as { maxCount: number }).maxCount = 1;
    await createFile(u, { filename: "a", contentType: "text/plain", bytes: new Uint8Array([1]) }, storage);
    await expect(
      createFile(u, { filename: "b", contentType: "text/plain", bytes: new Uint8Array([1]) }, storage),
    ).rejects.toMatchObject({ status: 413 });
  });

  test("enforces the per-account TOTAL-BYTES quota (413)", async () => {
    const u = makeUser();
    (config.files as unknown as { maxTotalBytes: number }).maxTotalBytes = 3;
    await createFile(u, { filename: "a", contentType: "text/plain", bytes: new Uint8Array([1, 2]) }, storage);
    await expect(
      createFile(u, { filename: "b", contentType: "text/plain", bytes: new Uint8Array([3, 4]) }, storage),
    ).rejects.toMatchObject({ status: 413 });
  });

  test("rolls back the written blob when the metadata insert fails", async () => {
    // A non-existent user violates the FK on insert (foreign_keys=ON), so the row write throws
    // AFTER the blob is put — the service must remove the orphan.
    await expect(
      createFile("no-such-user", { filename: "a", contentType: "text/plain", bytes: new Uint8Array([1]) }, storage),
    ).rejects.toBeInstanceOf(Error);
    expect(storage.store.size).toBe(0); // orphan blob cleaned up
  });
});

describe("files/service — fileUsage", () => {
  test("counts files and sums bytes for the caller only", async () => {
    const u = makeUser();
    const other = makeUser();
    await createFile(u, { filename: "a", contentType: "text/plain", bytes: new Uint8Array([1, 2, 3]) }, storage);
    await createFile(u, { filename: "b", contentType: "text/plain", bytes: new Uint8Array([4, 5]) }, storage);
    await createFile(other, { filename: "c", contentType: "text/plain", bytes: new Uint8Array([9]) }, storage);
    expect(fileUsage(u)).toEqual({ count: 2, totalBytes: 5 });
    expect(fileUsage(other)).toEqual({ count: 1, totalBytes: 1 });
  });
});

describe("files/service — getFileForDownload", () => {
  test("returns the bytes + display metadata for the owner", async () => {
    const u = makeUser();
    const f = await createFile(u, { filename: "a.txt", contentType: "text/plain", bytes: new Uint8Array([7, 8, 9]) }, storage);
    const dl = await getFileForDownload(u, f.id, storage);
    expect(dl).not.toBeNull();
    expect(dl!.filename).toBe("a.txt");
    expect(Array.from(dl!.bytes)).toEqual([7, 8, 9]);
  });

  test("returns null for another account's file (no cross-user read)", async () => {
    const u = makeUser();
    const other = makeUser();
    const f = await createFile(u, { filename: "a", contentType: "text/plain", bytes: new Uint8Array([1]) }, storage);
    expect(await getFileForDownload(other, f.id, storage)).toBeNull();
  });

  test("returns null for an unknown id", async () => {
    const u = makeUser();
    expect(await getFileForDownload(u, "nope", storage)).toBeNull();
  });

  test("returns null when the blob is missing on the backend (half-deleted row)", async () => {
    const u = makeUser();
    const f = await createFile(u, { filename: "a", contentType: "text/plain", bytes: new Uint8Array([1]) }, storage);
    storage.store.clear(); // blob vanished, row remains
    expect(await getFileForDownload(u, f.id, storage)).toBeNull();
  });
});

describe("files/service — deleteFile", () => {
  test("removes the row + bytes for the owner and returns true", async () => {
    const u = makeUser();
    const f = await createFile(u, { filename: "a", contentType: "text/plain", bytes: new Uint8Array([1]) }, storage);
    expect(await deleteFile(u, f.id, storage)).toBe(true);
    expect(listFiles(u)).toHaveLength(0);
    expect(storage.store.size).toBe(0);
  });

  test("returns false for another account's file (never deletes it)", async () => {
    const u = makeUser();
    const other = makeUser();
    const f = await createFile(u, { filename: "a", contentType: "text/plain", bytes: new Uint8Array([1]) }, storage);
    expect(await deleteFile(other, f.id, storage)).toBe(false);
    expect(listFiles(u)).toHaveLength(1); // still there
  });

  test("returns false for an unknown id", async () => {
    const u = makeUser();
    expect(await deleteFile(u, "nope", storage)).toBe(false);
  });
});

describe("files/service — FileError", () => {
  test("carries the HTTP status", () => {
    expect(new FileError("x", 413).status).toBe(413);
  });
});

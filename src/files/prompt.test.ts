import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { files, users } from "../db/schema.ts";
import {
  attachmentsMeta,
  attachmentsPromptBlock,
  isTextAttachment,
  MAX_PROMPT_ATTACHMENTS,
  MAX_PROMPT_FILE_BYTES,
  parseStoredAttachments,
  resolveAttachments,
} from "./prompt.ts";
import { createFile } from "./service.ts";
import type { FileStorage } from "./storage.ts";

// In-memory storage so the resolver is exercised without disk I/O (same pattern as service.test).
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
  return db.insert(users).values({ login: `prompt-${Math.random()}`, role: "account" }).returning().get()!.id;
}
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  storage = new MemStorage();
});
afterEach(() => {
  db.delete(files).run();
  db.delete(users).run();
});

describe("files/prompt — isTextAttachment", () => {
  test("recognizes text-like content types", () => {
    for (const ct of ["text/plain", "text/markdown", "text/csv", "application/json", "application/xml", "image/svg+xml"]) {
      expect(isTextAttachment(ct)).toBe(true);
    }
  });
  test("is case-insensitive", () => {
    expect(isTextAttachment("TEXT/Plain")).toBe(true);
    expect(isTextAttachment("Application/JSON")).toBe(true);
  });
  test("rejects binary / media content types", () => {
    for (const ct of ["image/png", "application/pdf", "application/octet-stream", "audio/mpeg", "video/mp4"]) {
      expect(isTextAttachment(ct)).toBe(false);
    }
  });
});

describe("files/prompt — resolveAttachments", () => {
  test("resolves the caller's files and decodes text", async () => {
    const u = makeUser();
    const f = await createFile(u, { filename: "note.txt", contentType: "text/plain", bytes: enc("hello world") }, storage);
    const res = await resolveAttachments(u, [f.id], storage);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!).toMatchObject({ id: f.id, name: "note.txt", contentType: "text/plain", size: 11, text: "hello world" });
  });

  test("a non-text file resolves with text=null (attached but not inlined)", async () => {
    const u = makeUser();
    const f = await createFile(u, { filename: "pic.png", contentType: "image/png", bytes: enc("\x89PNGbinary") }, storage);
    const res = await resolveAttachments(u, [f.id], storage);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0]!.text).toBeNull();
    expect(res.items[0]!.name).toBe("pic.png");
  });

  test("rejects a stranger's / unknown id (no partial resolution)", async () => {
    const owner = makeUser();
    const stranger = makeUser();
    const f = await createFile(owner, { filename: "secret.txt", contentType: "text/plain", bytes: enc("secret") }, storage);
    // Another account may not resolve the owner's file id.
    expect((await resolveAttachments(stranger, [f.id], storage)).ok).toBe(false);
    // A wholly unknown id is likewise a reject.
    expect((await resolveAttachments(owner, ["does-not-exist"], storage)).ok).toBe(false);
    // One good + one bad id → the whole turn is rejected (never silently drops the bad one).
    const g = await createFile(owner, { filename: "ok.txt", contentType: "text/plain", bytes: enc("ok") }, storage);
    expect((await resolveAttachments(owner, [g.id, "nope"], storage)).ok).toBe(false);
  });

  test("de-duplicates repeated ids", async () => {
    const u = makeUser();
    const f = await createFile(u, { filename: "a.txt", contentType: "text/plain", bytes: enc("a") }, storage);
    const res = await resolveAttachments(u, [f.id, f.id, f.id], storage);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(1);
  });

  test("empty-string ids are skipped; an empty list resolves to no attachments", async () => {
    const u = makeUser();
    for (const ids of [[], ["", ""] as string[]]) {
      const res = await resolveAttachments(u, ids, storage);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.items).toHaveLength(0);
    }
  });

  test("caps the number of files inlined per turn", async () => {
    const u = makeUser();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PROMPT_ATTACHMENTS + 3; i++) {
      const f = await createFile(u, { filename: `f${i}.txt`, contentType: "text/plain", bytes: enc(`x${i}`) }, storage);
      ids.push(f.id);
    }
    const res = await resolveAttachments(u, ids, storage);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items).toHaveLength(MAX_PROMPT_ATTACHMENTS);
  });

  test("stops inlining text once the per-turn total budget is spent (later files carry no text)", async () => {
    const u = makeUser();
    // Four full-size text files spend the whole per-turn total (4 × per-file cap = total cap); the
    // fifth text file then resolves with text=null — attached + shown, but not inlined.
    const perFile = "A".repeat(MAX_PROMPT_FILE_BYTES);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = await createFile(u, { filename: `f${i}.txt`, contentType: "text/plain", bytes: enc(perFile) }, storage);
      ids.push(f.id);
    }
    const res = await resolveAttachments(u, ids, storage);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // At least one later file was pushed with no inlined text once the total budget ran out.
    expect(res.items.some((a) => a.text === null)).toBe(true);
  });

  test("truncates a file over the per-file byte budget", async () => {
    const u = makeUser();
    const big = "A".repeat(MAX_PROMPT_FILE_BYTES + 100);
    const f = await createFile(u, { filename: "big.txt", contentType: "text/plain", bytes: enc(big) }, storage);
    const res = await resolveAttachments(u, [f.id], storage);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0]!.text).toContain("…[truncated]");
    expect(res.items[0]!.text!.length).toBeLessThan(big.length);
  });
});

describe("files/prompt — attachmentsPromptBlock", () => {
  test("builds a system block inlining the text files", () => {
    const block = attachmentsPromptBlock([
      { id: "1", name: "a.txt", contentType: "text/plain", size: 3, text: "abc" },
    ]);
    expect(block).not.toBeNull();
    expect(block!.role).toBe("system");
    expect(block!.content).toContain("a.txt");
    expect(block!.content).toContain("abc");
  });

  test("lists a non-text file by name without bytes", () => {
    const block = attachmentsPromptBlock([
      { id: "1", name: "doc.txt", contentType: "text/plain", size: 3, text: "abc" },
      { id: "2", name: "pic.png", contentType: "image/png", size: 9, text: null },
    ]);
    expect(block!.content).toContain("pic.png");
    expect(block!.content).toContain("non-text");
  });

  test("returns null only when there are no attachments at all", () => {
    expect(attachmentsPromptBlock([])).toBeNull();
  });

  test("an image-only turn still names the file (so the model knows it was attached)", () => {
    const block = attachmentsPromptBlock([{ id: "1", name: "pic.png", contentType: "image/png", size: 9, text: null }]);
    expect(block).not.toBeNull();
    expect(block!.content).toContain("pic.png");
    expect(block!.content).toContain("non-text");
  });
});

describe("files/prompt — attachmentsMeta + parseStoredAttachments", () => {
  test("meta strips text; parse round-trips it", () => {
    const meta = attachmentsMeta([{ id: "1", name: "a.txt", contentType: "text/plain", size: 3, text: "abc" }]);
    expect(meta).toEqual([{ id: "1", name: "a.txt", contentType: "text/plain", size: 3 }]);
    expect(parseStoredAttachments(JSON.stringify(meta))).toEqual(meta);
  });

  test("parse tolerates null / blank / corrupt / malformed input", () => {
    expect(parseStoredAttachments(null)).toBeUndefined();
    expect(parseStoredAttachments("")).toBeUndefined();
    expect(parseStoredAttachments("not json")).toBeUndefined();
    expect(parseStoredAttachments('{"not":"array"}')).toBeUndefined();
    expect(parseStoredAttachments("[]")).toBeUndefined();
    // A malformed entry (missing fields / wrong types) is dropped, not thrown on.
    expect(parseStoredAttachments('[{"id":"1"},{"id":1,"name":"x","contentType":"t","size":2}]')).toBeUndefined();
  });

  test("parse keeps only well-formed entries", () => {
    const raw = JSON.stringify([
      { id: "1", name: "a.txt", contentType: "text/plain", size: 3 },
      { id: "2", name: "b", contentType: "text/plain" }, // missing size → dropped
    ]);
    expect(parseStoredAttachments(raw)).toEqual([{ id: "1", name: "a.txt", contentType: "text/plain", size: 3 }]);
  });
});

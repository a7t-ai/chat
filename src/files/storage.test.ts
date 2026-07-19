import { rm } from "node:fs/promises";
import { afterAll, describe, expect, test } from "bun:test";
import {
  contentDisposition,
  LocalFileStorage,
  resolveWithin,
  sanitizeContentType,
  sanitizeFilename,
  storageKeyFor,
} from "./storage.ts";

const ROOT = `/tmp/a7t-chat-storage-test-${process.pid}`;
afterAll(() => rm(ROOT, { recursive: true, force: true }));

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const DEL = String.fromCharCode(127);

describe("files/storage — storageKeyFor", () => {
  test("joins user + id and contains no traversal chars", () => {
    const key = storageKeyFor("u-123", "f-456");
    expect(key).toBe("u-123/f-456");
    expect(key.includes("..")).toBe(false);
  });
});

describe("files/storage — resolveWithin", () => {
  test("resolves a normal key under the root", () => {
    expect(resolveWithin("/tmp/store", "user/file")).toBe("/tmp/store/user/file");
  });

  test("rejects a key that escapes the root", () => {
    expect(() => resolveWithin("/tmp/store", "../../etc/passwd")).toThrow("invalid storage key");
    expect(() => resolveWithin("/tmp/store", "/etc/passwd")).toThrow("invalid storage key");
  });

  test("allows the root itself (empty key)", () => {
    expect(resolveWithin("/tmp/store", "")).toBe("/tmp/store");
  });
});

describe("files/storage — LocalFileStorage", () => {
  const storage = new LocalFileStorage(() => ROOT);

  test("put → read round-trips the exact bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await storage.put("u1/f1", bytes);
    const back = await storage.read("u1/f1");
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual([1, 2, 3, 4, 5]);
  });

  test("read returns null for a missing key", async () => {
    expect(await storage.read("u1/does-not-exist")).toBeNull();
  });

  test("remove deletes the blob and is idempotent", async () => {
    await storage.put("u1/f2", new Uint8Array([9]));
    await storage.remove("u1/f2");
    expect(await storage.read("u1/f2")).toBeNull();
    await storage.remove("u1/f2"); // already gone — a no-op, never throws
  });

  test("refuses a traversal key on write", async () => {
    await expect(storage.put("../escape", new Uint8Array([1]))).rejects.toThrow("invalid storage key");
  });
});

describe("files/storage — sanitizeFilename", () => {
  test("keeps a normal name", () => {
    expect(sanitizeFilename("report.pdf")).toBe("report.pdf");
  });

  test("strips directory components (no path traversal via the display name)", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\a\\secret.txt")).toBe("secret.txt");
  });

  test("strips control chars (NUL, tab, DEL) and double quotes", () => {
    expect(sanitizeFilename(`ab${NUL}${TAB}${DEL}cd.txt`)).toBe("abcd.txt");
    expect(sanitizeFilename(`quote${'"'}name.txt`)).toBe("quotename.txt");
  });

  test("collapses runs of whitespace to a single space", () => {
    expect(sanitizeFilename("a   b.txt")).toBe("a b.txt");
  });

  test("falls back to 'file' for empty / dots-only / non-string input", () => {
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename(null)).toBe("file");
    expect(sanitizeFilename(123)).toBe("file");
  });

  test("bounds the length to 200 chars", () => {
    expect(sanitizeFilename("x".repeat(500)).length).toBe(200);
  });

  test("never leaves a lone surrogate when truncation splits a surrogate pair", () => {
    // 199 ASCII chars + one emoji (a surrogate pair): the 200-char slice cuts mid-pair, which
    // would leave a lone high surrogate. The result must be well-formed so the download can't 500.
    const name = `${"a".repeat(199)}😀`;
    const out = sanitizeFilename(name);
    expect(out.isWellFormed()).toBe(true);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });
});

describe("files/storage — sanitizeContentType", () => {
  test("keeps a valid type and lowercases it", () => {
    expect(sanitizeContentType("Image/PNG")).toBe("image/png");
    expect(sanitizeContentType("application/vnd.api+json")).toBe("application/vnd.api+json");
  });

  test("drops parameters", () => {
    expect(sanitizeContentType("text/plain; charset=utf-8")).toBe("text/plain");
  });

  test("degrades malformed / empty / oversized to octet-stream", () => {
    expect(sanitizeContentType("not-a-type")).toBe("application/octet-stream");
    expect(sanitizeContentType("")).toBe("application/octet-stream");
    expect(sanitizeContentType(null)).toBe("application/octet-stream");
    expect(sanitizeContentType(`a/${"b".repeat(200)}`)).toBe("application/octet-stream");
  });
});

describe("files/storage — contentDisposition", () => {
  test("forces an attachment with an ASCII fallback + RFC 5987 name", () => {
    expect(contentDisposition("report.pdf")).toBe(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
  });

  test("neutralizes non-ASCII + delimiters in the ASCII fallback but keeps them encoded", () => {
    const cd = contentDisposition("rés umé.pdf");
    expect(cd.startsWith("attachment; ")).toBe(true);
    expect(cd).toContain('filename="r_s um_.pdf"'); // é → _ in the ASCII fallback
    expect(cd).toContain("filename*=UTF-8''r%C3%A9s%20um%C3%A9.pdf");
  });

  test("a fully-non-ASCII name still yields a usable ASCII fallback", () => {
    expect(contentDisposition(String.fromCharCode(0x3000)).includes('filename="_"')).toBe(true);
  });

  test("does not throw on a lone surrogate (defense-in-depth for the encode)", () => {
    const lone = `report${String.fromCharCode(0xd83d)}.pdf`; // lone high surrogate
    expect(() => contentDisposition(lone)).not.toThrow();
    expect(contentDisposition(lone).startsWith("attachment; ")).toBe(true);
  });
});

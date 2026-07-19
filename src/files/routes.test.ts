import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SESSION_COOKIE } from "../auth/cookie.ts";
import { createSession } from "../auth/session.service.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { files, users } from "../db/schema.ts";
import server from "../server.ts";

function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(server.fetch(new Request(`http://localhost${path}`, init)));
}
// Admin = the LOCAL break-glass bootstrap (#191 removed the Tailscale-header admin path). Setting
// DEV_ADMIN_LOGIN admits a credential-less, non-edge request as that login-keyed admin. Returns `{}`;
// the side effect is the grant. beforeEach clears it so account-cookie tests aren't preempted.
function adminHeaders(login = `files-admin-${Math.random()}`): Record<string, string> {
  (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = login;
  return {};
}
function accountSession(): string {
  const u = db
    .insert(users)
    .values({ login: `files-acct-${Math.random()}`, email: `${Math.random()}@a7t.test`, role: "account", accessGrantedAt: new Date() })
    .returning()
    .get()!;
  return createSession({ userId: u.id }).token;
}

// Build a multipart upload body with a single `file` part.
function upload(headers: Record<string, string>, name: string, type: string, bytes: Uint8Array): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return fetchApp("/api/files", { method: "POST", headers, body: form });
}

const savedLimits = { ...config.files };

beforeEach(() => {
  const a = config.auth as unknown as { devAdminLogin: string; edgeMarkerSecret: string };
  a.devAdminLogin = "";
  a.edgeMarkerSecret = "";
});
afterEach(() => {
  db.delete(files).run();
  (config.files as unknown as { maxFileBytes: number }).maxFileBytes = savedLimits.maxFileBytes;
  (config.files as unknown as { maxTotalBytes: number }).maxTotalBytes = savedLimits.maxTotalBytes;
  (config.files as unknown as { maxCount: number }).maxCount = savedLimits.maxCount;
});
afterAll(() => rm(config.files.dir, { recursive: true, force: true }));

describe("/api/files — auth", () => {
  test("401 without a credential", async () => {
    expect((await fetchApp("/api/files")).status).toBe(401);
  });
});

describe("/api/files — lifecycle", () => {
  test("upload → list → download → delete for an account", async () => {
    const cookie = `${SESSION_COOKIE}=${accountSession()}`;
    const headers = { cookie };

    // list starts empty and carries usage + limits
    let res = await fetchApp("/api/files", { headers });
    expect(res.status).toBe(200);
    let body = (await res.json()) as { files: unknown[]; usage: { count: number }; limits: { maxCount: number } };
    expect(body.files).toHaveLength(0);
    expect(body.usage.count).toBe(0);
    expect(body.limits.maxCount).toBeGreaterThan(0);

    // upload
    res = await upload(headers, "hello.txt", "text/plain", new Uint8Array([104, 105]));
    expect(res.status).toBe(201);
    const up = (await res.json()) as { ok: boolean; file: { id: string; filename: string; size: number } };
    expect(up).toMatchObject({ ok: true, file: { filename: "hello.txt", size: 2 } });
    const id = up.file.id;

    // list reflects it
    res = await fetchApp("/api/files", { headers });
    body = (await res.json()) as { files: { id: string }[]; usage: { count: number }; limits: { maxCount: number } };
    expect(body.files).toHaveLength(1);
    expect(body.usage.count).toBe(1);

    // download returns the bytes with a forced-attachment + nosniff header set
    res = await fetchApp(`/api/files/${id}`, { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([104, 105]));

    // delete
    res = await fetchApp(`/api/files/${id}`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
    res = await fetchApp("/api/files", { headers });
    expect(((await res.json()) as { files: unknown[] }).files).toHaveLength(0);
  });

  test("an HTML upload is served as an attachment, never rendered inline (no stored-XSS)", async () => {
    const headers = { cookie: `${SESSION_COOKIE}=${accountSession()}` };
    const res = await upload(headers, "evil.html", "text/html", new TextEncoder().encode("<script>alert(1)</script>"));
    const id = (await res.json() as { file: { id: string } }).file.id;
    const dl = await fetchApp(`/api/files/${id}`, { headers });
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("/api/files — scoping + errors", () => {
  test("files are per-caller — one account never sees or downloads another's", async () => {
    const aHeaders = { cookie: `${SESSION_COOKIE}=${accountSession()}` };
    const bHeaders = { cookie: `${SESSION_COOKIE}=${accountSession()}` };
    const res = await upload(aHeaders, "a.txt", "text/plain", new Uint8Array([1]));
    const id = (await res.json() as { file: { id: string } }).file.id;

    // B's list is empty
    const list = await fetchApp("/api/files", { headers: bHeaders });
    expect(((await list.json()) as { files: unknown[] }).files).toHaveLength(0);

    // B can neither download nor delete A's file (404, no existence oracle)
    expect((await fetchApp(`/api/files/${id}`, { headers: bHeaders })).status).toBe(404);
    expect((await fetchApp(`/api/files/${id}`, { method: "DELETE", headers: bHeaders })).status).toBe(404);
  });

  test("download / delete of an unknown id is a 404", async () => {
    const headers = { cookie: `${SESSION_COOKIE}=${accountSession()}` };
    expect((await fetchApp("/api/files/nope", { headers })).status).toBe(404);
    expect((await fetchApp("/api/files/nope", { method: "DELETE", headers })).status).toBe(404);
  });

  test("POST without a file part is a 400", async () => {
    const headers = { cookie: `${SESSION_COOKIE}=${accountSession()}` };
    const form = new FormData();
    form.append("notfile", "x");
    const res = await fetchApp("/api/files", { method: "POST", headers, body: form });
    expect(res.status).toBe(400);
  });

  test("an empty file is a 400", async () => {
    const headers = { cookie: `${SESSION_COOKIE}=${accountSession()}` };
    const res = await upload(headers, "empty.txt", "text/plain", new Uint8Array([]));
    expect(res.status).toBe(400);
  });

  test("a file over the per-file cap is a 413", async () => {
    (config.files as unknown as { maxFileBytes: number }).maxFileBytes = 3;
    const headers = { cookie: `${SESSION_COOKIE}=${accountSession()}` };
    const res = await upload(headers, "big.bin", "application/octet-stream", new Uint8Array([1, 2, 3, 4, 5]));
    expect(res.status).toBe(413);
  });

  test("exceeding the count quota is a 413", async () => {
    (config.files as unknown as { maxCount: number }).maxCount = 1;
    const headers = { cookie: `${SESSION_COOKIE}=${accountSession()}` };
    expect((await upload(headers, "a", "text/plain", new Uint8Array([1]))).status).toBe(201);
    expect((await upload(headers, "b", "text/plain", new Uint8Array([1]))).status).toBe(413);
  });

  test("admin can also manage their own files", async () => {
    const h = adminHeaders("files-admin@github");
    await fetchApp("/api/me", { headers: h }); // seed the admin user row
    const res = await upload(h, "note.md", "text/markdown", new Uint8Array([35, 32, 104]));
    expect(res.status).toBe(201);
    const list = await fetchApp("/api/files", { headers: h });
    expect(((await list.json()) as { files: unknown[] }).files).toHaveLength(1);
  });
});

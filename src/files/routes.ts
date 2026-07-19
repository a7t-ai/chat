import { Hono } from "hono";
import { requireFeature } from "../entitlements/index.ts";
import {
  createFile,
  deleteFile,
  FileError,
  fileLimits,
  fileUsage,
  getFileForDownload,
  listFiles,
} from "./service.ts";
import { contentDisposition } from "./storage.ts";

// Attachments / file manager (#15). Mounted at /api/files, already behind the auth gate. EVERY
// route is gated by the `files` entitlement, and every operation is scoped to the authenticated
// caller (auth.user.id) — no route names another user, so cross-account access is impossible.
// Responses carry metadata only (never the storage key); downloads are always served as an
// attachment with nosniff so an uploaded HTML/SVG can never render inline on the app origin.
const filesApp = new Hono();

filesApp.use("*", requireFeature("files"));

// The caller's files + their footprint + the configured limits (drives the manager UI + meter).
filesApp.get("/", (c) => {
  const auth = c.get("auth");
  return c.json({ files: listFiles(auth.user.id), usage: fileUsage(auth.user.id), limits: fileLimits() });
});

// Upload a file (multipart form-data, field `file`). Size + per-account quota are enforced in the
// service; a rejection surfaces as its FileError status (400 empty/bad request, 413 too-large/quota).
filesApp.post("/", async (c) => {
  const auth = c.get("auth");
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "expected multipart form data" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const meta = await createFile(auth.user.id, { filename: file.name, contentType: file.type, bytes });
    return c.json({ ok: true, file: meta }, 201);
  } catch (e) {
    if (e instanceof FileError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// Download the caller's file. Scoped to the caller (unknown / another account's id → 404, no
// existence oracle). Forced download: attachment + nosniff + private no-store, so per-account bytes
// are never rendered inline nor cached by a shared proxy.
filesApp.get("/:id", async (c) => {
  const auth = c.get("auth");
  const dl = await getFileForDownload(auth.user.id, c.req.param("id"));
  if (!dl) return c.json({ error: "not found" }, 404);
  return new Response(dl.bytes, {
    status: 200,
    headers: {
      "Content-Type": dl.contentType,
      "Content-Disposition": contentDisposition(dl.filename),
      "Content-Length": String(dl.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});

// Delete the caller's file (row + bytes). Unknown / not-the-caller's id → 404 (no existence oracle).
filesApp.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const removed = await deleteFile(auth.user.id, c.req.param("id"));
  if (!removed) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

export default filesApp;

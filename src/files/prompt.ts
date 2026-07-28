import type { ChatMessage, ContentPart } from "../jano/types.ts";
import { getFileForDownload } from "./service.ts";
import { defaultStorage, type FileStorage } from "./storage.ts";

// files-to-prompt (#128) — the seam that turns a user's attached files into model context. A turn
// carries `fileIds`; this module resolves them (scoped to the caller — a stranger's id is a hard
// reject, never delivered), inlines the TEXT of text-like files into a system block, and hands back
// the metadata to persist on the message. Non-text (images / audio / binary) attach + upload + show
// in the gallery but are NOT delivered to the model here — true multimodal routing is a later
// ticket (see #128 scope). Everything is bounded so an attachment can never blow the context window.

// The caps: how many files one turn may carry, the per-file text budget, and the total across all
// files. All in bytes of the decoded text. A file over the per-file cap is truncated (with a marker)
// rather than dropped, so the model still sees the head; the total cap stops one turn from inlining
// a whole quota's worth of text.
export const MAX_PROMPT_ATTACHMENTS = 10;
export const MAX_PROMPT_FILE_BYTES = 128 * 1024; // 128 KB of text per file
export const MAX_PROMPT_TOTAL_BYTES = 512 * 1024; // 512 KB of text across the turn
// An image delivered to a multimodal model (#235) is base64-inlined into the request, so it is
// bounded on its own: a photo is fine, a huge raw scan is not. Over this the image stays named-only
// (attached + shown, not delivered) exactly like other non-text files. The file manager's per-file
// cap (25 MB) is the outer bound; this is the inner "sensible to inline" cap.
export const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB of raw image bytes

// The metadata we persist on the user message + return to the client (never the bytes).
export interface MessageAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

// A resolved attachment: its metadata, the decoded text when it's a text-like file (null otherwise),
// and — for an image delivered to a multimodal model (#235) — a base64 `data:` URL. At most one of
// `text` / `dataUrl` is set; a non-text file that is neither (audio/video/binary, or an over-cap or
// non-multimodal image) is shown in the gallery but not delivered to the model.
export interface ResolvedAttachment extends MessageAttachment {
  text: string | null;
  dataUrl?: string;
}

// Image content types we can deliver as multimodal `image_url` parts. SVG is deliberately excluded —
// it is XML text (handled by isTextAttachment) and is never rendered, so it must not be sent as an image.
export function isImageAttachment(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.startsWith("image/") && ct !== "image/svg+xml";
}

// Text-like content types whose bytes we inline verbatim. A conservative allowlist: `text/*` plus a
// handful of textual `application/*` families (JSON, XML, JS, CSV, YAML, x-www-form). Anything else
// (images, PDFs, office docs, audio, octet-stream) is treated as non-text — attached + shown, but
// its bytes are never decoded into the prompt. Kept a pure function so it's unit-testable.
export function isTextAttachment(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/")) return true;
  return [
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/xhtml+xml",
    "application/javascript",
    "application/ecmascript",
    "application/x-yaml",
    "application/yaml",
    "application/csv",
    "application/x-www-form-urlencoded",
    "application/x-sh",
    "application/x-httpd-php",
    "image/svg+xml", // SVG is XML text — safe to read as source (never rendered inline)
  ].includes(ct);
}

// Decode bytes as UTF-8 text, bounding the amount inlined. `fatal:false` means invalid sequences
// become the replacement char rather than throwing — a binary file mislabeled as text degrades to
// garbage text instead of a 500 (it's still bounded + clearly not useful, never a crash).
function decodeBounded(bytes: Uint8Array, budget: number): { text: string; truncated: boolean } {
  const slice = bytes.length > budget ? bytes.subarray(0, budget) : bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return { text, truncated: bytes.length > budget };
}

export type ResolveResult =
  | { ok: true; items: ResolvedAttachment[] }
  | { ok: false }; // at least one id doesn't belong to the caller (or doesn't exist)

// Resolve a turn's `fileIds` to attachments, scoped to `userId`. Every id must belong to the caller:
// `getFileForDownload` returns null both for another account's id AND a non-existent one (no
// existence oracle), so a single null is a hard reject — the caller 404s the whole turn rather than
// silently dropping ids. Ids are de-duplicated (a repeated id resolves once) and capped at
// MAX_PROMPT_ATTACHMENTS. Text-like files are decoded (bounded per-file and in total); non-text
// files resolve with `text: null`. Order follows the caller's first mention of each id.
export async function resolveAttachments(
  userId: string,
  fileIds: string[],
  storage: FileStorage = defaultStorage,
  opts: { deliverImages?: boolean } = {},
): Promise<ResolveResult> {
  // De-dupe while preserving first-seen order, and bound the count.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of fileIds) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_PROMPT_ATTACHMENTS) break;
  }

  const items: ResolvedAttachment[] = [];
  let totalTextBytes = 0;
  for (const id of ids) {
    const file = await getFileForDownload(userId, id, storage);
    if (!file) return { ok: false }; // not the caller's / doesn't exist → reject the turn
    const meta: MessageAttachment = {
      id,
      name: file.filename,
      contentType: file.contentType,
      size: file.size,
    };
    if (!isTextAttachment(file.contentType)) {
      // A multimodal model can READ images: deliver an image under the inline cap as a base64 data
      // URL (#235), so it rides the user message as an image_url part. Everything else (audio/video/
      // binary, an over-cap image, or ANY file when the model can't read images) stays named-only —
      // attached + shown in the gallery, never inlined.
      if (opts.deliverImages && isImageAttachment(file.contentType) && file.bytes.length <= MAX_PROMPT_IMAGE_BYTES) {
        const b64 = Buffer.from(file.bytes).toString("base64");
        items.push({ ...meta, text: null, dataUrl: `data:${file.contentType};base64,${b64}` });
      } else {
        items.push({ ...meta, text: null });
      }
      continue;
    }
    // Bound this file to whatever's left of the total budget, capped at the per-file limit.
    const remaining = Math.max(0, MAX_PROMPT_TOTAL_BYTES - totalTextBytes);
    const budget = Math.min(MAX_PROMPT_FILE_BYTES, remaining);
    if (budget <= 0) {
      // The total text budget is spent — keep the attachment (it's shown/persisted) but inline none.
      items.push({ ...meta, text: null });
      continue;
    }
    const { text, truncated } = decodeBounded(file.bytes, budget);
    totalTextBytes += Math.min(file.bytes.length, budget);
    items.push({ ...meta, text: truncated ? `${text}\n…[truncated]` : text });
  }
  return { ok: true, items };
}

// Build the system block that inlines the resolved text files into the model context. Returns null
// only when there are no attachments at all. Each text file is fenced with its name so the model can
// attribute content to a source; a non-text file (image/audio/binary) is listed by name only so the
// model KNOWS it was attached without receiving bytes it can't use yet (true multimodal delivery is
// a later ticket — see #128 scope).
export function attachmentsPromptBlock(items: ResolvedAttachment[]): ChatMessage | null {
  // Images delivered as multimodal parts (#235) ride the user message, not this system block — skip
  // them here so they aren't also announced as "not included". Everything else is listed as before.
  const undelivered = items.filter((a) => a.dataUrl === undefined);
  if (undelivered.length === 0) return null;

  const parts = [
    "The user attached the following file(s). Use their contents to answer.",
    "",
  ];
  for (const a of undelivered) {
    if (a.text !== null) {
      parts.push(`--- FILE: ${a.name} (${a.contentType}) ---`, a.text, "--- END FILE ---", "");
    } else {
      parts.push(`--- FILE: ${a.name} (${a.contentType}) — non-text, contents not included ---`, "");
    }
  }
  return { role: "system", content: parts.join("\n").trimEnd() };
}

// Build the multimodal `content` parts for the user turn (#235): the message text, then one
// image_url part per delivered image. Returns null when no image was delivered, so the turn stays a
// plain-string message. Text first so the model reads the question before the images.
export function multimodalUserParts(text: string, items: ResolvedAttachment[]): ContentPart[] | null {
  const images = items.filter((a) => a.dataUrl !== undefined);
  if (images.length === 0) return null;
  return [
    { type: "text", text },
    ...images.map((a): ContentPart => ({ type: "image_url", image_url: { url: a.dataUrl as string } })),
  ];
}

// Attach multimodal parts to the LAST message of a prompt array when it is the user turn (#235).
// The persisted path builds the current user message from the stored thread rather than inline, so
// this is how images reach it. A no-op (array returned unchanged) when parts is null or the last
// message is not a user turn, so callers can pass through unconditionally.
export function applyUserPartsToLast(messages: ChatMessage[], parts: ContentPart[] | null): ChatMessage[] {
  if (!parts) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;
  return [...messages.slice(0, -1), { ...last, parts }];
}

// The metadata to persist on the user message (bytes/text stripped) — what the transcript renders.
export function attachmentsMeta(items: ResolvedAttachment[]): MessageAttachment[] {
  return items.map(({ id, name, contentType, size }) => ({ id, name, contentType, size }));
}

// Parse the `attachments` JSON stored on a message row back into metadata for the read payload.
// Tolerant: a null/blank/corrupt value (or a non-array / malformed entries) yields undefined rather
// than throwing, so a bad row can never break a conversation read.
export function parseStoredAttachments(raw: string | null): MessageAttachment[] | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const items: MessageAttachment[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as MessageAttachment).id === "string" &&
      typeof (entry as MessageAttachment).name === "string" &&
      typeof (entry as MessageAttachment).contentType === "string" &&
      typeof (entry as MessageAttachment).size === "number"
    ) {
      const e = entry as MessageAttachment;
      items.push({ id: e.id, name: e.name, contentType: e.contentType, size: e.size });
    }
  }
  return items.length > 0 ? items : undefined;
}

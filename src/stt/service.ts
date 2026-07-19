import { config } from "../config.ts";
import type { DictationEvent } from "./types.ts";

// Live dictation / streaming STT (#71) — the "text streams as you speak" proxy seam. It sits
// ALONGSIDE the batch Whisper `/transcribe` route (src/chat/routes.ts), never replacing it:
// batch stays the fallback. DARK by default — with STREAMING_STT_URL unset the feature reports
// unavailable, the route 503s, and the client shows only the batch mic. The owner sets the env
// var to a streaming ASR service AFTER validating a model, and it lights up. Backend-agnostic:
// the URL is operator-configured (no user-supplied URL ⇒ no SSRF surface, like the fixed BYOK
// provider bases).

// Fails-closed error carrying the HTTP status the route should surface. An unset backend is a
// 503 (feature dark); an upstream failure is a 502 (the client falls back to batch).
export class DictationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DictationError";
  }
}

// Whether a streaming STT backend is configured. Drives the `/api/me` flag (show the live
// mic) AND the route guard (defense in depth — never trust the client to have hidden it).
export function streamingDictationAvailable(): boolean {
  return config.dictation.streamingUrl.length > 0;
}

// Normalize ONE line/frame from the upstream into a DictationEvent, or null when the line
// carries no event (blank line, SSE `event:`/comment line, a `[DONE]` sentinel, or an
// unrecognized shape). PURE + total so it's exhaustively testable without a network. Accepts,
// in order of preference:
//   - the documented contract: `{type:'partial'|'final', text}`
//   - a terse shim shape:      `{final:"..."}` / `{partial:"..."}`
//   - an OpenAI-ish one-shot:  `{text:"..."}` (treated as a partial)
// An `data:` SSE prefix is stripped first, so an SSE OR a newline-delimited-JSON upstream both
// parse through the same path.
export function parseDictationLine(line: string): DictationEvent | null {
  let s = line.trim();
  if (!s) return null;
  if (s.startsWith("data:")) s = s.slice(5).trim();
  if (!s || s === "[DONE]") return null;
  if (!s.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Terse shim shapes carry the text on the type-named key.
  if (typeof obj.final === "string") return { type: "final", text: obj.final };
  if (typeof obj.partial === "string") return { type: "partial", text: obj.partial };
  if (typeof obj.text !== "string") return null;
  return { type: obj.type === "final" ? "final" : "partial", text: obj.text };
}

// Proxy the audio to the configured streaming STT service and yield normalized events as they
// arrive. Backend-agnostic: it POSTs the audio (the caller's cumulative buffer for this segment)
// to STREAMING_STT_URL and relays the upstream's partial/final events. When `final` is requested
// (the user stopped) and the upstream never sent a terminal `final`, a synthetic `final` carrying
// the last seen text is emitted so the transcript commits — this is what lets a plain batch-style
// upstream double as a streaming backend.
//
// Throws DictationError on an unset backend (503, fails closed → dark) or an upstream failure
// (502, the client falls back to batch). The `audio` is a bounded buffer (the request body limit
// caps it), so buffering it avoids the browser/undici full-duplex streaming-body caveats.
export async function* proxyStreamingDictation(
  audio: ArrayBuffer | Uint8Array,
  opts: { contentType: string; final: boolean; signal?: AbortSignal },
): AsyncGenerator<DictationEvent> {
  if (!streamingDictationAvailable()) {
    throw new DictationError("live dictation is not configured", 503);
  }
  let res: Response;
  try {
    res = await fetch(config.dictation.streamingUrl, {
      method: "POST",
      headers: { "content-type": opts.contentType || "application/octet-stream" },
      body: audio,
      signal: opts.signal,
    });
  } catch (e) {
    throw new DictationError(`streaming stt upstream unreachable: ${(e as Error).message}`, 502);
  }
  if (!res.ok || !res.body) {
    throw new DictationError(`streaming stt upstream -> ${res.status}`, 502);
  }

  let last: DictationEvent | null = null;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Frames are newline-delimited (NDJSON, or one SSE `data:` line per frame). Parse each
    // complete line; keep the trailing partial line buffered for the next chunk.
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const ev = parseDictationLine(line);
      if (ev) {
        last = ev;
        yield ev;
      }
    }
  }
  const tail = parseDictationLine(buf);
  if (tail) {
    last = tail;
    yield tail;
  }

  // Commit on stop: if the caller signaled the final segment and the upstream never sent a
  // terminal `final`, synthesize one from the last text so the composer commits what was said.
  if (opts.final && last && last.type !== "final") {
    yield { type: "final", text: last.text };
  }
}

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireFeature } from "../entitlements/index.ts";
import { DictationError, proxyStreamingDictation, streamingDictationAvailable } from "./service.ts";

// Live dictation / streaming STT proxy (#71). Mounted at `/api/dictate`. Same gate as the batch
// `/transcribe` route: authed (behind the /api auth middleware) + the `chat.voice` entitlement, a
// caller-scoped action — no new public surface. DARK by default: with STREAMING_STT_URL unset this
// 503s and the client shows only the batch mic. On any upstream error the SSE stream emits an
// `error` frame and the client falls back to batch. The audio for the current (cumulative) segment
// is POSTed as the request body; `?final=1` marks the last segment so the transcript commits on stop.
const stt = new Hono();

stt.post("/", requireFeature("chat.voice"), async (c) => {
  // Dark-by-default: fail closed before touching the body when no streaming backend is configured.
  if (!streamingDictationAvailable()) {
    return c.json({ error: "unavailable", message: "live dictation is not configured" }, 503);
  }
  const final = c.req.query("final") === "1";
  const contentType = c.req.header("content-type") ?? "application/octet-stream";
  // Buffer the bounded segment (the 30MB body limit caps it) rather than stream the request body
  // onward — avoids the browser/undici full-duplex streaming-body caveats and keeps the proxy simple.
  const audio = await c.req.arrayBuffer();
  if (audio.byteLength === 0) return c.json({ error: "no audio" }, 400);
  const signal = c.req.raw.signal;

  return streamSSE(c, async (stream) => {
    try {
      for await (const ev of proxyStreamingDictation(audio, { contentType, final, signal })) {
        await stream.writeSSE({ event: ev.type, data: JSON.stringify({ text: ev.text }) });
      }
    } catch (e) {
      // Client disconnect (Stop): the stream is gone, nothing to report.
      if (signal.aborted) return;
      const status = e instanceof DictationError ? e.status : 502;
      await stream.writeSSE({ event: "error", data: JSON.stringify({ message: (e as Error).message, status }) });
    }
  });
});

export default stt;

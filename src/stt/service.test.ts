import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import type { DictationEvent } from "./types.ts";
import { DictationError, parseDictationLine, proxyStreamingDictation, streamingDictationAvailable } from "./service.ts";

// Toggle the operator-configured backend URL (config is `as const` — mutate through a cast, the
// same trick the billing tests use for config.auth).
function setStreamingUrl(url: string): void {
  (config.dictation as unknown as { streamingUrl: string }).streamingUrl = url;
}

// A stubbed upstream Response whose body streams `text` (optionally in several chunks, to
// exercise the line-buffering across read boundaries).
function upstreamResponse(chunks: string[], init: { status?: number } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: init.status ?? 200 });
}

async function collect(gen: AsyncGenerator<DictationEvent>): Promise<DictationEvent[]> {
  const out: DictationEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setStreamingUrl("");
});

describe("streamingDictationAvailable", () => {
  test("dark when STREAMING_STT_URL unset", () => {
    setStreamingUrl("");
    expect(streamingDictationAvailable()).toBe(false);
  });
  test("available once a backend URL is configured", () => {
    setStreamingUrl("http://127.0.0.1:9999/dictate");
    expect(streamingDictationAvailable()).toBe(true);
  });
});

describe("parseDictationLine", () => {
  test("the documented contract shape", () => {
    expect(parseDictationLine('{"type":"partial","text":"hello"}')).toEqual({ type: "partial", text: "hello" });
    expect(parseDictationLine('{"type":"final","text":"hello world"}')).toEqual({ type: "final", text: "hello world" });
  });
  test("an unknown type defaults to partial", () => {
    expect(parseDictationLine('{"type":"interim","text":"hi"}')).toEqual({ type: "partial", text: "hi" });
  });
  test("the terse shim shapes", () => {
    expect(parseDictationLine('{"partial":"one"}')).toEqual({ type: "partial", text: "one" });
    expect(parseDictationLine('{"final":"done"}')).toEqual({ type: "final", text: "done" });
  });
  test("an OpenAI-ish one-shot {text} is treated as a partial", () => {
    expect(parseDictationLine('{"text":"just words"}')).toEqual({ type: "partial", text: "just words" });
  });
  test("strips an SSE data: prefix", () => {
    expect(parseDictationLine('data: {"type":"final","text":"x"}')).toEqual({ type: "final", text: "x" });
  });
  test("ignores blank lines, SSE event/comment lines, [DONE], and non-JSON", () => {
    expect(parseDictationLine("")).toBeNull();
    expect(parseDictationLine("   ")).toBeNull();
    expect(parseDictationLine("event: partial")).toBeNull();
    expect(parseDictationLine(": keep-alive")).toBeNull();
    expect(parseDictationLine("data: [DONE]")).toBeNull();
    expect(parseDictationLine("plain text")).toBeNull();
  });
  test("ignores malformed JSON and objects without usable text", () => {
    expect(parseDictationLine("{not json")).toBeNull();
    expect(parseDictationLine('{"type":"final"}')).toBeNull();
    expect(parseDictationLine('{"foo":"bar"}')).toBeNull();
  });
});

describe("proxyStreamingDictation", () => {
  const audio = new TextEncoder().encode("audio-bytes").buffer;

  test("fails closed (503) when no backend is configured", async () => {
    setStreamingUrl("");
    const gen = proxyStreamingDictation(audio, { contentType: "audio/webm", final: false });
    await expect(collect(gen)).rejects.toMatchObject({ status: 503 });
  });

  test("relays partials then a final from the upstream", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () =>
      upstreamResponse([
        '{"type":"partial","text":"ice"}\n',
        '{"type":"partial","text":"ice cream"}\n',
        '{"type":"final","text":"ice cream"}\n',
      ])) as unknown as typeof fetch;
    const events = await collect(proxyStreamingDictation(audio, { contentType: "audio/webm", final: true }));
    expect(events).toEqual([
      { type: "partial", text: "ice" },
      { type: "partial", text: "ice cream" },
      { type: "final", text: "ice cream" },
    ]);
  });

  test("buffers lines split across read chunks", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () =>
      upstreamResponse(['{"type":"par', 'tial","text":"split"}\n'])) as unknown as typeof fetch;
    const events = await collect(proxyStreamingDictation(audio, { contentType: "audio/webm", final: false }));
    expect(events).toEqual([{ type: "partial", text: "split" }]);
  });

  test("synthesizes a terminal final on stop when the upstream sent only partials", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () =>
      upstreamResponse(['{"type":"partial","text":"hello there"}'])) as unknown as typeof fetch;
    const events = await collect(proxyStreamingDictation(audio, { contentType: "audio/webm", final: true }));
    expect(events).toEqual([
      { type: "partial", text: "hello there" },
      { type: "final", text: "hello there" },
    ]);
  });

  test("does NOT synthesize a final when not the last segment", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () =>
      upstreamResponse(['{"type":"partial","text":"mid"}'])) as unknown as typeof fetch;
    const events = await collect(proxyStreamingDictation(audio, { contentType: "audio/webm", final: false }));
    expect(events).toEqual([{ type: "partial", text: "mid" }]);
  });

  test("does not double up when the upstream already sent a final on stop", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () =>
      upstreamResponse(['{"type":"final","text":"committed"}'])) as unknown as typeof fetch;
    const events = await collect(proxyStreamingDictation(audio, { contentType: "audio/webm", final: true }));
    expect(events).toEqual([{ type: "final", text: "committed" }]);
  });

  test("a non-2xx upstream degrades to a DictationError(502)", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () => upstreamResponse(["nope"], { status: 500 })) as unknown as typeof fetch;
    await expect(collect(proxyStreamingDictation(audio, { contentType: "audio/webm", final: false }))).rejects.toMatchObject({
      status: 502,
    });
  });

  test("an unreachable upstream degrades to a DictationError(502)", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const err = await collect(proxyStreamingDictation(audio, { contentType: "audio/webm", final: false })).catch((e) => e);
    expect(err).toBeInstanceOf(DictationError);
    expect((err as DictationError).status).toBe(502);
  });
});

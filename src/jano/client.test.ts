import { afterEach, describe, expect, test } from "bun:test";
import { JanoBackend } from "./client.ts";
import type { ChatChunk } from "./types.ts";

// Direct unit tests for the JanoBackend request-building (fetch stubbed). The higher-level
// route tests replace `backend.chat` with a stub, so the actual OpenAI-compatible request body
// this backend emits is exercised here — in particular the #68-follow-up `enable_thinking`
// wiring, which must ride in `chat_template_kwargs` only when the Thinking toggle is on.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// A minimal OpenAI-compatible SSE body: one content delta, then [DONE].
function sseResponse(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// Capture the JSON request body the backend posts, returning a canned SSE stream.
function captureBody(sink: { body?: Record<string, unknown> }): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sink.body = JSON.parse(init.body as string) as Record<string, unknown>;
    return sseResponse();
  }) as unknown as typeof fetch;
}

async function drain(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("JanoBackend.chat — enable_thinking wiring", () => {
  test("carries chat_template_kwargs.enable_thinking when the toggle is on", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    captureBody(sink);
    const chunks = await drain(
      new JanoBackend("http://jano.test").chat({
        model: "qwen",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
      }),
    );
    expect(sink.body?.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(sink.body?.stream).toBe(true);
    // The stream still parses into normalized chunks (a delta then a terminal done).
    expect(chunks.some((c) => c.type === "delta" && c.text === "hi")).toBe(true);
    expect(chunks.at(-1)?.type).toBe("done");
  });

  test("omits chat_template_kwargs when the toggle is off (byte-identical to before)", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    captureBody(sink);
    await drain(
      new JanoBackend("http://jano.test").chat({
        model: "qwen",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(sink.body && "chat_template_kwargs" in sink.body).toBe(false);
  });

  test("a ghost turn (noTrain) still opts into thinking independently", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    captureBody(sink);
    await drain(
      new JanoBackend("http://jano.test").chat({
        model: "qwen",
        messages: [{ role: "user", content: "hi" }],
        noTrain: true,
        enableThinking: true,
      }),
    );
    expect(sink.body?.store).toBe(false);
    expect(sink.body?.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test("serializes a message's multimodal parts as the wire `content` array (#235)", async () => {
    const sink: { body?: Record<string, unknown> } = {};
    captureBody(sink);
    await drain(
      new JanoBackend("http://jano.test").chat({
        model: "qwen-omni",
        messages: [
          { role: "system", content: "sys" },
          {
            role: "user",
            content: "what is this?",
            parts: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }),
    );
    const msgs = sink.body?.messages as { role: string; content: unknown }[];
    // A message without parts stays a plain string; the one with parts ships the content-parts array.
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(msgs[1]!.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});

describe("JanoBackend — listModels + complete", () => {
  test("listModels maps the /v1/models payload to {id,label}", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "qwen", label: "Qwen" }, { id: "bare" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const models = await new JanoBackend("http://jano.test").listModels();
    expect(models).toEqual([{ id: "qwen", label: "Qwen" }, { id: "bare", label: undefined }]);
  });

  test("listModels throws on a non-ok response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(new JanoBackend("http://jano.test").listModels()).rejects.toThrow(/500/);
  });

  test("complete returns the first choice's message content", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const out = await new JanoBackend("http://jano.test").complete({
      model: "qwen",
      messages: [{ role: "user", content: "q" }],
    });
    expect(out).toBe("answer");
  });

  test("complete throws on a non-ok response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    await expect(
      new JanoBackend("http://jano.test").complete({ model: "qwen", messages: [] }),
    ).rejects.toThrow(/502/);
  });
});

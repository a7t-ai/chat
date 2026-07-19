import { describe, expect, test } from "bun:test";
import type { ChatChunk } from "../jano/types.ts";
import { parseChatCompletionStream, ThinkSplitter } from "./stream.ts";

// Build a streaming Response body from raw SSE text (as an OpenAI-compatible server would send it).
function sseResponse(lines: string[], init?: ResponseInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

async function collect(res: Response): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of parseChatCompletionStream(res)) out.push(c);
  return out;
}

const delta = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`;

describe("parseChatCompletionStream", () => {
  test("yields deltas then a usage-carrying done", async () => {
    const chunks = await collect(
      sseResponse([
        delta("Hel"),
        delta("lo"),
        `data: ${JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n`,
      ]),
    );
    expect(chunks).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done", usage: { promptTokens: 5, completionTokens: 2 } },
    ]);
  });

  test("terminates on [DONE] with a bare done", async () => {
    const chunks = await collect(sseResponse([delta("hi"), "data: [DONE]\n"]));
    expect(chunks).toEqual([{ type: "delta", text: "hi" }, { type: "done" }]);
  });

  test("a stream that just ends emits a trailing done", async () => {
    const chunks = await collect(sseResponse([delta("x")]));
    expect(chunks).toEqual([{ type: "delta", text: "x" }, { type: "done" }]);
  });

  test("ignores keepalives, blank data, and malformed json", async () => {
    const chunks = await collect(
      sseResponse([": keepalive\n", "\n", "data: not-json\n", delta("ok"), "data: [DONE]\n"]),
    );
    expect(chunks).toEqual([{ type: "delta", text: "ok" }, { type: "done" }]);
  });

  test("reassembles a delta split across read boundaries", async () => {
    const full = delta("split");
    const chunks = await collect(sseResponse([full.slice(0, 10), full.slice(10), "data: [DONE]\n"]));
    expect(chunks).toEqual([{ type: "delta", text: "split" }, { type: "done" }]);
  });

  test("throws with the label + status on a non-ok response", async () => {
    const res = new Response("upstream boom", { status: 429 });
    await expect(collect2(res, "openai chat")).rejects.toThrow("openai chat -> 429");
  });

  // --- Reasoning / thinking (#68) ---

  test("splits inline <think>…</think> into reasoning then answer", async () => {
    const chunks = await collect(
      sseResponse([delta("<think>weigh options</think>"), delta("the answer"), "data: [DONE]\n"]),
    );
    expect(chunks).toEqual([
      { type: "reasoning", text: "weigh options" },
      { type: "delta", text: "the answer" },
      { type: "done" },
    ]);
  });

  test("reassembles a <think> tag split across deltas", async () => {
    // The opening tag, the closing tag, AND the answer arrive in awkward slices.
    const chunks = await collect(
      sseResponse([delta("<th"), delta("ink>mull</thi"), delta("nk>done"), "data: [DONE]\n"]),
    );
    expect(chunks).toEqual([
      { type: "reasoning", text: "mull" },
      { type: "delta", text: "done" },
      { type: "done" },
    ]);
  });

  test("forwards a separate reasoning_content channel as reasoning", async () => {
    const reason = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: t } }] })}\n`;
    const chunks = await collect(sseResponse([reason("hmm"), delta("final"), "data: [DONE]\n"]));
    expect(chunks).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "delta", text: "final" },
      { type: "done" },
    ]);
  });

  test("flushes an unclosed <think> as reasoning when the stream ends", async () => {
    // A Stop mid-thought: no closing tag, no [DONE] — the trailing end still emits the reasoning.
    const chunks = await collect(sseResponse([delta("<think>still going")]));
    expect(chunks).toEqual([{ type: "reasoning", text: "still going" }, { type: "done" }]);
  });

  test("a plain answer never becomes reasoning", async () => {
    const chunks = await collect(sseResponse([delta("just text"), "data: [DONE]\n"]));
    expect(chunks).toEqual([{ type: "delta", text: "just text" }, { type: "done" }]);
  });
});

describe("ThinkSplitter", () => {
  const drain = (pieces: string[]): ChatChunk[] => {
    const s = new ThinkSplitter();
    const out: ChatChunk[] = [];
    for (const p of pieces) out.push(...s.push(p));
    out.push(...s.flush());
    return out;
  };

  test("classifies think vs answer across chunk boundaries", () => {
    // Each push drains what it can, so the mid-tag reasoning arrives as two chunks (b, then c) —
    // the client concatenates them; the classification (reasoning vs answer) is what matters.
    expect(drain(["a<think>b", "c</think>d"])).toEqual([
      { type: "delta", text: "a" },
      { type: "reasoning", text: "b" },
      { type: "reasoning", text: "c" },
      { type: "delta", text: "d" },
    ]);
  });

  test("holds back a partial tag until it resolves as literal text", () => {
    // A trailing "<" could start "<think>", so it's held back and flushed as a separate delta — but
    // it's never swallowed: the answer text is preserved verbatim when reassembled.
    const out = drain(["answer <"]);
    expect(out.every((c) => c.type === "delta")).toBe(true);
    expect(out.map((c) => (c.type === "delta" ? c.text : "")).join("")).toBe("answer <");
  });

  test("emits nothing for empty input", () => {
    expect(drain([""])).toEqual([]);
  });
});

async function collect2(res: Response, label: string): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of parseChatCompletionStream(res, label)) out.push(c);
  return out;
}

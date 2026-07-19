import type { ChatChunk } from "../jano/types.ts";

// The <think>…</think> delimiters a local reasoning model (Qwen, DeepSeek-R1 distills, …) wraps its
// chain-of-thought in inside the normal `content` channel. We peel that out into `reasoning` chunks
// so the visible answer stays clean.
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// How many trailing chars of `buf` are a proper prefix of `tag` — the amount we must hold back
// because they might be the beginning of a `tag` still arriving in the next delta (a tag can be
// split across SSE read boundaries). 0 when no suffix matches.
function partialTailLen(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (buf.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

// Streaming splitter that separates inline <think>…</think> reasoning from the visible answer in a
// model's `content` channel. Fed one content delta at a time, it emits `reasoning` chunks for text
// inside the tags and `delta` chunks for the answer, tolerant of tags split across delta boundaries
// (it holds back a short tail that could be a partial tag). `flush()` drains the remainder at
// end-of-stream — an unclosed <think> (e.g. a Stop mid-thought) flushes as reasoning. Exported so
// the peeling logic is unit-tested directly.
export class ThinkSplitter {
  private buf = "";
  private inThink = false;

  push(text: string): ChatChunk[] {
    this.buf += text;
    return this.drain(false);
  }

  flush(): ChatChunk[] {
    return this.drain(true);
  }

  private drain(end: boolean): ChatChunk[] {
    const out: ChatChunk[] = [];
    while (this.buf.length > 0) {
      const tag = this.inThink ? THINK_CLOSE : THINK_OPEN;
      const kind: ChatChunk["type"] = this.inThink ? "reasoning" : "delta";
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        const before = this.buf.slice(0, i);
        if (before) out.push({ type: kind, text: before });
        this.buf = this.buf.slice(i + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // No full tag yet: emit everything except a possible partial-tag tail (unless the stream ended,
      // in which case the tail can't be a real tag — flush it verbatim in the current mode).
      const hold = end ? 0 : partialTailLen(this.buf, tag);
      const safe = this.buf.length - hold;
      if (safe > 0) {
        out.push({ type: kind, text: this.buf.slice(0, safe) });
        this.buf = this.buf.slice(safe);
      }
      break;
    }
    return out;
  }
}

// The OpenAI-compatible streaming-chat parser, shared by every backend that speaks the
// `/v1/chat/completions` SSE wire format — the local Jano router (src/jano/client.ts) and a
// user's BYOK frontier provider (src/byok/backend.ts). Single-sourcing it keeps the proven
// parser in one place (and unit-tested once) instead of duplicated per backend.
//
// It turns an OpenAI-compatible streaming Response into normalized `ChatChunk`s: a `delta` per
// answer token, a `reasoning` chunk per thinking token (from a `reasoning_content`/`reasoning`
// channel or inline <think>…</think>, #68), then a terminal `done` carrying usage when the server
// includes it (or a bare `done` on `[DONE]` / end of stream). `label` only shapes the thrown error
// message; it never carries a secret (the caller's API key lives in the request headers, never here).
export async function* parseChatCompletionStream(res: Response, label = "chat"): AsyncIterable<ChatChunk> {
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${label} -> ${res.status}: ${detail.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const splitter = new ThinkSplitter();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // keep the partial line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          yield* splitter.flush(); // drain any held-back answer/reasoning tail before ending
          yield { type: "done" };
          return;
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          // A separate reasoning channel (`reasoning_content` — DeepSeek/vLLM; `reasoning` —
          // OpenRouter) carries the model's thinking already split from the answer: forward it
          // verbatim as a reasoning chunk (no <think> peeling needed).
          const reason = json.choices?.[0]?.delta?.reasoning_content ?? json.choices?.[0]?.delta?.reasoning;
          if (typeof reason === "string" && reason.length > 0) {
            yield { type: "reasoning", text: reason };
          }
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            // Peel any inline <think>…</think> reasoning out of the answer channel (#68).
            yield* splitter.push(delta);
          }
          if (json.usage) {
            yield* splitter.flush();
            yield {
              type: "done",
              usage: {
                promptTokens: json.usage.prompt_tokens,
                completionTokens: json.usage.completion_tokens,
              },
            };
            return;
          }
        } catch {
          // ignore keepalives / malformed lines
        }
      }
    }
    yield* splitter.flush();
    yield { type: "done" };
  } finally {
    // Caller broke out early (Stop) or we're done: drop the upstream connection instead of
    // leaking it.
    void reader.cancel().catch(() => {});
  }
}

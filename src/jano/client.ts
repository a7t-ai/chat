import { config } from "../config.ts";
import { parseChatCompletionStream } from "../llm/stream.ts";
import type { ChatChunk, ChatRequest, LLMBackend, ModelInfo } from "./types.ts";

// Client for the EXISTING host Jano router (OpenAI-compatible). There is no second
// Jano: this only calls it. Routing through Jano lets chat share the coder/chat swap
// coordination with a companion service and future capabilities instead of thrashing the models.
export class JanoBackend implements LLMBackend {
  constructor(private readonly baseUrl: string = config.janoUrl) {}

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`);
    if (!res.ok) throw new Error(`jano /v1/models -> ${res.status}`);
    const data = (await res.json()) as { data?: { id: string; label?: string }[] };
    return (data.data ?? []).map((m) => ({ id: m.id, label: m.label }));
  }

  async complete(req: ChatRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0.7,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`jano complete -> ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    // A temporary (ghost) chat must not be retained or used for training. We signal that
    // both in-band (`store: false`, honored by OpenAI-compatible servers) and via a
    // header for Jano, so whichever the router understands takes effect.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (req.noTrain) headers["x-no-train"] = "1";
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
        ...(req.noTrain ? { store: false } : {}),
        // Composer "Thinking" toggle (#68 follow-up): reasoning models (Qwen3, …) read
        // `enable_thinking` from `chat_template_kwargs` on an OpenAI-compatible /v1/chat/completions
        // request — the router (Jano/vLLM) forwards it into the chat template so the model reasons.
        // Sent only when the toggle is ON; omitted otherwise so untouched turns are byte-identical to
        // before, and a model/router that doesn't understand the key simply ignores it.
        ...(req.enableThinking ? { chat_template_kwargs: { enable_thinking: true } } : {}),
      }),
      signal: req.signal,
    });
    // Parsing the OpenAI-compatible SSE stream is shared with the BYOK frontier backend.
    yield* parseChatCompletionStream(res, "jano chat");
  }
}

export const backend: LLMBackend = new JanoBackend();

// Jano's /health exposes router telemetry (current model, queue depth, swaps, tok/s,
// backend health). Fetched ON-DEMAND by the admin panel — never on a timer, to avoid
// pinning a model / fighting the coder<->chat swap.
export async function janoStats(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${config.janoUrl}/health`);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

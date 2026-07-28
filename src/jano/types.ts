// OpenAI-compatible shapes + the backend interface. This interface is the swap seam:
// JanoBackend today; a bundled jano or a hosted API later (product path).

// A single piece of multimodal message content (OpenAI vision format). Text stays the plain-string
// path; an image rides as a `data:`-URL `image_url` part (#235). Audio/video parts are a later step
// (their wire shape is endpoint-specific), so only these two are modeled today.
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  // The text-only content. Always populated — it is what persistence, history, memory, summaries,
  // and token counting read, and the fallback the wire request sends when `parts` is unset.
  content: string;
  // Multimodal delivery (#235): when set, the wire request sends THIS as the message `content`
  // (an OpenAI content-parts array) instead of the plain `content` string. Kept optional and
  // apart from `content` so every non-multimodal path is untouched — only src/jano/client.ts reads it.
  parts?: ContentPart[];
}

export interface ModelInfo {
  id: string;
  label?: string; // friendly display name from Jano (falls back to id)
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  // Aborts the upstream generation when the caller disconnects (e.g. the user
  // hit Stop). Streaming only; ignored by `complete`.
  signal?: AbortSignal;
  // Temporary (ghost) chats set this so the request carries a do-not-train / do-not-store
  // marker to the router. Streaming only.
  noTrain?: boolean;
  // Composer "Thinking" toggle (#68 follow-up): when set, request reasoning from the model via
  // `enable_thinking`. Reasoning-capable models (Qwen3, …) often default thinking OFF, so this is
  // what turns it ON for a turn. Carried to the OpenAI-compatible router in `chat_template_kwargs`
  // (see src/jano/client.ts). Off/unset ⇒ today's behavior (the model reasons only if it does so
  // by default). Graceful: a model that ignores the param just answers normally.
  enableThinking?: boolean;
}

// Normalized streaming chunk — decouples callers from the wire format. `reasoning` carries a
// model's chain-of-thought / thinking (a separate `reasoning_content` channel, or the text a local
// model wraps in <think>…</think>), split out of the visible answer so the UI can show it in a
// collapsed "Reasoning" section without polluting `delta` (the final answer). See src/llm/stream.ts.
export type ChatChunk =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "done"; usage?: TokenUsage };

export interface LLMBackend {
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  // Non-streaming completion — for internal tasks (memory extraction, summaries).
  complete(req: ChatRequest): Promise<string>;
}

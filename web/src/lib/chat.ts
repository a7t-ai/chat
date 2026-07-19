import { authHeaders, type ContextUsage, type Source } from "./api";
import type { ErrorInfo } from "./errors";

// Unified send for POST /api/chat.
//   - `/model` commands return JSON (CommandResult) — no stream.
//   - a normal turn streams the meta/delta/done/error SSE protocol via callbacks.
// Returns the CommandResult when the response was JSON, otherwise null (it streamed).

// A regenerated answer's slot, returned on `done` from the regenerate endpoint.
export interface DoneVariant {
  id: string;
  content: string;
  vote: number;
  // The variant's model thinking (#68), so flipping variants shows each one's own reasoning.
  reasoning?: string | null;
}

// Web-search ("Research") progress streamed during the search phase of a turn.
export type SearchStage =
  | { stage: "searching"; queries: string[] }
  | { stage: "reading"; count: number }
  | { stage: "error"; message: string };

export interface ChatEvents {
  // `conversationId` is null for a temporary (ghost) chat, which has no persisted row.
  onMeta?: (m: { conversationId: string | null; model: string; temporary?: boolean }) => void;
  // Queue position while waiting for a generation slot: n>=1 = waiting, 0 = now generating.
  onQueue?: (position: number) => void;
  // Web-search progress, then the resolved sources, before/while the answer streams.
  onSearch?: (stage: SearchStage) => void;
  onSources?: (sources: Source[]) => void;
  // The model's thinking (#68), streamed apart from the answer (and replayed on reconnect) so the
  // UI grows a collapsed "Reasoning" section without the chain-of-thought leaking into onDelta.
  onReasoning?: (text: string) => void;
  onDelta?: (text: string) => void;
  onDone?: (d: {
    conversationId: string;
    model: string;
    messageId?: string;
    usage: unknown;
    variants?: DoneVariant[];
    activeIndex?: number;
    // Context-window usage after the turn (#38) — updates the composer meter/nudge without a refetch.
    context?: ContextUsage;
  }) => void;
  // A classified failure (status / server message / network / mid-stream kind). The UI
  // maps it to in-voice copy via errorKey() rather than showing a raw string. See errors.ts.
  onError?: (info: ErrorInfo) => void;
  // Fired INSTEAD of onError when the conversation isn't visible to this caller — a
  // transport 404 (deleted, or another user's id) or the SSE `error` frame "conversation
  // not found" (deleted mid-turn). The caller redirects home rather than appending a
  // stuck "⚠️ conversation not found" note onto a dead thread.
  onNotFound?: () => void;
}

// The exact SSE error message the server sends when a turn's conversation has vanished
// for this caller — routed to onNotFound (redirect home) instead of onError (inline note).
const NOT_FOUND_MESSAGE = "conversation not found";

export type CommandResult =
  | { type: "command"; command: "model.list"; models: string[]; current: string }
  | { type: "command"; command: "model.set"; model: string }
  | { error: string; message?: string };

export async function sendChat(
  // A temporary (ghost) chat sets `temporary` and carries its prior turns in `history`,
  // since the server persists nothing and so keeps no transcript of its own.
  body: {
    conversationId?: string;
    content: string;
    model?: string;
    temporary?: boolean;
    // Web search ("Research"): run a web-search + inject the results before generating.
    search?: boolean;
    // Composer "Thinking" toggle (#68 follow-up): opt in to `enable_thinking` so the model reasons.
    thinking?: boolean;
    history?: { role: "user" | "assistant"; content: string }[];
    // files-to-prompt (#128): ids of the caller's uploaded files to deliver into this turn.
    fileIds?: string[];
  },
  events: ChatEvents,
  signal?: AbortSignal,
): Promise<CommandResult | null> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await res.json()) as CommandResult;
    // A JSON body on a FAILED response is an error envelope (`{error}`), not a command
    // result — classify it by status + server message instead of returning it as a
    // CommandResult the caller would render verbatim. A 404 still routes home.
    if (!res.ok) {
      const serverMessage = body && typeof body === "object" && "error" in body ? body.error : undefined;
      if (res.status === 404) events.onNotFound?.();
      else events.onError?.({ status: res.status, serverMessage });
      return null;
    }
    return body;
  }
  if (!res.ok || !res.body) {
    // A 404 means the target conversation isn't this caller's — redirect home, don't
    // strand them with an inline error on a thread they can't see.
    if (res.status === 404) events.onNotFound?.();
    else events.onError?.({ status: res.status });
    return null;
  }

  await consumeSSE(res, events);
  return null;
}

// Regenerate an assistant answer in place (no new user message). Streams the fresh
// reply via the same meta/delta/done/error protocol; `done` also carries the slot's
// variants + active index so the caller can wire up the comparison navigator.
export async function regenerateChat(
  messageId: string,
  events: ChatEvents,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/messages/${messageId}/regenerate`, {
    method: "POST",
    headers: authHeaders(),
    signal,
  });
  if (!res.ok || !res.body) {
    // The conversation owning this message isn't visible to the caller — go home.
    if (res.status === 404) {
      events.onNotFound?.();
      return;
    }
    let serverMessage: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) serverMessage = j.error;
    } catch {
      /* non-JSON body */
    }
    events.onError?.({ status: res.status, serverMessage });
    return;
  }
  await consumeSSE(res, events);
}

// Reattach to a turn already generating for `conversationId` (e.g. after a page
// refresh). Streams the same meta/delta/done/error protocol as a fresh turn, replaying
// whatever has been produced so far. Resolves to false when nothing was streaming
// (HTTP 204) so the caller can reconcile from the persisted thread instead.
export async function attachChat(
  conversationId: string,
  events: ChatEvents,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await fetch(`/api/conversations/${conversationId}/stream`, {
    headers: authHeaders(),
    signal,
  });
  if (res.status === 204) return false;
  if (!res.ok || !res.body) {
    // The conversation is gone for this caller (e.g. deleted before we reattached) — home.
    if (res.status === 404) events.onNotFound?.();
    else events.onError?.({ status: res.status });
    return false;
  }
  await consumeSSE(res, events);
  return true;
}

// Parse the SSE stream (meta/delta/done/error frames) and dispatch to callbacks. Exported so
// the public share watch path (lib/share.ts) reuses the exact same frame protocol.
export async function consumeSSE(res: Response, events: ChatEvents): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? ""; // keep partial frame
    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === "meta") events.onMeta?.(parsed);
      else if (event === "queue") events.onQueue?.(parsed.position);
      else if (event === "search") events.onSearch?.(parsed);
      else if (event === "sources") events.onSources?.(parsed.sources);
      else if (event === "reasoning") events.onReasoning?.(parsed.text);
      else if (event === "delta") events.onDelta?.(parsed.text);
      else if (event === "done") events.onDone?.(parsed);
      else if (event === "error") {
        // A turn whose conversation vanished mid-stream reports "conversation not found":
        // route it to onNotFound (redirect home) instead of appending an inline ⚠️ note.
        if (parsed.message === NOT_FOUND_MESSAGE) events.onNotFound?.();
        else events.onError?.({ kind: "stream", serverMessage: parsed.message });
      }
    }
  }
}

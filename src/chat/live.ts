import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SearchStage, Source } from "../search/index.ts";
import type { ContextUsage } from "./compaction.ts";

// In-flight generation registry. A turn is decoupled from the HTTP request that
// started it so a client refresh (disconnect) doesn't kill it — the turn keeps
// running server-side, and the same request (or a later reconnect via
// GET /conversations/:id/stream) simply subscribes to it. The accumulated `text`
// lets a reconnecting client replay everything produced so far before resuming the
// live token stream. Explicit Stop (POST /conversations/:id/stop) aborts `controller`.

// Terminal payload for the `done` SSE frame — mirrors what the chat route emits so the
// existing client SSE parser handles a reattached stream unchanged.
export interface DonePayload {
  conversationId: string;
  model: string;
  messageId?: string;
  usage?: { promptTokens: number | null; completionTokens: number | null };
  // Context-window usage snapshot AFTER this turn (#38) — drives the composer's context meter +
  // the near-limit "Compact" nudge without a follow-up fetch. Absent for a ghost chat (nothing
  // persisted to meter).
  context?: ContextUsage;
}

type LiveEvent =
  | { type: "queue"; position: number }
  | { type: "search"; stage: SearchStage }
  | { type: "sources"; sources: Source[] }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; payload: DonePayload }
  | { type: "error"; message: string }
  | { type: "aborted" };

type Listener = (ev: LiveEvent) => void;

export interface LiveGen {
  readonly conversationId: string;
  readonly userId: string;
  readonly model: string;
  text: string;
  // The model's thinking (#68), accumulated separately from `text` so a reconnecting client can
  // replay it into the collapsible "Reasoning" section without it bleeding into the answer.
  reasoning: string;
  status: "running" | "done" | "error" | "aborted";
  // Live queue position: >=1 while waiting, 0 once generating. Buffered so a reconnecting
  // client sees the current position before any tokens arrive.
  queuePosition: number;
  // Web-search ("Research") state for this turn, buffered so a client reconnecting after
  // the search phase still replays the latest progress + the resolved sources.
  searchStage: SearchStage | null;
  sources: Source[];
  // Aborted by an explicit Stop, never by a client disconnect.
  readonly controller: AbortController;
  readonly listeners: Set<Listener>;
  donePayload: DonePayload | null;
  errorMessage: string | null;
  pushQueue(position: number): void;
  pushSearch(stage: SearchStage): void;
  pushSources(sources: Source[]): void;
  pushReasoning(text: string): void;
  pushDelta(text: string): void;
  finish(payload: DonePayload): void;
  fail(message: string): void;
  markAborted(): void;
}

const generations = new Map<string, LiveGen>();

// Keep a finished generation around briefly so a client reconnecting right at the
// finish line still receives the terminal frame; after this the answer is persisted
// and a normal thread refetch reflects it.
const GRACE_MS = 10_000;

function scheduleCleanup(gen: LiveGen): void {
  setTimeout(() => {
    if (generations.get(gen.conversationId) === gen) generations.delete(gen.conversationId);
  }, GRACE_MS);
}

function emit(gen: LiveGen, ev: LiveEvent): void {
  for (const l of gen.listeners) l(ev);
}

export function beginLive(conversationId: string, userId: string, model: string): LiveGen {
  const gen: LiveGen = {
    conversationId,
    userId,
    model,
    text: "",
    reasoning: "",
    status: "running",
    queuePosition: 0,
    searchStage: null,
    sources: [],
    controller: new AbortController(),
    listeners: new Set(),
    donePayload: null,
    errorMessage: null,
    pushQueue(position) {
      this.queuePosition = position;
      emit(this, { type: "queue", position });
    },
    pushSearch(stage) {
      this.searchStage = stage;
      emit(this, { type: "search", stage });
    },
    pushSources(sources) {
      this.sources = sources;
      emit(this, { type: "sources", sources });
    },
    pushReasoning(text) {
      this.queuePosition = 0;
      this.reasoning += text;
      emit(this, { type: "reasoning", text });
    },
    pushDelta(text) {
      this.queuePosition = 0;
      this.text += text;
      emit(this, { type: "delta", text });
    },
    finish(payload) {
      this.status = "done";
      this.donePayload = payload;
      emit(this, { type: "done", payload });
      scheduleCleanup(this);
    },
    fail(message) {
      this.status = "error";
      this.errorMessage = message;
      emit(this, { type: "error", message });
      scheduleCleanup(this);
    },
    markAborted() {
      this.status = "aborted";
      emit(this, { type: "aborted" });
      scheduleCleanup(this);
    },
  };
  generations.set(conversationId, gen);
  return gen;
}

export function getLive(conversationId: string): LiveGen | undefined {
  return generations.get(conversationId);
}

// Conversation ids with a turn actively generating right now, for this user — drives
// the sidebar "crunching" indicator and the thinking verb on reload.
export function liveIdsFor(userId: string): Set<string> {
  const ids = new Set<string>();
  for (const gen of generations.values()) {
    if (gen.userId === userId && gen.status === "running") ids.add(gen.conversationId);
  }
  return ids;
}

// Stop the live turn for a conversation (the Stop button). Returns whether anything was
// actually aborted.
export function stopLive(conversationId: string, userId: string): boolean {
  const gen = generations.get(conversationId);
  if (!gen || gen.userId !== userId || gen.status !== "running") return false;
  gen.controller.abort();
  return true;
}

function terminalEvent(gen: LiveGen): LiveEvent {
  if (gen.status === "done" && gen.donePayload) return { type: "done", payload: gen.donePayload };
  if (gen.status === "error") return { type: "error", message: gen.errorMessage ?? "generation failed" };
  return { type: "aborted" };
}

// Stream a live generation to the caller over SSE. Replays the buffered text first, then
// forwards live deltas until the turn finishes. If THIS client disconnects the stream
// just ends — the generation keeps running for any other (or future) subscriber.
export function streamLive(c: Context, gen: LiveGen) {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "meta",
      data: JSON.stringify({ conversationId: gen.conversationId, model: gen.model }),
    });

    const queue: LiveEvent[] = [];
    let wake: (() => void) | null = null;
    const wakeUp = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const listener: Listener = (ev) => {
      queue.push(ev);
      wakeUp();
    };

    // Snapshot the buffered text and subscribe atomically (no await between → the runner,
    // which only advances on its own awaits, can't slip a delta past us or duplicate one).
    // Replay any web-search progress + resolved sources first so a client reconnecting
    // after the search phase still shows the "Searching…" status and the source list.
    if (gen.searchStage) queue.push({ type: "search", stage: gen.searchStage });
    if (gen.sources.length > 0) queue.push({ type: "sources", sources: gen.sources });
    // Replay the accumulated reasoning (#68) before the answer text so a client reconnecting
    // mid-turn rebuilds the collapsed "Reasoning" section, then the answer, in order.
    if (gen.reasoning) queue.push({ type: "reasoning", text: gen.reasoning });
    // A turn still waiting in the queue (no tokens yet) replays its current position so a
    // reconnecting client shows "queued #n" rather than a bare thinking indicator.
    if (gen.text) queue.push({ type: "delta", text: gen.text });
    else if (gen.status === "running" && gen.queuePosition > 0) queue.push({ type: "queue", position: gen.queuePosition });
    if (gen.status === "running") gen.listeners.add(listener);
    else queue.push(terminalEvent(gen));

    const clientGone = c.req.raw.signal;
    clientGone.addEventListener("abort", wakeUp);

    let finished = false;
    try {
      while (!finished) {
        while (queue.length > 0 && !finished) {
          const ev = queue.shift()!;
          if (ev.type === "queue") {
            await stream.writeSSE({ event: "queue", data: JSON.stringify({ position: ev.position }) });
          } else if (ev.type === "search") {
            await stream.writeSSE({ event: "search", data: JSON.stringify(ev.stage) });
          } else if (ev.type === "sources") {
            await stream.writeSSE({ event: "sources", data: JSON.stringify({ sources: ev.sources }) });
          } else if (ev.type === "reasoning") {
            await stream.writeSSE({ event: "reasoning", data: JSON.stringify({ text: ev.text }) });
          } else if (ev.type === "delta") {
            await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: ev.text }) });
          } else if (ev.type === "done") {
            await stream.writeSSE({ event: "done", data: JSON.stringify(ev.payload) });
            finished = true;
          } else if (ev.type === "error") {
            await stream.writeSSE({ event: "error", data: JSON.stringify({ message: ev.message }) });
            finished = true;
          } else {
            finished = true; // aborted: end the stream with no terminal frame
          }
        }
        if (finished || clientGone.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          // Guard the lost-wakeup gap: anything queued (or a disconnect) between the
          // drain above and here resolves immediately rather than blocking forever.
          if (queue.length > 0 || clientGone.aborted) {
            wake = null;
            resolve();
          }
        });
        wake = null;
      }
    } finally {
      gen.listeners.delete(listener);
      clientGone.removeEventListener("abort", wakeUp);
    }
  });
}

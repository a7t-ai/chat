import { authHeaders } from "./api";

// Live dictation / streaming STT client (#71) — the "text streams into the composer AS YOU
// SPEAK" path. It runs ALONGSIDE the batch Whisper mic (lib/api `transcribe`), never replacing
// it: when streaming is unavailable (server dark), unsupported (no MediaRecorder), or it errors,
// the composer falls back to the batch mic transparently.
//
// The tricky bit — reconciling interim/final transcripts into the composer value — is the PURE
// core below (initTranscript / applyDictationEvent / commitInterim / renderTranscript),
// exhaustively tested without a mic or DOM. The transport (`streamDictation`) is the thin impure
// shell around MediaRecorder + the `/api/dictate` SSE stream.

export type DictationEventType = "partial" | "final";
export interface DictationEvent {
  type: DictationEventType;
  text: string;
}

// The reconciler state.
//   - `base`:      the composer text that existed BEFORE dictation started. Dictation APPENDS to
//                  it, never clobbers it, so a user can type then dictate (or vice versa).
//   - `committed`: the stable transcript. Because every ~1s POST re-transcribes the FULL
//                  cumulative audio, only the TERMINAL `?final=1` segment's `final` commits (#218)
//                  — one fold of the whole transcript — so a mid-stream final can't double-commit.
//   - `interim`:   the latest POST's text (a `partial` OR a non-terminal `final`) — the best
//                  current full transcript, replaced wholesale by each new event (free
//                  mid-utterance corrections), committed once by the terminal segment.
export interface TranscriptState {
  base: string;
  committed: string;
  interim: string;
}

export function initTranscript(base: string): TranscriptState {
  return { base, committed: "", interim: "" };
}

// Fold one event into the state, threading the transport's terminal-segment flag (#218). Every
// ~1s POST re-transcribes the FULL cumulative audio, so the latest POST's text — a `partial` OR a
// `final` — is the best current full transcript and always REPLACES `interim`. Only the TERMINAL
// segment (the single `?final=1` POST sent on stop) may COMMIT, and only on its `final`: that one
// commit folds the whole transcript into `committed`. A `final` from a NON-terminal POST is
// therefore treated as partial-only (interim, never appended), so an upstream that emits
// incremental finals mid-request can never double-commit — "hello" then cumulative "hello there"
// yields "hello there", not "hello hello there". `terminal` defaults true so a direct caller keeps
// the simple "a final commits" semantics; the streaming transport always threads the real
// per-segment flag.
export function applyDictationEvent(
  state: TranscriptState,
  ev: DictationEvent,
  terminal = true,
): TranscriptState {
  if (terminal && ev.type === "final") {
    return { ...state, committed: joinWords(state.committed, ev.text), interim: "" };
  }
  return { ...state, interim: ev.text };
}

// Fold a trailing interim into committed — used on stop when the stream ended on a `partial` (no
// terminal `final`), so the last spoken words aren't dropped.
export function commitInterim(state: TranscriptState): TranscriptState {
  if (!state.interim) return state;
  return { ...state, committed: joinWords(state.committed, state.interim), interim: "" };
}

// The composer value for a state: the pre-existing text plus the live transcript so far.
export function renderTranscript(state: TranscriptState): string {
  const spoken = joinWords(state.committed, state.interim);
  if (!spoken) return state.base;
  return state.base ? `${state.base.trimEnd()} ${spoken}` : spoken;
}

// Join two transcript fragments with exactly one space, tolerating empties + inconsistent
// surrounding whitespace (streaming ASR chunks arrive spaced unpredictably), so neither the live
// interim nor the committed transcript carries stray leading/trailing spaces.
function joinWords(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

// ---- Transport (impure) ----------------------------------------------------------------------

// Whether the browser can capture mic audio for the live path. When false the composer uses the
// batch mic instead. Never auto-runs — only consulted on the user's gesture.
export function dictationSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

export interface DictationSession {
  stop: () => void;
}

export interface DictationHandlers {
  // `terminal` marks an event from the TERMINAL `?final=1` POST (#218) — the only segment whose
  // `final` may commit. Threaded straight into the pure reconciler (`applyDictationEvent`).
  onEvent: (ev: DictationEvent, terminal: boolean) => void;
  onError: (err: unknown) => void;
  onStart?: () => void;
  onStop?: () => void; // fires when the mic has fully stopped and the final segment is done
}

// Start live dictation: open the mic, record in ~1s slices, and POST the CUMULATIVE audio buffer
// to `/api/dictate` on each slice, streaming the server's partial/final SSE events to `onEvent`.
// Returns a session whose `stop()` ends the mic and flushes a final segment. Rejecting (mic
// denied) or `onError` (streaming errored) lets the composer fall back to the batch mic. Never
// auto-starts — only called on the user's gesture.
export async function streamDictation(handlers: DictationHandlers): Promise<DictationSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    let inFlight = false;
    let stopped = false;
    handlers.onStart?.();

    // Post-stop event race guard (#218). On stop() the terminal `?final=1` flush runs while an
    // interim flush(false) may still be in flight; that interim POST can resolve AFTER `onStop`
    // has torn the transcript down. Once stopped, only the terminal segment may still deliver — a
    // late interim event is stale (the terminal POST re-transcribes everything anyway) and must
    // never mutate the torn-down transcript, so we drop it here (no-op).
    const emit = (ev: DictationEvent, terminal: boolean): void => {
      if (stopped && !terminal) return;
      handlers.onEvent(ev, terminal);
    };

    async function flush(final: boolean): Promise<void> {
      // Serialize: skip a mid-flight interim flush (the next slice catches up); always run final.
      if (inFlight && !final) return;
      inFlight = true;
      try {
        // Cumulative re-upload (#218), a deliberate trade-off: each slice re-sends the WHOLE
        // session audio so far — not just the newest ~1s — to an independent, stateless
        // /api/dictate request that re-transcribes the full buffer. Dead-simple and
        // backend-agnostic (any one-shot ASR works, no server-side session state) at the cost of
        // O(n^2) bandwidth over a session. Bounded by the global 30MB request-body limit
        // (src/server.ts): a very long session eventually 413s, which surfaces via onError and
        // the composer falls back cleanly to the batch mic.
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (blob.size > 0) await postSegment(blob, final, emit);
      } catch (e) {
        handlers.onError(e);
      } finally {
        inFlight = false;
      }
    }

    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
      if (!stopped) void flush(false);
    };
    rec.onstop = () => {
      for (const t of stream.getTracks()) t.stop();
      void flush(true).then(() => handlers.onStop?.());
    };
    rec.start(1000); // 1s slices → ~1 partial/second streamed into the composer

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        rec.stop();
      },
    };
  } catch (e) {
    // MediaRecorder construction/start failed after the mic opened — release it and rethrow so
    // the caller can fall back to batch.
    for (const t of stream.getTracks()) t.stop();
    throw e;
  }
}

async function postSegment(
  blob: Blob,
  final: boolean,
  emit: (ev: DictationEvent, terminal: boolean) => void,
): Promise<void> {
  const res = await fetch(`/api/dictate${final ? "?final=1" : ""}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": blob.type || "audio/webm" },
    body: blob,
  });
  if (!res.ok || !res.body) throw new Error(`dictate -> ${res.status}`);
  // Tag every frame from this POST with whether it's the terminal (`?final=1`) segment, so the
  // reconciler commits ONLY on the terminal segment's final (#218).
  await readDictationSSE(res.body, (ev) => emit(ev, final));
}

// Read a `/api/dictate` SSE stream, invoking `onEvent` for each partial/final frame. Throws on an
// `error` frame so the caller reports it (and the composer falls back to batch). Exported so the
// stream parsing is directly testable without a mic.
export async function readDictationSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: DictationEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const block of blocks) handleBlock(block, onEvent);
  }
  if (buf.trim()) handleBlock(buf, onEvent);
}

function handleBlock(block: string, onEvent: (ev: DictationEvent) => void): void {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  if (event === "error") {
    let message = "dictation error";
    try {
      message = (JSON.parse(data) as { message?: string }).message ?? message;
    } catch {
      /* keep the generic message */
    }
    throw new Error(message);
  }
  if (event === "partial" || event === "final") {
    try {
      const { text } = JSON.parse(data) as { text?: string };
      if (typeof text === "string") onEvent({ type: event, text });
    } catch {
      /* ignore a malformed data frame */
    }
  }
}

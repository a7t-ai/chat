// Live dictation / streaming STT contract (#71).
//
// The app speaks a small, backend-agnostic contract so ANY streaming ASR — NVIDIA
// Nemotron-3.5-ASR (the candidate under separate validation) or a thin Whisper-streaming
// shim — can sit behind the operator-configured `STREAMING_STT_URL` without a single route
// change. This is the STREAMING sibling of the batch Whisper `/transcribe` route: it runs
// alongside it, never replacing it.
//
// A dictation stream is a sequence of these events:
//   - `partial`: the current, still-changing interim tail (since the last `final`). A newer
//     `partial` REPLACES the previous one, so mid-utterance corrections ("I scream" ->
//     "ice cream") are free.
//   - `final`:   a stable chunk that COMMITS — it is appended to the transcript and the
//     interim tail resets. A stream may end on a `final` (already committed) or on a trailing
//     `partial` (the client commits it on stop).
//
// The upstream may emit these as SSE (`data: {json}`) or as newline-delimited JSON; the proxy
// normalizes both (see `parseDictationLine` in service.ts), so a batch-style one-shot upstream
// that returns a single `{text}` works too (treated as a partial, committed on stop).
//
// Streaming transport contract (#71, #218) — the terminal-commit invariant. The web client POSTs
// the CUMULATIVE session audio to /api/dictate once per ~1s slice, and each POST independently
// re-transcribes the FULL buffer. Intermediate POSTs (no `?final`) are treated as PARTIAL-ONLY on
// the client: their events — even a `final` — update the live interim transcript but NEVER commit.
// Only the TERMINAL segment, the single POST sent with `?final=1` on stop, may COMMIT the
// transcript. So an upstream that emits incremental `final`s mid-request is handled safely: it can
// never double-commit (e.g. "hello" mid-stream then cumulative "hello there" yields "hello there",
// not "hello hello there"). See `applyDictationEvent` in web/src/lib/dictation.ts.
export type DictationEventType = "partial" | "final";

export interface DictationEvent {
  type: DictationEventType;
  text: string;
}

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyDictationEvent,
  commitInterim,
  dictationSupported,
  initTranscript,
  readDictationSSE,
  renderTranscript,
  streamDictation,
  type DictationEvent,
  type TranscriptState,
} from "./dictation";

// Feed a sequence of events through the reconciler and return the rendered composer value.
function play(base: string, events: DictationEvent[]): string {
  let st = initTranscript(base);
  for (const ev of events) st = applyDictationEvent(st, ev);
  return renderTranscript(st);
}

describe("transcript reconciliation (pure)", () => {
  test("a partial renders as interim text appended to the base", () => {
    expect(play("", [{ type: "partial", text: "hello" }])).toBe("hello");
  });

  test("a newer partial REPLACES the previous interim (mid-utterance correction)", () => {
    expect(
      play("", [
        { type: "partial", text: "I scream" },
        { type: "partial", text: "ice cream" },
      ]),
    ).toBe("ice cream");
  });

  test("a final COMMITS and a following partial appends after it", () => {
    expect(
      play("", [
        { type: "partial", text: "hello" },
        { type: "final", text: "hello there" },
        { type: "partial", text: "friend" },
      ]),
    ).toBe("hello there friend");
  });

  test("multiple finals accumulate into a stable transcript", () => {
    expect(
      play("", [
        { type: "final", text: "one" },
        { type: "final", text: "two" },
        { type: "final", text: "three" },
      ]),
    ).toBe("one two three");
  });

  test("dictation appends to pre-existing composer text, never clobbers it", () => {
    expect(play("Draft note:", [{ type: "partial", text: "buy milk" }])).toBe("Draft note: buy milk");
  });

  test("a base with a trailing space still joins with exactly one space", () => {
    expect(play("Draft note: ", [{ type: "final", text: "buy milk" }])).toBe("Draft note: buy milk");
  });

  test("empty base + no speech renders empty", () => {
    expect(renderTranscript(initTranscript(""))).toBe("");
  });

  test("a base with no speech renders just the base", () => {
    expect(renderTranscript(initTranscript("just typed"))).toBe("just typed");
  });

  test("commitInterim folds a trailing interim into committed (stop with no final)", () => {
    let st = initTranscript("");
    st = applyDictationEvent(st, { type: "final", text: "hello" });
    st = applyDictationEvent(st, { type: "partial", text: "world" });
    const committed = commitInterim(st);
    expect(committed.interim).toBe("");
    expect(renderTranscript(committed)).toBe("hello world");
  });

  test("commitInterim is a no-op when there is no interim", () => {
    const st: TranscriptState = { base: "", committed: "done", interim: "" };
    expect(commitInterim(st)).toBe(st);
  });

  test("ragged whitespace in chunks collapses to single spaces", () => {
    expect(
      play("", [
        { type: "final", text: "  hello  " },
        { type: "partial", text: "  there " },
      ]),
    ).toBe("hello there");
  });

  // ---- terminal-only commit (#218) --------------------------------------------------------
  // Each ~1s POST re-transcribes the FULL cumulative audio, so a `final` from a NON-terminal
  // segment must NOT commit (that would double-commit when the next cumulative POST re-transcribes
  // the same audio). Only the terminal `?final=1` segment commits.
  test("a NON-terminal final does NOT commit — it updates interim only (#218)", () => {
    let st = initTranscript("");
    // A mid-stream slice's upstream emits an incremental final ("hello")...
    st = applyDictationEvent(st, { type: "partial", text: "hel" }, false);
    st = applyDictationEvent(st, { type: "final", text: "hello" }, false);
    expect(st.committed).toBe(""); // nothing committed yet
    expect(renderTranscript(st)).toBe("hello"); // shown live via interim
    // ...then the TERMINAL POST re-transcribes the full cumulative audio to "hello there".
    st = applyDictationEvent(st, { type: "final", text: "hello there" }, true);
    expect(st.committed).toBe("hello there");
    expect(renderTranscript(st)).toBe("hello there"); // NOT "hello hello there"
  });

  test("only the terminal segment's final commits; non-terminal finals stay interim (#218)", () => {
    let st = initTranscript("");
    st = applyDictationEvent(st, { type: "final", text: "one" }, false);
    st = applyDictationEvent(st, { type: "final", text: "one two" }, false);
    expect(st.committed).toBe(""); // non-terminal finals never accumulate
    expect(renderTranscript(st)).toBe("one two"); // interim tracks the latest cumulative transcript
    st = applyDictationEvent(st, { type: "final", text: "one two three" }, true);
    expect(st.committed).toBe("one two three");
    expect(renderTranscript(st)).toBe("one two three");
  });

  test("a terminal segment that ends on a partial commits via commitInterim on stop (#218)", () => {
    // A batch-style one-shot upstream returns only a partial, even on the terminal POST.
    let st = initTranscript("");
    st = applyDictationEvent(st, { type: "partial", text: "buy milk" }, true);
    expect(st.committed).toBe(""); // a terminal PARTIAL still doesn't commit
    st = commitInterim(st); // stop folds the trailing interim in
    expect(renderTranscript(st)).toBe("buy milk");
  });
});

// ---- transport ------------------------------------------------------------------------------

function sseResponse(text: string, init: { status?: number; noBody?: boolean } = {}): Response {
  const status = init.status ?? 200;
  if (init.noBody) return new Response(null, { status });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status });
}

describe("readDictationSSE", () => {
  test("emits partial then final frames", async () => {
    const events: DictationEvent[] = [];
    await readDictationSSE(
      sseResponse('event: partial\ndata: {"text":"ice"}\n\nevent: final\ndata: {"text":"ice cream"}\n\n').body!,
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { type: "partial", text: "ice" },
      { type: "final", text: "ice cream" },
    ]);
  });

  test("throws on an error frame so the caller can fall back to batch", async () => {
    await expect(
      readDictationSSE(sseResponse('event: error\ndata: {"message":"boom"}\n\n').body!, () => {}),
    ).rejects.toThrow("boom");
  });

  test("ignores malformed data frames", async () => {
    const events: DictationEvent[] = [];
    await readDictationSSE(sseResponse("event: partial\ndata: {not json\n\n").body!, (e) => events.push(e));
    expect(events).toEqual([]);
  });
});

describe("dictationSupported", () => {
  const realMediaDevices = navigator.mediaDevices;
  const realMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", { value: realMediaDevices, configurable: true });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = realMediaRecorder;
  });

  test("false without getUserMedia / MediaRecorder", () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    expect(dictationSupported()).toBe(false);
  });

  test("true when both are present", () => {
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: () => {} }, configurable: true });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {};
    expect(dictationSupported()).toBe(true);
  });
});

// A fake MediaRecorder driving the streamDictation transport without a real mic.
class FakeMediaRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  started = false;
  static last: FakeMediaRecorder | null = null;
  static throwOnConstruct = false;
  constructor(public stream: unknown) {
    if (FakeMediaRecorder.throwOnConstruct) throw new Error("no recorder");
    FakeMediaRecorder.last = this;
  }
  start(_slice?: number) {
    this.started = true;
  }
  stop() {
    this.onstop?.();
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text], { type: "audio/webm" }) });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("streamDictation", () => {
  const realMediaDevices = navigator.mediaDevices;
  const realMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const realFetch = globalThis.fetch;
  const trackStop = vi.fn();

  beforeEach(() => {
    FakeMediaRecorder.last = null;
    FakeMediaRecorder.throwOnConstruct = false;
    trackStop.mockClear();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
      configurable: true,
    });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  });
  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", { value: realMediaDevices, configurable: true });
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = realMediaRecorder;
    globalThis.fetch = realFetch;
  });

  test("streams partials from each slice and commits a final on stop", async () => {
    globalThis.fetch = vi.fn(async (url: string) =>
      url.includes("final=1")
        ? sseResponse('event: final\ndata: {"text":"ice cream"}\n\n')
        : sseResponse('event: partial\ndata: {"text":"ice"}\n\n'),
    ) as unknown as typeof fetch;

    const events: DictationEvent[] = [];
    const onStop = vi.fn();
    const session = await streamDictation({ onEvent: (e) => events.push(e), onError: vi.fn(), onStop });

    FakeMediaRecorder.last!.emit("slice-1");
    await tick();
    expect(events).toContainEqual({ type: "partial", text: "ice" });

    session.stop();
    await tick();
    await tick();
    expect(events).toContainEqual({ type: "final", text: "ice cream" });
    expect(onStop).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled(); // mic released
  });

  test("drops a late interim event that resolves after stop() (#218)", async () => {
    // Hold the interim POST open until we release it, so it resolves AFTER stop() has run the
    // terminal flush + onStop — modeling the post-stop event race.
    let releaseInterim: (() => void) | undefined;
    const interimGate = new Promise<void>((r) => {
      releaseInterim = r;
    });
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("final=1")) return sseResponse('event: final\ndata: {"text":"done"}\n\n');
      await interimGate; // the interim POST hangs until released
      return sseResponse('event: partial\ndata: {"text":"late"}\n\n');
    }) as unknown as typeof fetch;

    const events: DictationEvent[] = [];
    const onStop = vi.fn();
    const session = await streamDictation({ onEvent: (e) => events.push(e), onError: vi.fn(), onStop });

    FakeMediaRecorder.last!.emit("slice-1"); // starts the (gated) interim flush
    await tick();
    expect(events).not.toContainEqual({ type: "partial", text: "late" }); // still in flight

    session.stop(); // stopped=true → terminal flush commits "done" → onStop
    await tick();
    await tick();
    expect(events).toContainEqual({ type: "final", text: "done" });
    expect(onStop).toHaveBeenCalled();

    // Release the straggler interim POST — its "late" partial must be DROPPED (no post-stop mutation).
    releaseInterim!();
    await tick();
    await tick();
    expect(events).not.toContainEqual({ type: "partial", text: "late" });
  });

  test("reports a transport error via onError (composer falls back to batch)", async () => {
    globalThis.fetch = vi.fn(async () => sseResponse("nope", { status: 500 })) as unknown as typeof fetch;
    const onError = vi.fn();
    const session = await streamDictation({ onEvent: vi.fn(), onError });
    FakeMediaRecorder.last!.emit("slice-1");
    await tick();
    expect(onError).toHaveBeenCalled();
    session.stop();
    await tick();
  });

  test("a second stop() is a no-op", async () => {
    globalThis.fetch = vi.fn(async () => sseResponse("", { noBody: true })) as unknown as typeof fetch;
    const session = await streamDictation({ onEvent: vi.fn(), onError: vi.fn() });
    session.stop();
    await tick();
    session.stop(); // guarded — does not re-stop
    await tick();
  });

  test("rejects when the mic is denied (caller falls back to batch)", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(async () => Promise.reject(new Error("denied"))) },
      configurable: true,
    });
    await expect(streamDictation({ onEvent: vi.fn(), onError: vi.fn() })).rejects.toThrow("denied");
  });

  test("releases the mic and rethrows if the recorder fails to construct", async () => {
    FakeMediaRecorder.throwOnConstruct = true;
    await expect(streamDictation({ onEvent: vi.fn(), onError: vi.fn() })).rejects.toThrow("no recorder");
    expect(trackStop).toHaveBeenCalled();
  });
});

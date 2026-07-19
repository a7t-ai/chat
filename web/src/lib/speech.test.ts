import { afterEach, describe, expect, test, vi } from "vitest";
import { cancelSpeech, speak, speechSupported } from "./speech";

// A minimal SpeechSynthesisUtterance stand-in: jsdom ships no speech engine, so the tests stub
// the two globals the helper touches.
function stubUtterance() {
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    vi.fn(function (this: Record<string, unknown>, text: string) {
      this.text = text;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speechSupported", () => {
  test("false when the engine is absent", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    expect(speechSupported()).toBe(false);
  });

  test("true when both globals exist", () => {
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn() });
    stubUtterance();
    expect(speechSupported()).toBe(true);
  });
});

describe("speak", () => {
  test("cancels any in-flight utterance, then speaks the text; fires onEnd on end", () => {
    const cancel = vi.fn();
    const synthSpeak = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak: synthSpeak, cancel });
    stubUtterance();

    const onEnd = vi.fn();
    expect(speak("read this aloud", { onEnd })).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1); // one utterance at a time
    expect(synthSpeak).toHaveBeenCalledTimes(1);
    const started = synthSpeak.mock.calls[0][0] as { onend?: () => void; onerror?: () => void; text: string };
    expect(started.text).toBe("read this aloud");

    started.onend?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("treats an engine error as end (so the loop never strands)", () => {
    const synthSpeak = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak: synthSpeak, cancel: vi.fn() });
    stubUtterance();
    const onEnd = vi.fn();
    speak("boom", { onEnd });
    const started = synthSpeak.mock.calls[0][0] as { onerror?: () => void };
    started.onerror?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  test("returns false (no throw) when speech is unsupported", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    const onEnd = vi.fn();
    expect(speak("nope", { onEnd })).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
  });

  test("returns false when the engine throws mid-call", () => {
    vi.stubGlobal("speechSynthesis", {
      cancel: () => {
        throw new Error("engine gone");
      },
      speak: vi.fn(),
    });
    stubUtterance();
    expect(speak("x")).toBe(false);
  });

  test("defaults opts to an empty object (no onEnd needed)", () => {
    const synthSpeak = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak: synthSpeak, cancel: vi.fn() });
    stubUtterance();
    expect(speak("hi")).toBe(true);
    const started = synthSpeak.mock.calls[0][0] as { onend?: () => void };
    expect(() => started.onend?.()).not.toThrow();
  });
});

describe("cancelSpeech", () => {
  test("cancels the engine when supported", () => {
    const cancel = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel });
    stubUtterance();
    cancelSpeech();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("is a no-op when unsupported", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    expect(() => cancelSpeech()).not.toThrow();
  });

  test("swallows an engine that throws on cancel", () => {
    vi.stubGlobal("speechSynthesis", {
      cancel: () => {
        throw new Error("gone");
      },
    });
    stubUtterance();
    expect(() => cancelSpeech()).not.toThrow();
  });
});

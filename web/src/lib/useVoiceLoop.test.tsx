import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useVoiceLoop } from "./useVoiceLoop";

// A settable-onstop MediaRecorder stand-in; stop() replays the endpoint the hook listens for.
class FakeRecorder {
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => {
    this.onstop?.();
  });
}

let track: { stop: ReturnType<typeof vi.fn> };
let getUserMedia: ReturnType<typeof vi.fn>;
let synthSpeak: ReturnType<typeof vi.fn>;
let synthCancel: ReturnType<typeof vi.fn>;
let lastUtterance: { onend?: () => void; onerror?: () => void; text: string } | null;

function stubBrowser() {
  track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder as unknown as typeof MediaRecorder);
  synthSpeak = vi.fn((u: typeof lastUtterance) => {
    lastUtterance = u;
  });
  synthCancel = vi.fn();
  lastUtterance = null;
  vi.stubGlobal("speechSynthesis", { speak: synthSpeak, cancel: synthCancel });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    vi.fn(function (this: Record<string, unknown>, text: string) {
      this.text = text;
    }),
  );
}

// Standard deps; a test can override before rendering.
function deps(over: Partial<Parameters<typeof useVoiceLoop>[0]> = {}) {
  return {
    getReply: () => "the answer",
    send: vi.fn(),
    transcribe: vi.fn().mockResolvedValue("hello there"),
    onNotice: vi.fn(),
    ...over,
  };
}

// Render the hook with a controllable `busy` prop (the parent's `sending`).
function renderLoop(d: ReturnType<typeof deps>, busy = false) {
  return renderHook(({ busy }: { busy: boolean }) => useVoiceLoop({ busy, ...d }), {
    initialProps: { busy },
  });
}

beforeEach(() => {
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVoiceLoop — the hands-free conversational loop", () => {
  test("toggle opens the mic and moves to listening (never before the gesture)", async () => {
    const d = deps();
    const { result } = renderLoop(d);
    // Nothing happens until the user's toggle gesture — the mic never auto-opens on mount.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.state).toBe("off");

    await act(async () => {
      result.current.toggle();
    });
    await waitFor(() => expect(result.current.state).toBe("listening"));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("one turn: transcribe → send → (answer) → speak, in that order, then loops", async () => {
    const order: string[] = [];
    const send = vi.fn(() => order.push("send"));
    const transcribe = vi.fn(async () => {
      order.push("transcribe");
      return "what time is it";
    });
    const d = deps({ send, transcribe, getReply: () => "it is noon" });
    const { result, rerender } = renderLoop(d);

    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("listening"));

    // End the turn (the status-pill tap / stop press).
    await act(async () => result.current.stopTurn());
    await waitFor(() => expect(send).toHaveBeenCalledWith("what time is it"));
    expect(result.current.state).toBe("awaiting");

    // The turn streams (busy) then settles — only THEN is the reply read back.
    rerender({ busy: true });
    rerender({ busy: false });
    await waitFor(() => expect(result.current.state).toBe("speaking"));
    order.push("speak");
    expect(synthSpeak).toHaveBeenCalledTimes(1);
    expect(lastUtterance?.text).toBe("it is noon");
    expect(order).toEqual(["transcribe", "send", "speak"]);

    // When speech ends the mic reopens for the next turn — hands-free.
    await act(async () => lastUtterance?.onend?.());
    await waitFor(() => expect(result.current.state).toBe("listening"));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  test("toggling off fully stops the mic and speech", async () => {
    const d = deps();
    const { result, rerender } = renderLoop(d);
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("listening"));

    // Get into speaking so both the recorder AND the speech engine are live.
    await act(async () => result.current.stopTurn());
    await waitFor(() => expect(result.current.state).toBe("awaiting"));
    rerender({ busy: true });
    rerender({ busy: false });
    await waitFor(() => expect(result.current.state).toBe("speaking"));

    await act(async () => result.current.toggle()); // off
    expect(result.current.state).toBe("off");
    expect(synthCancel).toHaveBeenCalled(); // speech cancelled
    expect(track.stop).toHaveBeenCalled(); // mic track released
  });

  test("a denied mic surfaces the notice and leaves voice mode", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const onNotice = vi.fn();
    const d = deps({ onNotice });
    const { result } = renderLoop(d);
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("off"));
    expect(onNotice).toHaveBeenCalledWith("composer.micError");
  });

  test("a failed transcription surfaces the notice and reopens the mic", async () => {
    const transcribe = vi.fn().mockRejectedValue(new Error("stt down"));
    const onNotice = vi.fn();
    const d = deps({ transcribe, onNotice });
    const { result } = renderLoop(d);
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("listening"));
    await act(async () => result.current.stopTurn());
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("composer.transcribeError"));
    // Recovered: it reopens the mic rather than getting stuck.
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  });

  test("an empty transcript reopens the mic without sending", async () => {
    const send = vi.fn();
    const transcribe = vi.fn().mockResolvedValue("   ");
    const d = deps({ send, transcribe });
    const { result } = renderLoop(d);
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("listening"));
    await act(async () => result.current.stopTurn());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2)); // reopened
    expect(send).not.toHaveBeenCalled();
  });

  test("an empty answer skips speaking and reopens the mic", async () => {
    const d = deps({ getReply: () => "" });
    const { result, rerender } = renderLoop(d);
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("listening"));
    await act(async () => result.current.stopTurn());
    await waitFor(() => expect(result.current.state).toBe("awaiting"));
    rerender({ busy: true });
    rerender({ busy: false });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2)); // looped, no speech
    expect(synthSpeak).not.toHaveBeenCalled();
  });

  test("barge-in interrupts the reply and takes the next turn", async () => {
    const d = deps();
    const { result, rerender } = renderLoop(d);
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("listening"));
    await act(async () => result.current.stopTurn());
    await waitFor(() => expect(result.current.state).toBe("awaiting"));
    rerender({ busy: true });
    rerender({ busy: false });
    await waitFor(() => expect(result.current.state).toBe("speaking"));

    await act(async () => result.current.stopTurn()); // barge in
    expect(synthCancel).toHaveBeenCalled();
    await waitFor(() => expect(result.current.state).toBe("listening")); // reopened
  });

  test("no TTS engine: the loop skips speaking and continues", async () => {
    vi.stubGlobal("speechSynthesis", undefined);
    const d = deps();
    const { result, rerender } = renderLoop(d);
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("listening"));
    await act(async () => result.current.stopTurn());
    await waitFor(() => expect(result.current.state).toBe("awaiting"));
    rerender({ busy: true });
    rerender({ busy: false });
    // With no engine `speak` returns false → straight back to listening.
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  });

  test("the safety timeout auto-ends a listening turn", async () => {
    vi.useFakeTimers();
    const d = deps();
    const { result } = renderLoop(d);
    await act(async () => {
      result.current.toggle();
      await vi.runOnlyPendingTimersAsync();
    });
    await vi.waitFor(() => expect(result.current.state).toBe("listening"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    // The endpoint fired from the timer → the recorder was stopped (STT leg engaged).
    await vi.waitFor(() => expect(result.current.state).not.toBe("listening"));
    vi.useRealTimers();
  });

  test("unmount releases the mic and cancels speech", async () => {
    const d = deps();
    const { result, unmount } = renderLoop(d);
    await act(async () => result.current.toggle());
    await waitFor(() => expect(result.current.state).toBe("listening"));
    unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(synthCancel).toHaveBeenCalled();
  });
});

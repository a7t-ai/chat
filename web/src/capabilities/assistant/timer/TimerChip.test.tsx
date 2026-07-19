import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The end-of-timer alerting (chime + OS notification, #130) is exercised on its own in
// alarm.test.ts; here we mock it to a set of spies so we can assert the chip WIRES it correctly
// (unlock + permission on Start, fire-once on completion, mute path, stop-on-interaction) without
// touching real WebAudio/Notification.
const mockAlarm = vi.hoisted(() => {
  const stop = vi.fn();
  return {
    stop,
    unlockAudio: vi.fn(),
    requestNotifyPermission: vi.fn(),
    notifyDone: vi.fn(() => false),
    playChime: vi.fn(() => ({ stop })),
  };
});
vi.mock("./alarm", () => ({
  unlockAudio: mockAlarm.unlockAudio,
  requestNotifyPermission: mockAlarm.requestNotifyPermission,
  notifyDone: mockAlarm.notifyDone,
  playChime: mockAlarm.playChime,
}));

// The timer-sound mute lives in preferences; mock the hook so a test can flip it.
const mockPrefs = vi.hoisted(() => ({ timerSound: true }));
vi.mock("../../../lib/preferences", () => ({
  usePreferences: () => ({ behavior: { timerSound: mockPrefs.timerSound } }),
}));

import { TimerChip } from "./TimerChip";

// TimerChip is the inline countdown rendered for a [[timer:…]] marker. It must: parse the payload,
// count down on start, pause/resume, announce done + restart, reset to pristine, and fall back to
// plain text on a malformed marker. Fake timers make the countdown deterministic (they mock Date
// too, so the endsAt-based remaining computation advances with the clock).

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockPrefs.timerSound = true;
});
afterEach(() => vi.useRealTimers());

// Advance the fake clock inside act() so the interval's state updates flush.
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("TimerChip", () => {
  test("renders the label and full clock, with no reset until it's been touched", () => {
    render(<TimerChip payload="20m|Bake" />);
    expect(screen.getByText("Bake")).toBeInTheDocument();
    expect(screen.getByText("20:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Bake" })).toBeInTheDocument();
    // Pristine → no reset control.
    expect(screen.queryByRole("button", { name: "Reset Bake" })).toBeNull();
  });

  test("counts down after Start and exposes Pause + Reset", () => {
    render(<TimerChip payload="20m|Bake" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Bake" }));
    // Now running: the toggle flips to Pause and a Reset appears immediately.
    expect(screen.getByRole("button", { name: "Pause Bake" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset Bake" })).toBeInTheDocument();
    advance(60_000);
    expect(screen.getByText("19:00")).toBeInTheDocument();
  });

  test("Pause freezes the remaining time", () => {
    render(<TimerChip payload="20m|Bake" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Bake" }));
    advance(60_000);
    expect(screen.getByText("19:00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause Bake" }));
    // Paused → the toggle is Start again, and the clock no longer moves.
    expect(screen.getByRole("button", { name: "Start Bake" })).toBeInTheDocument();
    advance(120_000);
    expect(screen.getByText("19:00")).toBeInTheDocument();
  });

  test("reaches Done, announces completion, then restarts from full", () => {
    render(<TimerChip payload="2s|Boil" />);
    expect(screen.getByText("0:02")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start Boil" }));
    advance(3_000);
    expect(screen.getByText("Done")).toBeInTheDocument();
    // Announced once via a role="status" region (only present while done).
    expect(screen.getByRole("status")).toHaveTextContent("Boil done");
    // From done, the toggle restarts the whole timer.
    const restart = screen.getByRole("button", { name: "Restart Boil" });
    fireEvent.click(restart);
    expect(screen.getByText("0:02")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause Boil" })).toBeInTheDocument();
  });

  test("Reset returns to the pristine full-duration state", () => {
    render(<TimerChip payload="20m|Bake" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Bake" }));
    advance(60_000);
    fireEvent.click(screen.getByRole("button", { name: "Reset Bake" }));
    expect(screen.getByText("20:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Bake" })).toBeInTheDocument();
    // Back to pristine → the reset control is gone again.
    expect(screen.queryByRole("button", { name: "Reset Bake" })).toBeNull();
  });

  test("a label-less timer falls back to the generic 'Timer' name", () => {
    render(<TimerChip payload="5m" />);
    expect(screen.getByRole("button", { name: "Start Timer" })).toBeInTheDocument();
    expect(screen.getByText("5:00")).toBeInTheDocument();
  });

  test("a malformed marker renders as plain text, never a broken chip", () => {
    render(<TimerChip payload="soon-ish" />);
    expect(screen.getByText("soon-ish")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("TimerChip — end-of-timer alerts (#130)", () => {
  test("Start unlocks audio and requests notification permission (on the gesture, not on load)", () => {
    render(<TimerChip payload="2s|Boil" />);
    // Nothing requested just from rendering.
    expect(mockAlarm.unlockAudio).not.toHaveBeenCalled();
    expect(mockAlarm.requestNotifyPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start Boil" }));
    expect(mockAlarm.unlockAudio).toHaveBeenCalledTimes(1);
    expect(mockAlarm.requestNotifyPermission).toHaveBeenCalledTimes(1);
  });

  test("on completion it chimes once and attempts an OS notification with the label", () => {
    render(<TimerChip payload="2s|Boil" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Boil" }));
    advance(3_000);
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(mockAlarm.playChime).toHaveBeenCalledTimes(1);
    expect(mockAlarm.notifyDone).toHaveBeenCalledWith("Boil done");
    // Fire-once: further ticks past done don't re-alert.
    advance(5_000);
    expect(mockAlarm.playChime).toHaveBeenCalledTimes(1);
    expect(mockAlarm.notifyDone).toHaveBeenCalledTimes(1);
  });

  test("muting silences the chime but still notifies and shows Done", () => {
    mockPrefs.timerSound = false;
    render(<TimerChip payload="2s|Boil" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Boil" }));
    advance(3_000);
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(mockAlarm.playChime).not.toHaveBeenCalled();
    expect(mockAlarm.notifyDone).toHaveBeenCalledWith("Boil done");
  });

  test("a label-less timer notifies with the generic name", () => {
    render(<TimerChip payload="2s" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Timer" }));
    advance(3_000);
    expect(mockAlarm.notifyDone).toHaveBeenCalledWith("Timer done");
  });

  test("any interaction after completion stops the ringing chime", () => {
    render(<TimerChip payload="2s|Boil" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Boil" }));
    advance(3_000);
    expect(mockAlarm.playChime).toHaveBeenCalledTimes(1);
    // Restart (the toggle while done) silences the alarm.
    fireEvent.click(screen.getByRole("button", { name: "Restart Boil" }));
    expect(mockAlarm.stop).toHaveBeenCalled();
  });

  test("Reset stops a ringing chime", () => {
    render(<TimerChip payload="2s|Boil" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Boil" }));
    advance(3_000);
    fireEvent.click(screen.getByRole("button", { name: "Reset Boil" }));
    expect(mockAlarm.stop).toHaveBeenCalled();
  });

  test("unmounting mid-alarm silences the chime", () => {
    const { unmount } = render(<TimerChip payload="2s|Boil" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Boil" }));
    advance(3_000);
    expect(mockAlarm.playChime).toHaveBeenCalledTimes(1);
    unmount();
    expect(mockAlarm.stop).toHaveBeenCalled();
  });
});

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DotGrid } from "./DotGrid";

// DotGrid drives an animated canvas in a useEffect. jsdom has no real 2D context or rAF
// timing, so we stub getContext + matchMedia + requestAnimationFrame and assert: it mounts
// without throwing, wires up its pointer/resize listeners, and tears them down on unmount.
// Two render passes (reduced-motion on/off) cover the kick() branch.

let ctxCalls: Record<string, ReturnType<typeof vi.fn>>;

function fakeCtx() {
  ctxCalls = {
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
  return { ...ctxCalls, fillStyle: "" } as unknown as CanvasRenderingContext2D;
}

// rAF callbacks are QUEUED, never run synchronously (loop() reschedules itself, which would
// recurse forever). Tests flush a bounded number of frames manually.
let rafQueue: FrameRequestCallback[] = [];
function flushFrames(n = 3) {
  for (let i = 0; i < n; i++) {
    const cb = rafQueue.shift();
    if (!cb) break;
    cb(0);
  }
}

beforeEach(() => {
  rafQueue = [];
  // jsdom reports 0 for clientWidth/Height, which would make the dot grid 0×0 and skip the
  // whole draw loop. Give the canvas real dimensions so cols/rows > 0 and the per-dot body
  // (radius/fillStyle/arc) actually runs.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => fakeCtx() as unknown as ReturnType<HTMLCanvasElement["getContext"]>,
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubMatchMedia(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reduce })),
  );
}

describe("DotGrid", () => {
  test("mounts a canvas, paints, and registers listeners (motion allowed)", () => {
    stubMatchMedia(false);
    const addSpy = vi.spyOn(window, "addEventListener");
    const { container } = render(<DotGrid />);
    const canvas = container.querySelector("canvas.dot-grid");
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    // resize() ran on mount → it cleared + drew at least once.
    expect(ctxCalls.clearRect).toHaveBeenCalled();
    const events = addSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("resize");
    expect(events).toContain("pointermove");
  });

  test("a pointermove paints via the kick()/loop() path", () => {
    stubMatchMedia(false);
    render(<DotGrid />);
    window.dispatchEvent(new Event("pointermove"));
    // kick() scheduled a frame.
    expect(rafQueue.length).toBeGreaterThan(0);
    ctxCalls.clearRect.mockClear();
    // Flushing it runs loop() → render(), which clears the canvas each frame.
    flushFrames();
    expect(ctxCalls.clearRect).toHaveBeenCalled();
  });

  test("a pointer over the grid lights up nearby dots, then a leave fades them out", () => {
    stubMatchMedia(false);
    render(<DotGrid />);
    // Point the cursor into the middle of the grid so dots fall inside REACH and glow.
    const move = new Event("pointermove") as PointerEvent;
    Object.defineProperty(move, "clientX", { value: 150 });
    Object.defineProperty(move, "clientY", { value: 100 });
    window.dispatchEvent(move);
    ctxCalls.arc.mockClear();
    // Several frames let the eased intensity climb past the glow threshold.
    flushFrames(10);
    expect(ctxCalls.arc).toHaveBeenCalled(); // dots were drawn
    // Now leave: targetIntensity → 0, kick() schedules the fade-out frames.
    document.dispatchEvent(new Event("pointerleave"));
    flushFrames(10);
    expect(ctxCalls.clearRect).toHaveBeenCalled();
  });

  test("reduced-motion takes the snap path on pointer events", () => {
    stubMatchMedia(true);
    render(<DotGrid />);
    ctxCalls.clearRect.mockClear();
    window.dispatchEvent(new Event("pointermove"));
    window.dispatchEvent(new Event("pointerdown"));
    document.dispatchEvent(new Event("pointerleave"));
    // kick() in reduced-motion calls render(true) directly (no rAF), which clears.
    expect(ctxCalls.clearRect).toHaveBeenCalled();
  });

  test("removes its listeners on unmount", () => {
    stubMatchMedia(false);
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<DotGrid />);
    unmount();
    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain("resize");
    expect(removed).toContain("pointermove");
    expect(removed).toContain("pointerdown");
  });

  test("bails out cleanly when getContext returns null", () => {
    stubMatchMedia(false);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(() => render(<DotGrid />)).not.toThrow();
  });
});

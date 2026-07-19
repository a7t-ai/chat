import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildMinimap, type MinimapInput } from "../lib/minimap";
import { Minimap } from "./Minimap";

const thread: MinimapInput[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "an answer\nwith ![pic](x.png) and [[map:Lisbon]]" },
  { role: "user", content: "and a follow up" },
  { role: "assistant", content: "```js\nconst a = 1;\n```\nplus a closing note" },
  { role: "user", content: "one more" },
];

// A fake scroll container with controllable scroll metrics (jsdom has no layout) and a
// spy-able scrollTo (the scrub now maps a strip fraction onto the thread's scrollHeight via
// scrollTo, not by scrolling a specific row into view).
function makeScrollEl(over: Partial<HTMLElement> = {}): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperties(el, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 200, configurable: true },
  });
  el.scrollTo = vi.fn();
  el.scrollBy = vi.fn();
  Object.assign(el, over);
  return el;
}

// In the FLOW model the blocks have no inline px geometry — the DOM sizes each to its own
// excerpt. jsdom reports 0 for every offsetHeight/clientHeight, which would collapse the strip
// (P) and track (T) to 0, so we stub the two boxes the parallax math measures: the strip's
// clientHeight (P) and the FLOWED track's offsetHeight (T). We default T tall and P short so
// the track OVERFLOWS the strip — the whole point of the parallax — exercising the offset.
// The original descriptors (if any) are restored in afterEach so the stub never leaks.
let restoreLayout: (() => void) | null = null;
// The ResizeObserver callbacks + instances created during a render, captured by the RO stub in
// beforeEach so a test can fire a reflow on demand and assert the observe/disconnect wiring.
let roCallbacks: ResizeObserverCallback[] = [];
let roInstances: Array<{ observed: Element[]; disconnected: boolean }> = [];
function stubLayout({ stripHeight = 60, trackHeight = 720 }: { stripHeight?: number; trackHeight?: number } = {}) {
  const proto = HTMLElement.prototype;
  const prevClient = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  const prevOffset = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("minimap") ? stripHeight : 0;
    },
  });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      // The flowed track's own offsetHeight is read for T; report the stubbed measured height.
      return this.classList.contains("minimap-track") ? trackHeight : 0;
    },
  });
  restoreLayout = () => {
    if (prevClient) Object.defineProperty(proto, "clientHeight", prevClient);
    else delete (proto as unknown as Record<string, unknown>).clientHeight;
    if (prevOffset) Object.defineProperty(proto, "offsetHeight", prevOffset);
    else delete (proto as unknown as Record<string, unknown>).offsetHeight;
  };
}

function setup(opts?: {
  messageCount?: number;
  messages?: MinimapInput[];
  scrollEl?: HTMLElement | null;
}) {
  const messages = opts?.messages ?? thread;
  const model = buildMinimap(messages);
  const scrollRef = createRef<HTMLElement>();
  scrollRef.current = opts?.scrollEl === undefined ? makeScrollEl() : opts.scrollEl;
  const utils = render(
    <Minimap
      model={model}
      scrollRef={scrollRef}
      messageCount={opts?.messageCount ?? messages.length}
    />,
  );
  return { ...utils, model, scrollRef };
}

beforeEach(() => {
  stubLayout();
  // Give the strip a real-ish box so the scrub's strip-Y math works (jsdom returns zeros).
  // top:0, height:60 matches the stubbed strip height so the scrub maps cleanly.
  Element.prototype.getBoundingClientRect = vi.fn(function (this: Element) {
    return { top: 0, left: 0, bottom: 60, right: 12, width: 12, height: 60, x: 0, y: 0, toJSON: () => {} };
  });
  // setPointerCapture/release aren't implemented in jsdom.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  // jsdom has no ResizeObserver. Stub a controllable one: capture each instance's callback so a
  // test can fire it on demand (the real one fires when the hover-widen reflows the track), and
  // record observe/disconnect so we can assert the wiring + teardown.
  roCallbacks = [];
  roInstances = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observed: Element[] = [];
      disconnected = false;
      constructor(public cb: ResizeObserverCallback) {
        roCallbacks.push(cb);
        roInstances.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  );
  // rAF runs synchronously so scroll-driven viewport updates land within the test tick.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  restoreLayout?.();
  restoreLayout = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Minimap", () => {
  test("renders one block per message above the threshold", () => {
    setup();
    expect(screen.getByLabelText(/minimap|minimapa/i)).toBeInTheDocument();
    const blocks = document.querySelectorAll(".minimap-block");
    expect(blocks).toHaveLength(thread.length);
  });

  test("hides below the message threshold", () => {
    const { container } = setup({ messages: thread.slice(0, 2), messageCount: 2 });
    expect(container.querySelector(".minimap")).toBeNull();
  });

  test("flows blocks with NO inline top/height — the DOM sizes each to its excerpt", () => {
    setup();
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(".minimap-block"));
    // The flow model emits no per-block px geometry: no inline top, no inline height. Blocks
    // stack in natural flow at height:auto, so consecutive blocks can never overlap.
    for (const b of blocks) {
      expect(b.style.top).toBe("");
      expect(b.style.height).toBe("");
    }
    // The track also carries no inline px height — it's whatever the DOM (here: the stub) makes
    // it; only the parallax translateY is set inline.
    const track = document.querySelector<HTMLElement>(".minimap-track");
    expect(track?.style.height).toBe("");
  });

  test("the track overflows the strip and translates UP in parallax as the thread scrolls", () => {
    const scrollEl = makeScrollEl();
    // T = 720 (measured track), P = 60 (strip) → the track is far taller than the strip.
    setup({ scrollEl });
    const track = document.querySelector<HTMLElement>(".minimap-track");
    // At the top of the thread the track is NOT translated (offset 0).
    expect(track?.style.transform).toBe("translateY(0px)");
    // Scroll to the very bottom: S = docOverflow = 800. trackOverflow = 720 - 60 = 660.
    // offset = (800/800) × 660 = 660 → track translated up by 660px (bottom-aligned).
    Object.defineProperty(scrollEl, "scrollTop", { value: 800, configurable: true });
    fireEvent.scroll(scrollEl);
    expect(track?.style.transform).toBe("translateY(-660px)");
  });

  test("the viewport rect uses the parallax formulas off the MEASURED track height", () => {
    const scrollEl = makeScrollEl();
    setup({ scrollEl });
    const vp = document.querySelector<HTMLElement>(".minimap-viewport");
    // T = 720 (measured), SH = 1000, CH = 200. At S = 0:
    //   vTopTrack = 0, vH = (200/1000)×720 = 144, offset = 0 → top 0px, height 144px.
    expect(vp?.style.top).toBe("0px");
    expect(vp?.style.height).toBe("144px");
    // At the very bottom (S = 800), the rect bottom sits at the strip bottom (P = 60):
    //   vTopTrack = (800/1000)×720 = 576, offset = 660 → vTopStrip = 576 - 660 = -84,
    //   height 144 → bottom = -84 + 144 = 60 = P. Verifies the bottom-alignment endpoint.
    Object.defineProperty(scrollEl, "scrollTop", { value: 800, configurable: true });
    fireEvent.scroll(scrollEl);
    expect(Number.parseFloat(vp?.style.top ?? "")).toBeCloseTo(-84, 0);
    expect(Number.parseFloat(vp?.style.top ?? "") + Number.parseFloat(vp?.style.height ?? "")).toBeCloseTo(60, 0);
  });

  test("a track/strip reflow (e.g. the hover-widen) re-measures the parallax against the live track", () => {
    // Regression: the hover-magnify WIDENS the strip, which reflows the flowed track to a
    // SHORTER height. The offset/viewport were last computed from the pre-hover TALL track, so
    // without a re-measure the now-short track is over-translated and the strip looks empty.
    const scrollEl = makeScrollEl();
    // Start scrolled to the bottom with the tall (720) track so there IS a non-zero offset.
    Object.defineProperty(scrollEl, "scrollTop", { value: 800, configurable: true });
    setup({ scrollEl });
    const track = document.querySelector<HTMLElement>(".minimap-track");
    // Tall track at the bottom → translated up by trackOverflow = 720 - 60 = 660.
    expect(track?.style.transform).toBe("translateY(-660px)");
    // The component observes the track + strip for size changes.
    expect(roInstances.length).toBeGreaterThan(0);
    const observedClasses = roInstances.flatMap((i) => i.observed.map((el) => el.className));
    expect(observedClasses.some((c) => c.includes("minimap-track"))).toBe(true);
    expect(observedClasses.some((c) => c.split(" ").includes("minimap"))).toBe(true);
    // Now the hover-widen reflows the track SHORTER (e.g. 720 → 120). Re-stub the measured
    // track height, then fire the ResizeObserver as the browser would during the reflow.
    restoreLayout?.();
    stubLayout({ stripHeight: 60, trackHeight: 120 });
    act(() => {
      for (const cb of roCallbacks) cb([], {} as ResizeObserver);
    });
    // The parallax recomputed against the LIVE short track: trackOverflow = 120 - 60 = 60, so
    // at the bottom the track is translated up by only 60px (not the stale 660) — content stays
    // filled from the top instead of going empty.
    expect(track?.style.transform).toBe("translateY(-60px)");
  });

  test("the ResizeObserver is disconnected on unmount (no scroll-perf leak)", () => {
    const { unmount } = setup();
    expect(roInstances.length).toBeGreaterThan(0);
    expect(roInstances.every((i) => i.disconnected)).toBe(false);
    unmount();
    expect(roInstances.every((i) => i.disconnected)).toBe(true);
  });

  test("when the measured track fits the strip there's no parallax (offset stays 0)", () => {
    const scrollEl = makeScrollEl();
    restoreLayout?.();
    // Measured track shorter than the strip → it fits, so no parallax.
    stubLayout({ stripHeight: 200, trackHeight: 110 });
    setup({ scrollEl });
    Object.defineProperty(scrollEl, "scrollTop", { value: 500, configurable: true });
    fireEvent.scroll(scrollEl);
    const track = document.querySelector<HTMLElement>(".minimap-track");
    // T (110) <= P (200) → trackOverflow 0 → offset 0; the rect just moves within the track.
    expect(track?.style.transform).toBe("translateY(0px)");
  });

  test("paints content-type texture: code band, tiny text, and map + file marks", () => {
    setup();
    // Message 3 is a code block → a code band BEHIND the excerpt; the excerpt is the intro
    // prose, not the fenced body.
    const codeBlock = document.querySelector('[data-mm-block="3"]');
    expect(codeBlock?.querySelector(".minimap-code")).not.toBeNull();
    const codeText = codeBlock?.querySelector(".minimap-text");
    expect(codeText?.textContent).toBe("plus a closing note");
    expect(codeText?.textContent).not.toContain("const a = 1");
    // Message 1 carries a map landmark + an attachment, rendered as glyphs in the marks cluster.
    const richBlock = document.querySelector('[data-mm-block="1"]');
    const markTitles = [...(richBlock?.querySelectorAll(".minimap-mark title") ?? [])].map((t) => t.textContent);
    expect(markTitles).toContain("map");
    expect(markTitles).toContain("file");
    // A plain prose block renders its tiny text excerpt, not a code band.
    const proseBlock = document.querySelector('[data-mm-block="0"]');
    expect(proseBlock?.querySelector(".minimap-text")?.textContent).toBe("first question");
    expect(proseBlock?.querySelector(".minimap-code")).toBeNull();
  });

  test("renders the cleaned excerpt as tiny text, markers as place text", () => {
    setup();
    // Message 1's marker [[map:Lisbon]] and ![pic](x.png) become readable text, no syntax.
    const richText = document.querySelector('[data-mm-block="1"] .minimap-text');
    expect(richText?.textContent).toBe("an answer with pic and Lisbon");
    expect(richText?.textContent).not.toContain("[[map");
    expect(richText?.textContent).not.toContain("![");
  });

  // The scrub inverts vTopStrip = S * k (k = T/SH - trackOverflow/docOverflow) to drive scroll
  // straight from the pointer. That needs the strip height P ~ the thread's clientHeight (the
  // strip spans the thread), or k goes negative — so these tests stub P close to CH. With
  // P=200, T=600, SH=1000, CH=200: docOverflow=800, trackOverflow=400, k=0.1, viewport rect ~[0,120].
  test("a click on empty track scrolls the thread smoothly toward the pressed position", () => {
    stubLayout({ stripHeight: 200, trackHeight: 600 });
    const scrollEl = makeScrollEl();
    setup({ scrollEl });
    const strip = screen.getByLabelText(/minimap|minimapa/i);
    const scrollTo = scrollEl.scrollTo as ReturnType<typeof vi.fn>;
    // Press BELOW the rect (~[0,120]) — empty track — so it's a jump: smooth, deeper into the
    // thread, clamped into the scrollable range [0, docOverflow].
    fireEvent.pointerDown(strip, { clientY: 170, pointerId: 1 });
    const call = scrollTo.mock.calls.at(-1)?.[0] as { top: number; behavior: string };
    expect(call.behavior).toBe("smooth");
    expect(call.top).toBeGreaterThan(0);
    expect(call.top).toBeLessThanOrEqual(800);
  });

  test("a press far past the bottom clamps to the end of the thread", () => {
    stubLayout({ stripHeight: 200, trackHeight: 600 });
    const scrollEl = makeScrollEl();
    setup({ scrollEl });
    const strip = screen.getByLabelText(/minimap|minimapa/i);
    const scrollTo = scrollEl.scrollTo as ReturnType<typeof vi.fn>;
    fireEvent.pointerDown(strip, { clientY: 5000, pointerId: 1 });
    // Clamped to docOverflow = scrollHeight - clientHeight = 800.
    expect((scrollTo.mock.calls.at(-1)?.[0] as { top: number }).top).toBe(800);
  });

  test("dragging scrubs continuously and instantly; a move with no button down is ignored", () => {
    stubLayout({ stripHeight: 200, trackHeight: 600 });
    const scrollEl = makeScrollEl();
    setup({ scrollEl });
    const strip = screen.getByLabelText(/minimap|minimapa/i);
    const scrollTo = scrollEl.scrollTo as ReturnType<typeof vi.fn>;
    // A move with no prior pointerdown does nothing.
    fireEvent.pointerMove(strip, { clientY: 60 });
    expect(scrollTo).not.toHaveBeenCalled();
    // Grab the rect (~[0,120]) and drag down → instant scrubs, each no earlier than the last.
    fireEvent.pointerDown(strip, { clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientY: 90, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(strip, { pointerId: 1 });
    const calls = scrollTo.mock.calls.map((c) => c[0] as { top: number; behavior: string });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.behavior === "instant")).toBe(true);
    const tops = calls.map((c) => c.top);
    for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeGreaterThanOrEqual(tops[i - 1] ?? 0);
  });

  test("keyboard arrows scroll the thread", () => {
    const scrollEl = makeScrollEl();
    const scrollBy = vi.fn();
    const scrollTo = vi.fn();
    scrollEl.scrollBy = scrollBy;
    scrollEl.scrollTo = scrollTo;
    setup({ scrollEl });
    const strip = screen.getByLabelText(/minimap|minimapa/i);
    fireEvent.keyDown(strip, { key: "ArrowDown" });
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ top: expect.any(Number) }));
    fireEvent.keyDown(strip, { key: "ArrowUp" });
    fireEvent.keyDown(strip, { key: "Home" });
    fireEvent.keyDown(strip, { key: "End" });
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  test("survives a null scroll container (nothing to track)", () => {
    expect(() => setup({ scrollEl: null })).not.toThrow();
    const strip = screen.getByLabelText(/minimap|minimapa/i);
    // Scrub + keyboard are no-ops without a scroll element (they bail early).
    fireEvent.pointerDown(strip, { clientY: 1, pointerId: 1 });
    fireEvent.keyDown(strip, { key: "ArrowDown" });
  });
});

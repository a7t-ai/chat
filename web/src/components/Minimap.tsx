import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { type Minimap as MinimapModel, shouldShowMinimap } from "../lib/minimap";

// Conversation minimap — a Sublime/VSCode-style scrubbable preview pinned to the right edge
// of the thread. Every block is a tiny readable excerpt of one message; the blocks STACK in
// natural DOM flow (each is exactly as tall as its own excerpt text), so consecutive blocks
// can never overlap and nothing is clipped. The stacked track is therefore usually TALLER
// than the visible strip, and it scrolls in PARALLAX with the thread — top-aligned at the top
// of the conversation, bottom-aligned at the bottom. A translucent viewport rectangle tracks
// what's on screen; click or drag the strip to scrub (it remaps through the parallax offset).
// Pure-presentational over the deterministic model from buildMinimap — it owns only the live
// scroll/viewport/parallax math and the DOM height measurement.

interface Props {
  model: MinimapModel;
  // Toggled on/off by the user. The strip stays mounted and slides in/out (so the exit
  // animates); defaults open so existing callers/tests keep their behavior.
  open?: boolean;
  // The scrolling thread container (the `.messages` element).
  scrollRef: React.RefObject<HTMLElement | null>;
  // Resolve a message index to its row element. The flow model no longer measures rows or
  // scrolls a specific row into view (the scrub maps a strip fraction straight onto the
  // thread's scrollHeight), so this is unused now — kept on the prop type so existing
  // callers/tests keep passing it without a signature change.
  getMessageEl?: (index: number) => HTMLElement | null;
  // Number of messages — drives the show/hide threshold.
  messageCount: number;
}

// One block on the track. In the flow model there is no per-block px geometry: the DOM sizes
// each block to its own excerpt text, so we only carry what we render (index, role, content
// kinds, text). The track's height is whatever the DOM makes it.
interface Layout {
  index: number;
  role: "user" | "assistant" | "system";
  kinds: MinimapModel["blocks"][number]["kinds"];
  // The cleaned excerpt, rendered as tiny readable text so the block reads like a shrunk
  // render of the message (the Sublime-minimap effect) instead of abstract hairlines.
  text: string;
}

// Pass the model's blocks through to the render list. No px heights are computed — the blocks
// flow in the track at height:auto, so the DOM (not JS) decides each block's height and the
// track's total. Kept as a tiny pure helper so the render stays declarative.
function layoutFromModel(model: MinimapModel): Layout[] {
  return model.blocks.map((b) => ({ index: b.index, role: b.role, kinds: b.kinds, text: b.text }));
}

export function Minimap({ model, scrollRef, messageCount, open = true }: Props) {
  const t = useT();
  const stripRef = useRef<HTMLButtonElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const layout = layoutFromModel(model);
  // The parallax track offset (px the track is translated UP) + the viewport rectangle, both
  // in STRIP pixel coords. Derived from the live scroll position and the MEASURED track/strip
  // heights. See updateFromScroll for the formulas.
  const [trackOffset, setTrackOffset] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 40 });
  const draggingRef = useRef(false);
  const rafRef = useRef(0);

  // The parallax + viewport math, from the thread's live scroll position. Given:
  //   S  = scrollTop, SH = scrollHeight, CH = clientHeight
  //   docOverflow   = SH - CH                  (how far the thread can scroll)
  //   P             = strip visible height     (measured from the strip's box)
  //   T             = track total height       (MEASURED from the flowed track's offsetHeight)
  //   trackOverflow = max(0, T - P)            (how far the track must travel)
  // We slave the track's travel to the doc's travel so the track is top-aligned at the top of
  // the conversation and bottom-aligned at the bottom:
  //   trackOffset = docOverflow > 0 ? (S / docOverflow) * trackOverflow : 0
  // The viewport rectangle is the slice of the track that's on screen, in track coords then
  // shifted into strip coords by the offset:
  //   vTopTrack = (S / SH) * T,  vH = (CH / SH) * T,  vTopStrip = vTopTrack - trackOffset
  // Endpoints: at S=0 → offset 0, vTop 0 (rect at strip top). At S=docOverflow → the track's
  // bottom sits at the strip bottom, and vTopStrip + vH = P (rect bottom at the strip bottom).
  // When T <= P (track fits) → trackOverflow 0, offset 0, and the rect just moves within the
  // full, static track. This is identical for a flowed track — it only reads the MEASURED T.
  const updateFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const T = trackRef.current?.offsetHeight || 1;
    const P = stripRef.current?.clientHeight || T;
    const SH = el.scrollHeight || 1;
    const CH = el.clientHeight;
    const S = el.scrollTop;
    const docOverflow = SH - CH;
    const trackOverflow = Math.max(0, T - P);
    const offset = docOverflow > 0 ? (S / docOverflow) * trackOverflow : 0;
    const vTopTrack = (S / SH) * T;
    const vH = (CH / SH) * T;
    setTrackOffset(offset);
    setViewport({ top: vTopTrack - offset, height: vH });
  }, [scrollRef]);

  // Track the parallax + viewport from the thread's live scroll, rAF-throttled so a fast
  // scroll never queues more than one update per frame. Re-runs when the thread changes (the
  // flowed track may have grown) and is torn down on unmount.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      updateFromScroll();
      return;
    }
    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        updateFromScroll();
      });
    };
    updateFromScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
    // Re-bind when the thread length changes (the track was re-flowed).
  }, [scrollRef, messageCount, updateFromScroll]);

  // Re-measure after the layout (block list) changes — a streamed/added message reflows the
  // track, which shifts the offset/viewport. Also re-measure on resize. We schedule on the
  // next frame so the DOM has laid the new blocks out before we read offsetHeight.
  useEffect(() => {
    const onResize = () => updateFromScroll();
    const id = requestAnimationFrame(updateFromScroll);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", onResize);
    };
  }, [updateFromScroll, model]);

  // Re-measure when the TRACK or STRIP changes rendered size. The hover-magnify widens the
  // strip (.minimap:hover), which REFLOWS the flowed track to a new (shorter) height — but the
  // parallax offset + viewport rect above are only recomputed on scroll/model/resize, NOT on
  // this hover reflow. Left stale, updateFromScroll's last `T` (the tall, narrow track) over-
  // translates the now-short, wide track and the strip looks empty/broken. A ResizeObserver on
  // both boxes recomputes the parallax against the LIVE measured sizes whenever either reflows
  // (the hover transition fires many size ticks; any future layout change is covered too). It's
  // rAF-debounced (so a transition can't queue more than one recompute per frame, and the
  // recompute that itself only reads sizes can't loop the observer), and torn down on unmount.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const track = trackRef.current;
    const strip = stripRef.current;
    if (!track && !strip) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateFromScroll();
      });
    });
    if (track) ro.observe(track);
    if (strip) ro.observe(strip);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [updateFromScroll]);

  // Scrub the thread from a pointer on the strip. The viewport rect's strip position is a
  // LINEAR function of the scroll: vTopStrip = S * k, with k = T/SH - trackOverflow/docOverflow
  // (see updateFromScroll). We INVERT that to drive the scroll directly from the pointer:
  //   S = (yStrip - grabOffset) / k
  // Two things this gets right that the old fraction map didn't: (1) no trackOffset in the
  // loop -- folding in the offset fed back through the very scroll we set and made the drag
  // drift; this k is constant during a drag. (2) grabOffset pins the point you grabbed under
  // the pointer, so dragging the rect tracks 1:1 instead of jumping. We read the strip's LIVE
  // rect so a hover-widened strip still lands. Instant while dragging; a click on empty track
  // jumps smoothly.
  const grabOffsetRef = useRef(0);
  const scrubTo = useCallback(
    (clientY: number, smooth: boolean) => {
      const strip = stripRef.current;
      const el = scrollRef.current;
      if (!strip || !el) return;
      const rect = strip.getBoundingClientRect();
      const T = trackRef.current?.offsetHeight || 1;
      const P = strip.clientHeight || T;
      const SH = el.scrollHeight || 1;
      const CH = el.clientHeight;
      const docOverflow = SH - CH;
      if (docOverflow <= 0) return;
      const trackOverflow = Math.max(0, T - P);
      const k = T / SH - trackOverflow / docOverflow;
      const yStrip = clientY - rect.top - grabOffsetRef.current;
      const S = Math.abs(k) > 1e-4 ? yStrip / k : (yStrip * SH) / T;
      const top = Math.min(Math.max(S, 0), docOverflow);
      // "instant" while dragging forces a direct, animation-free follow (ignores any CSS
      // scroll-behavior); a click on empty track gets a smooth jump.
      el.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
    },
    [scrollRef],
  );

  function onPointerDown(e: React.PointerEvent) {
    const strip = stripRef.current;
    if (!strip) return;
    draggingRef.current = true;
    strip.setPointerCapture(e.pointerId);
    // If the press lands ON the viewport rect, keep that exact point under the pointer (no
    // jump); if on empty track, center the rect on the press (a jump-to-here).
    const y0 = e.clientY - strip.getBoundingClientRect().top;
    const onRect = y0 >= viewport.top && y0 <= viewport.top + viewport.height;
    grabOffsetRef.current = onRect ? y0 - viewport.top : viewport.height / 2;
    scrubTo(e.clientY, !onRect);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!draggingRef.current) return;
    scrubTo(e.clientY, false);
  }
  function onPointerUp(e: React.PointerEvent) {
    draggingRef.current = false;
    stripRef.current?.releasePointerCapture(e.pointerId);
  }

  // Keyboard scrubbing for the focused strip: arrows nudge the viewport, Home/End jump.
  function onKeyDown(e: React.KeyboardEvent) {
    const el = scrollRef.current;
    if (!el) return;
    const page = el.clientHeight * 0.9;
    if (e.key === "ArrowDown" || e.key === "PageDown") {
      e.preventDefault();
      el.scrollBy({ top: page, behavior: "smooth" });
    } else if (e.key === "ArrowUp" || e.key === "PageUp") {
      e.preventDefault();
      el.scrollBy({ top: -page, behavior: "smooth" });
    } else if (e.key === "Home") {
      e.preventDefault();
      el.scrollTo({ top: 0, behavior: "smooth" });
    } else if (e.key === "End") {
      e.preventDefault();
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }

  if (!shouldShowMinimap(messageCount)) return null;

  return (
    <button
      ref={stripRef}
      type="button"
      className={`minimap ${open ? "minimap--open" : "minimap--closed"}`}
      aria-label={t("minimap.label")}
      title={t("minimap.scrub")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {/* The stacked content blocks in NATURAL DOM FLOW — each block is as tall as its own
          excerpt, so they can never overlap and nothing is clipped. The track is whatever
          height the DOM makes it (we MEASURE trackRef.offsetHeight as T) and usually overflows
          the strip. translateY scrolls it in parallax (clipped by the strip's overflow). */}
      <span
        ref={trackRef}
        className="minimap-track"
        aria-hidden="true"
        style={{ transform: `translateY(${-trackOffset}px)` }}
      >
        {layout.map((b) => (
          <span
            key={b.index}
            className={`minimap-block minimap-block--${b.role}`}
            data-mm-block={b.index}
          >
            {/* A code-bearing message keeps its tinted band as an inset BACKDROP behind the
                text (the block is position:relative); the excerpt already excludes code, so
                its intro prose renders as tiny text over the band — the Sublime-minimap
                effect. The block flows to fit the text, so the band stretches with it. */}
            {b.kinds.code > 0 && <span className="minimap-code" />}
            {b.text && <span className="minimap-text">{b.text}</span>}
            {/* Landmark glyphs at the block's top-right: a pin for a map, a code glyph for
                code, a file glyph for an attachment -- consistent markers you can scan for. */}
            {(b.kinds.landmarks > 0 || b.kinds.code > 0 || b.kinds.attachments > 0) && (
              <span className="minimap-marks" aria-hidden="true">
                {b.kinds.landmarks > 0 && (
                  <svg className="minimap-mark" viewBox="0 0 24 24">
                    <title>map</title>
                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" />
                  </svg>
                )}
                {b.kinds.code > 0 && (
                  <svg className="minimap-mark minimap-mark--stroke" viewBox="0 0 24 24">
                    <title>code</title>
                    <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
                  </svg>
                )}
                {b.kinds.attachments > 0 && (
                  <svg className="minimap-mark" viewBox="0 0 24 24">
                    <title>file</title>
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7z" />
                  </svg>
                )}
              </span>
            )}
          </span>
        ))}
      </span>
      {/* The draggable translucent viewport rectangle showing what's on screen, in STRIP px
          coords (it does NOT ride the track — the track moves under it). */}
      <span
        className="minimap-viewport"
        aria-hidden="true"
        style={{ top: `${viewport.top}px`, height: `${viewport.height}px` }}
      />
    </button>
  );
}

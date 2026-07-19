import { useEffect, useRef } from "react";

// An interactive dot-grid backdrop. A dim grid of dots fills the viewport; the
// dots near the pointer light up green and swell, brightest under the cursor and
// fading out with distance — a soft spotlight that follows the mouse. Each dot
// eases its own brightness toward its target, so highlighting and unhighlighting
// animate smoothly rather than snapping with the cursor.
export function DotGrid() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const cv: HTMLCanvasElement = canvas;
    const ctx: CanvasRenderingContext2D = context;

    // Layout / feel knobs.
    const GAP = 26; // px between dots
    const BASE_R = 0.7; // resting dot radius
    const PEAK_R = 1.7; // radius directly under the cursor
    const REACH = 150; // px radius of the cursor's influence
    const DOT_EASE = 0.16; // per-dot brightness easing (highlight/unhighlight)
    const DIM = "rgba(232,232,230,0.07)"; // resting dot color
    const GLOW: [number, number, number] = [45, 155, 100]; // #2d9b64 green

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let w = 0;
    let h = 0;
    let cols = 0;
    let rows = 0;
    // Per-dot brightness we render at, eased toward each dot's target each frame.
    let levels = new Float32Array(0);
    // Actual pointer target and the eased position we render at.
    const target = { x: -9999, y: -9999 };
    let px = -9999;
    let py = -9999;
    let intensity = 0; // 0 when pointer is away, eases to 1 while present
    let targetIntensity = 0;
    let raf = 0;
    let running = false;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.max(0, Math.ceil((w - GAP / 2) / GAP));
      rows = Math.max(0, Math.ceil((h - GAP / 2) / GAP));
      levels = new Float32Array(cols * rows);
      render(true); // snap to targets — geometry changed, nothing to animate from
    }

    // Draw the grid. When `snap` is true each dot jumps to its target brightness;
    // otherwise dots ease toward it so highlights fade in and out. Returns true
    // once every dot has settled on its target.
    function render(snap = false) {
      ctx.clearRect(0, 0, w, h);
      const reach2 = REACH * REACH;
      let settled = true;
      let i = 0;
      for (let ry = 0; ry < rows; ry++) {
        const y = GAP / 2 + ry * GAP;
        for (let rx = 0; rx < cols; rx++, i++) {
          const x = GAP / 2 + rx * GAP;
          const dx = x - px;
          const dy = y - py;
          const d2 = dx * dx + dy * dy;
          let goal = 0;
          if (intensity > 0.01 && d2 < reach2) {
            goal = (1 - Math.sqrt(d2) / REACH) * intensity;
            goal *= goal; // ease-in so the falloff is soft
          }
          let t = levels[i];
          if (snap) {
            t = goal;
          } else {
            t += (goal - t) * DOT_EASE;
            if (Math.abs(goal - t) > 0.002) settled = false;
            else t = goal;
          }
          levels[i] = t;
          const r = BASE_R + (PEAK_R - BASE_R) * t;
          if (t > 0.01) {
            ctx.fillStyle = `rgba(${GLOW[0]},${GLOW[1]},${GLOW[2]},${(0.12 + 0.8 * t).toFixed(3)})`;
          } else {
            ctx.fillStyle = DIM;
          }
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return settled;
    }

    function loop() {
      const ease = 0.18;
      px += (target.x - px) * ease;
      py += (target.y - py) * ease;
      intensity += (targetIntensity - intensity) * ease;
      const moved =
        Math.abs(target.x - px) < 0.5 &&
        Math.abs(target.y - py) < 0.5 &&
        Math.abs(targetIntensity - intensity) < 0.005;
      if (moved) {
        px = target.x;
        py = target.y;
        intensity = targetIntensity;
      }
      // Keep animating until both the cursor and every dot have settled.
      const dotsSettled = render();
      if (moved && dotsSettled) {
        running = false;
      } else {
        raf = requestAnimationFrame(loop);
      }
    }

    function kick() {
      if (reduceMotion) {
        // Snap straight to the target — no animated trailing.
        px = target.x;
        py = target.y;
        intensity = targetIntensity;
        render(true);
        return;
      }
      if (!running) {
        running = true;
        raf = requestAnimationFrame(loop);
      }
    }

    function onMove(e: PointerEvent) {
      target.x = e.clientX;
      target.y = e.clientY;
      targetIntensity = 1;
      kick();
    }
    function onLeave() {
      targetIntensity = 0;
      kick();
    }

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <canvas ref={ref} className="dot-grid" aria-hidden="true" />;
}

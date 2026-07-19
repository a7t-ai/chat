import { Suspense, useState } from "react";
import { MapDrawerSkeleton } from "../components/Skeleton";
import { capabilityById } from "./registry";

// Renders the active capability's drawer surface, fed the payloads opened this session.
// ChatView owns the open/close state and per-capability request lists.
//
// This component IS the stable drawer shell: one persistent, animated `<aside.cap-drawer>`
// that owns the chrome generic to any capability drawer — fixed position, the slide-in
// animation, the drag-to-resize width (persisted per-device), and the resizer handle. The
// capability's own content (which may be lazy-loaded — the map drawer pulls in a heavy
// MapLibre chunk) renders INSIDE this shell via <Suspense>. Keeping the aside stable means
// it mounts once, so `cap-slide-in` plays exactly once: the skeleton fallback and the
// resolved surface swap inside the same aside, with no second re-animation on chunk load.
export function CapabilitySurface({
  capId,
  requests,
  onClose,
}: {
  capId: string;
  requests: string[];
  onClose: () => void;
}) {
  // Drawer width (desktop), drag-resizable from the left edge and persisted per-device.
  // Hoisted here (not in the surface) so the animated shell owns it and survives the
  // skeleton -> surface swap. Declared before any early return to keep hook order stable.
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("a7t_chat_cap_width"));
    return saved >= 320 ? saved : 440;
  });

  function startResize(e: React.PointerEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    const move = (ev: PointerEvent) => {
      latest = Math.min(Math.max(startW + (startX - ev.clientX), 320), Math.round(window.innerWidth * 0.95));
      setWidth(latest);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      localStorage.setItem("a7t_chat_cap_width", String(latest));
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.body.style.userSelect = "none";
  }

  const cap = capabilityById(capId);
  if (!cap?.Surface) return null;
  const Surface = cap.Surface;
  // The fallback is the INNER content only (no second aside) so it swaps inside the stable
  // shell. The map has a bespoke skeleton; other caps get a plain loading line.
  const fallback = cap.id === "map" ? <MapDrawerSkeleton /> : <div className="cap-drawer-loading">Loading…</div>;
  return (
    <aside className="cap-drawer" aria-label={cap.surfaceLabel} style={{ ["--cap-w" as string]: `${width}px` }}>
      <div className="cap-drawer-resizer" onPointerDown={startResize} role="separator" aria-label="Resize panel" />
      <Suspense fallback={fallback}>
        <Surface requests={requests} onClose={onClose} width={width} />
      </Suspense>
    </aside>
  );
}

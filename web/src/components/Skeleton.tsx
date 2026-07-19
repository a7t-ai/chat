import { MapPin } from "lucide-react";

// Shimmering loading placeholders. The sidebar rows echo the brand mark — a
// rounded square (the logo's silhouette) beside a couple of stacked bars whose
// decreasing widths mirror the three lines inside the a7t.chat logo.

// Deterministic widths so rows look varied without re-shuffling on each render.
const TITLE_WIDTHS = ["82%", "64%", "73%", "55%", "78%", "60%"];
const META_WIDTHS = ["34%", "28%", "40%", "30%", "36%", "26%"];

export function ConvoListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="convo-list skeleton-list" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="skeleton-row">
          <span className="sk sk-mark" />
          <span className="skeleton-lines">
            <span className="sk sk-bar" style={{ width: TITLE_WIDTHS[i % TITLE_WIDTHS.length] }} />
            <span className="sk sk-bar sk-bar-sm" style={{ width: META_WIDTHS[i % META_WIDTHS.length] }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ThreadSkeleton() {
  return (
    <div className="thread-skeleton" aria-hidden="true">
      {[
        { side: "user", lines: 1 },
        { side: "assistant", lines: 3 },
        { side: "user", lines: 1 },
        { side: "assistant", lines: 2 },
      ].map((b, i) => (
        <div key={i} className={`msg ${b.side} skeleton-msg`}>
          <span className="sk sk-bar sk-bar-sm" style={{ width: "3rem" }} />
          {Array.from({ length: b.lines }).map((_, j) => (
            <span
              key={j}
              className="sk sk-bar"
              style={{ width: j === b.lines - 1 ? "45%" : "92%" }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// Fallback while the map drawer's code chunk (MapLibre) loads. Renders the INNER content of
// the shared drawer shell (CapabilitySurface owns the animated <aside>), so it swaps in place
// without a second slide-in: the same header bar, a shimmering map area, and a row of pin-pill
// placeholders. A fragment, NOT a second .cap-drawer.
export function MapDrawerSkeleton() {
  return (
    <>
      <header className="cap-drawer-head" aria-hidden="true">
        <span className="cap-drawer-title">
          <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
          Map
        </span>
        <span className="sk sk-icon" />
      </header>
      <div className="map-canvas map-skeleton" aria-hidden="true">
        <span className="sk map-skeleton-pin" />
      </div>
      <div className="map-pins" aria-hidden="true">
        {["5rem", "6.5rem", "4.5rem", "7rem"].map((w) => (
          <span key={w} className="sk map-skeleton-pill" style={{ width: w }} />
        ))}
      </div>
    </>
  );
}

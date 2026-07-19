import { MapPin, X } from "lucide-react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { FetchSource, PMTiles, Protocol } from "pmtiles";
import protomapsLayers from "protomaps-themes-base";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "../../../lib/api";
import { type GeoResult, geocode, rememberGeo } from "./api";

// Basemap: prefer the self-hosted Protomaps PMTiles archive (private/offline, served by
// our own backend with auth) and fall back to free hosted CARTO styles while the local
// archive is still downloading or absent.
const STYLE_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const STYLE_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const BASEMAP_REL = "/api/cap/map/basemap.pmtiles";
const GLYPHS = "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf";

function basemapUrl(): string {
  return new URL(BASEMAP_REL, location.href).toString();
}

// Register the pmtiles:// protocol once, wiring our auth header onto every range request
// (Bearer for guests; admin rides the Tailscale-injected header) so the archive stays
// behind the same gate as the rest of /api.
let protocolReady = false;
function ensureProtocol(): void {
  if (protocolReady) return;
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  protocol.add(new PMTiles(new FetchSource(basemapUrl(), new Headers(authHeaders()))));
  protocolReady = true;
}

function protomapsStyle(dark: boolean): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${basemapUrl()}`,
        attribution: '<a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a> © <a href="https://openstreetmap.org" target="_blank" rel="noreferrer">OpenStreetMap</a>',
      },
    },
    layers: protomapsLayers("protomaps", dark ? "dark" : "light", "en"),
  } as maplibregl.StyleSpecification;
}

// Pick the self-hosted Protomaps style if the archive is ready, else a hosted fallback.
async function resolveStyle(dark: boolean): Promise<string | maplibregl.StyleSpecification> {
  try {
    const r = await fetch("/api/cap/map/basemap-status", { headers: authHeaders() });
    if (r.ok && (await r.json()).ready) {
      ensureProtocol();
      return protomapsStyle(dark);
    }
  } catch {
    /* fall back below */
  }
  return dark ? STYLE_DARK : STYLE_LIGHT;
}

function flyTo(map: maplibregl.Map, geo: GeoResult): void {
  if (geo.bbox) {
    const [s, n, w, e] = geo.bbox; // Nominatim order: south, north, west, east
    map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 15, duration: 800 });
  } else {
    map.flyTo({ center: [geo.lng, geo.lat], zoom: 12, duration: 800 });
  }
}

// Frame all pins together (trip view); fall back to a single fly when there's just one.
function frameAll(map: maplibregl.Map, geos: GeoResult[]): void {
  if (geos.length === 1) return flyTo(map, geos[0]);
  const b = new maplibregl.LngLatBounds();
  for (const g of geos) b.extend([g.lng, g.lat]);
  map.fitBounds(b, { padding: 70, maxZoom: 14, duration: 800 });
}

// A numbered teal pin so a sequence of places reads as an ordered itinerary.
function numberedPin(n: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "map-pin-marker";
  el.textContent = String(n);
  return el;
}

// The locality segments shared by the resolved pins (e.g. "Paris, Île-de-France, France").
// A place name appears once (unique → dropped); the shared city/region/country recur, so
// they bubble up — giving a hint to disambiguate under-specified names the model emitted
// without a city (e.g. "Odéon Square" → "Odéon Square, Paris, …").
function regionHintFrom(geos: GeoResult[]): string {
  const freq = new Map<string, number>();
  for (const g of geos) {
    const segs = new Set(
      g.displayName
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !/^\d+$/.test(s)),
    );
    for (const s of segs) freq.set(s, (freq.get(s) ?? 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s]) => s)
    .join(", ");
}

// The maps canvas: an interactive map that accumulates a pin per opened [[map:…]] chip.
// Renders the INNER content of the shared drawer shell (CapabilitySurface owns the animated
// positioned <aside>, the width state, and the resizer) — so it returns a fragment, never a
// second .cap-drawer. `width` is threaded from the shell so the map can `resize()` when the
// drawer is dragged wider/narrower.
export function MapCanvas({ requests, onClose, width }: { requests: string[]; onClose: () => void; width?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const seen = useRef<Set<string>>(new Set());
  const pinIndex = useRef<Map<string, GeoResult>>(new Map());
  const [pins, setPins] = useState<{ payload: string; geo: GeoResult; num: number }[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  // The map is created asynchronously (we resolve which basemap to use first), so gate
  // pin-placement on this rather than mapRef alone.
  const [mapReady, setMapReady] = useState(false);

  // Keep the map filling the drawer as the shell is resized (the shell owns the width).
  useEffect(() => {
    mapRef.current?.resize();
  }, [width]);

  // Create the map once (async: decide self-hosted vs hosted basemap first). Hardened to be
  // StrictMode-safe (dev double-invokes effects: mount -> cleanup -> mount): never create two
  // maps, and always tear down whatever this pass created — including a map assigned AFTER its
  // own cleanup ran, which the `await` gap makes possible.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Re-entry guard: a live map already exists (belt-and-suspenders alongside the [] deps).
    if (mapRef.current) return;
    const dark = document.documentElement.dataset.mode === "dark";
    let cancelled = false;
    let created: maplibregl.Map | null = null;
    (async () => {
      const style = await resolveStyle(dark);
      // If cleanup already ran (cancelled), the container went away, or a map somehow exists,
      // bail before constructing a second map.
      if (cancelled || !containerRef.current || mapRef.current) return;
      const map = new maplibregl.Map({ container, style, center: [10, 48], zoom: 3 });
      created = map;
      // Defensive: if a cleanup raced in while constructing, tear this map down immediately
      // instead of leaking it.
      if (cancelled) {
        map.remove();
        created = null;
        return;
      }
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        readyRef.current = true;
      });
      mapRef.current = map;
      setMapReady(true);
    })();
    return () => {
      cancelled = true;
      readyRef.current = false;
      // Remove whichever map exists — the one on the ref, OR one created by a late async
      // assignment that lost the race with this cleanup.
      (mapRef.current ?? created)?.remove();
      created = null;
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Resolve + pin newly-requested places. Two passes: resolve directly, then retry the
  // misses with a region hint derived from what DID resolve (cached in localStorage, so a
  // refresh re-pins with no network).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let alive = true;
    (async () => {
      const addPin = (payload: string, geo: GeoResult) => {
        const num = pinIndex.current.size + 1;
        new maplibregl.Marker({ element: numberedPin(num), anchor: "bottom" })
          .setLngLat([geo.lng, geo.lat])
          .setPopup(new maplibregl.Popup({ offset: 24 }).setText(geo.displayName))
          .addTo(map);
        pinIndex.current.set(payload, geo);
        setPins((p) => [...p, { payload, geo, num }]);
      };

      const pending = requests.filter((p) => !seen.current.has(p));
      for (const p of pending) seen.current.add(p);
      if (pending.length === 0) return;
      setLoading(true);

      let last: GeoResult | null = null;
      const misses: string[] = [];
      // Pass 1: resolve as given.
      for (const payload of pending) {
        const geo = await geocode(payload);
        if (!alive) return;
        if (geo) {
          addPin(payload, geo);
          last = geo;
        } else {
          misses.push(payload);
        }
      }
      // Pass 2: retry misses with the shared-region hint.
      const hint = regionHintFrom([...pinIndex.current.values()]);
      for (const payload of misses) {
        const geo =
          hint && !payload.toLowerCase().includes(hint.toLowerCase()) ? await geocode(`${payload}, ${hint}`) : null;
        if (!alive) return;
        if (geo) {
          rememberGeo(payload, geo); // future refreshes resolve the original name directly
          addPin(payload, geo);
          last = geo;
        } else {
          setFailed((f) => (f.includes(payload) ? f : [...f, payload]));
        }
      }

      if (alive) {
        setLoading(false);
        if (last) frameAll(map, [...pinIndex.current.values()]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [requests, mapReady]);

  function focus(geo: GeoResult): void {
    if (mapRef.current) flyTo(mapRef.current, geo);
  }

  // Header status: progress while geocoding several places, else a simple "Locating…".
  const total = requests.length;
  const statusLabel = loading ? (total > 1 ? `${pins.length} of ${total} loaded` : "Locating…") : "";

  return (
    <>
      <header className="cap-drawer-head">
        <span className="cap-drawer-title">
          <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
          Map{statusLabel ? ` · ${statusLabel}` : ""}
        </span>
        <button type="button" className="cap-drawer-close" onClick={onClose} aria-label="Close map">
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div ref={containerRef} className="map-canvas" />
      {(pins.length > 0 || failed.length > 0) && (
        <div className="map-pins">
          {pins.map((p) => (
            <button type="button" key={p.payload} className="map-pin" onClick={() => focus(p.geo)} title={p.geo.displayName}>
              <span className="map-pin-num" aria-hidden="true">
                {p.num}
              </span>
              {p.payload.split(",")[0].trim()}
            </button>
          ))}
          {failed.map((q) => (
            <a
              key={q}
              className="map-pin failed"
              href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Couldn't place this — search OpenStreetMap"
            >
              {q.split(",")[0].trim()} ?
            </a>
          ))}
        </div>
      )}
    </>
  );
}

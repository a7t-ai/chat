import { authHeaders } from "../../../lib/api";

export interface GeoResult {
  query: string;
  lat: number;
  lng: number;
  bbox: [number, number, number, number] | null; // [south, north, west, east]
  displayName: string;
}

// Per-device geocode cache in localStorage: once a place resolves, a refresh re-pins it
// instantly with NO network call. Successes are kept indefinitely; failures are kept only
// briefly (so a refresh doesn't re-hit the server for known-bad names, but they can still
// recover later — e.g. once a region hint lets them resolve).
const PREFIX = "a7t_geo_";
const FAIL_TTL = 6 * 60 * 60 * 1000; // 6h

function key(q: string): string {
  return PREFIX + q.trim().toLowerCase();
}

// undefined = cache miss; null = cached failure (still fresh); GeoResult = cached hit.
function readCache(q: string): GeoResult | null | undefined {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key(q));
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const e = JSON.parse(raw) as { ok: boolean; geo?: GeoResult; t?: number };
    if (e.ok && e.geo) return e.geo;
    if (!e.ok && typeof e.t === "number" && Date.now() - e.t < FAIL_TTL) return null;
    return undefined; // expired failure → re-fetch
  } catch {
    return undefined;
  }
}

function writeCache(q: string, geo: GeoResult | null): void {
  try {
    localStorage.setItem(key(q), JSON.stringify(geo ? { ok: true, geo } : { ok: false, t: Date.now() }));
  } catch {
    /* quota / private mode — just skip caching */
  }
}

// Store a resolution under a query that didn't resolve directly (e.g. it only worked once
// a region hint was appended), so future refreshes resolve the original name with no call.
export function rememberGeo(q: string, geo: GeoResult): void {
  writeCache(q, geo);
}

// Resolve a place name to coordinates — localStorage first, then the maps route.
export async function geocode(q: string): Promise<GeoResult | null> {
  const cached = readCache(q);
  if (cached !== undefined) return cached; // hit (GeoResult) or fresh failure (null)
  const res = await fetch(`/api/cap/map/geo?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
  if (!res.ok) {
    writeCache(q, null);
    return null;
  }
  const geo = (await res.json()) as GeoResult;
  writeCache(q, geo);
  return geo;
}

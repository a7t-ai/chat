import { eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { geocache } from "../../../db/schema.ts";

// Hard cap on cached geocode rows. The maps geocode route is reachable with NO credential (it
// powers the no-login shared-page map), so a hostile client could stream endless unique queries
// and grow this table without bound. This caps it; each successful cache write prunes back to
// the newest GEOCACHE_MAX_ROWS. Generous — normal use is far below it — so it's a safety valve,
// not something ordinary caching brushes against.
const GEOCACHE_MAX_ROWS = 50000;

// Geocoding for the maps capability: place name -> coordinates, via OSM Nominatim,
// cached in SQLite so a repeat lookup is free + instant and we stay within Nominatim's
// usage policy (1 req/s, identify with a User-Agent). The cache is the cost control:
// nothing external is hit twice for the same query.

export interface GeoResult {
  query: string;
  lat: number;
  lng: number;
  bbox: [number, number, number, number] | null; // [south, north, west, east] (Nominatim order)
  displayName: string;
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const UA = "a7t.chat/1.0 (self-hosted personal assistant; leo@a7t.ai)";

// Serialize external calls and keep >=1s between them (Nominatim etiquette). Cache hits
// bypass this entirely, so normal use rarely waits.
//
// Bounded pending queue: `/api/cap/map/geo` is a public (no-login) carve-out, so the >=1s
// serialization is etiquette, NOT abuse protection — a flood of unique cache-miss queries would
// otherwise pile up unboundedly behind the chain (memory) and starve legit callers behind the
// attacker queue, on top of the per-IP handler cap. So we cap the queued+in-flight external
// calls: over the cap a call resolves to `null` FAST (a clean "not found", never a throw) instead
// of enqueuing. This bounds the pending surface even under distributed (many-IP) abuse. Calls that
// DO run still keep the >=1s spacing.
const MAX_PENDING_GEOCODES = 8;
let pending = 0;
let chain: Promise<unknown> = Promise.resolve();
let lastHit = 0;
function throttle<T>(fn: () => Promise<T>): Promise<T | null> {
  if (pending >= MAX_PENDING_GEOCODES) return Promise.resolve(null);
  pending += 1;
  const run = chain.then(async () => {
    const wait = 1000 - (Date.now() - lastHit);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastHit = Date.now();
    }
  });
  chain = run.catch(() => {});
  // Free the slot whether the run settles or rejects; the chain stays alive via `.catch` above.
  void run.then(
    () => {
      pending -= 1;
    },
    () => {
      pending -= 1;
    },
  );
  return run as Promise<T | null>;
}

// Test-only: reset the serialized throttle state (pending counter + chain + spacing clock) so a
// test that intentionally fills the pending queue doesn't leak backpressure into later tests.
// Never called in production.
export function __resetGeocodeThrottle(): void {
  pending = 0;
  chain = Promise.resolve();
  lastHit = 0;
}

// Evict the oldest rows so the cache keeps at most `cap` entries (FIFO by created_at). A single
// DELETE keeps only the newest `cap` queries. Best-effort and self-contained: a failure here
// (or an over-cap table) must NEVER throw into the request path, mirroring the cache insert's
// posture. A no-op while the table is at or under the cap.
export function pruneGeocache(cap = GEOCACHE_MAX_ROWS): void {
  try {
    db.delete(geocache)
      .where(sql`${geocache.query} NOT IN (SELECT query FROM geocache ORDER BY created_at DESC LIMIT ${cap})`)
      .run();
  } catch {
    /* best-effort cap; never surface into the geocode response */
  }
}

function fromRow(r: typeof geocache.$inferSelect): GeoResult {
  return {
    query: r.query,
    lat: r.lat,
    lng: r.lng,
    bbox: r.bbox ? (JSON.parse(r.bbox) as [number, number, number, number]) : null,
    displayName: r.displayName,
  };
}

interface NominatimItem {
  lat: string;
  lon: string;
  display_name: string;
  boundingbox?: [string, string, string, string];
}

// One throttled Nominatim lookup for a query string.
async function lookup(q: string): Promise<NominatimItem | null> {
  return throttle(async () => {
    const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=jsonv2&limit=1&addressdetails=0`;
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
    if (!res.ok) return null;
    const arr = (await res.json()) as NominatimItem[];
    return arr[0] ?? null;
  });
}

export async function geocode(rawQuery: string): Promise<GeoResult | null> {
  const query = rawQuery.trim().slice(0, 200);
  if (!query) return null;
  const key = query.toLowerCase();

  const cached = db.select().from(geocache).where(eq(geocache.query, key)).get();
  if (cached) return fromRow(cached);

  // Try the name as given; if it doesn't resolve, retry with parentheticals stripped
  // (e.g. "Time Out Market (Mercado da Ribeira)" -> "Time Out Market"), which the
  // geocoder handles far better.
  let result = await lookup(query);
  if (!result) {
    const simplified = query.replace(/\s*\([^)]*\)/g, "").trim();
    if (simplified && simplified !== query) result = await lookup(simplified);
  }
  if (!result) return null;

  const bbox: [number, number, number, number] | null = result.boundingbox
    ? [
        Number(result.boundingbox[0]),
        Number(result.boundingbox[1]),
        Number(result.boundingbox[2]),
        Number(result.boundingbox[3]),
      ]
    : null;
  const geo: GeoResult = {
    query: key,
    lat: Number(result.lat),
    lng: Number(result.lon),
    bbox,
    displayName: result.display_name,
  };

  // Cache for next time (best-effort; a race just means a redundant insert attempt).
  try {
    db.insert(geocache)
      .values({ query: key, lat: geo.lat, lng: geo.lng, bbox: bbox ? JSON.stringify(bbox) : null, displayName: geo.displayName })
      .onConflictDoNothing()
      .run();
    // Keep the (publicly reachable) cache bounded. No-op under the cap; its own try/catch means
    // an eviction hiccup never fails the geocode we just resolved.
    pruneGeocache();
  } catch {
    /* ignore cache write races */
  }
  return geo;
}

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../../../__tests__/localStorage";
import { geocode, type GeoResult, rememberGeo } from "./api";

const PREFIX = "a7t_geo_";
const FAIL_TTL = 6 * 60 * 60 * 1000; // 6h — mirror of the module constant

const GEO: GeoResult = {
  query: "Lisbon",
  lat: 38.7,
  lng: -9.1,
  bbox: [38.6, 38.8, -9.2, -9.0],
  displayName: "Lisbon, Portugal",
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function cacheKey(q: string): string {
  return PREFIX + q.trim().toLowerCase();
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installLocalStorage();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("geocode — cache miss then network", () => {
  test("hits the maps route, returns the geo, and caches it", async () => {
    fetchMock.mockResolvedValue(jsonRes(GEO));
    const out = await geocode("Lisbon");
    expect(out).toEqual(GEO);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/cap/map/geo?q=Lisbon");
    // success was persisted under the normalized key
    const raw = localStorage.getItem(cacheKey("Lisbon"));
    expect(raw && JSON.parse(raw)).toEqual({ ok: true, geo: GEO });
  });

  test("encodes the query and normalizes the cache key (trim + lowercase)", async () => {
    fetchMock.mockResolvedValue(jsonRes(GEO));
    await geocode("  São Paulo, BR  ");
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/cap/map/geo?q=${encodeURIComponent("  São Paulo, BR  ")}`);
    expect(localStorage.getItem(cacheKey("são paulo, br"))).toBeTruthy();
  });
});

describe("geocode — cache hit (no network)", () => {
  test("reuses a cached success with no fetch call", async () => {
    fetchMock.mockResolvedValue(jsonRes(GEO));
    const first = await geocode("Lisbon");
    fetchMock.mockClear();
    const second = await geocode("Lisbon");
    expect(second).toEqual(first);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a differently-cased/padded query resolves from the same cache entry", async () => {
    fetchMock.mockResolvedValue(jsonRes(GEO));
    await geocode("Lisbon");
    fetchMock.mockClear();
    const out = await geocode("  LISBON  ");
    expect(out).toEqual(GEO);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("geocode — failure caching with TTL", () => {
  test("a server error caches a fresh failure (returns null, no re-fetch within TTL)", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "not found" }, 404));
    const out = await geocode("Nowheresville");
    expect(out).toBeNull();
    const raw = localStorage.getItem(cacheKey("Nowheresville"));
    const entry = raw && JSON.parse(raw);
    expect(entry.ok).toBe(false);
    expect(typeof entry.t).toBe("number");

    // A second call within the TTL must NOT hit the network.
    fetchMock.mockClear();
    expect(await geocode("Nowheresville")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an expired failure re-fetches (and can recover)", async () => {
    // Hand-write a stale failure entry (timestamp older than the TTL).
    localStorage.setItem(cacheKey("Faded"), JSON.stringify({ ok: false, t: Date.now() - FAIL_TTL - 1000 }));
    fetchMock.mockResolvedValue(jsonRes(GEO));
    const out = await geocode("Faded");
    expect(out).toEqual(GEO);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // recovery is now cached as a success
    const raw = localStorage.getItem(cacheKey("Faded"));
    expect(raw && JSON.parse(raw)).toEqual({ ok: true, geo: GEO });
  });
});

describe("geocode — corrupt / unreadable cache", () => {
  test("treats unparseable JSON as a miss and re-fetches", async () => {
    localStorage.setItem(cacheKey("Garbage"), "{not json");
    fetchMock.mockResolvedValue(jsonRes(GEO));
    const out = await geocode("Garbage");
    expect(out).toEqual(GEO);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a success entry missing its geo is treated as a miss", async () => {
    localStorage.setItem(cacheKey("Half"), JSON.stringify({ ok: true }));
    fetchMock.mockResolvedValue(jsonRes(GEO));
    const out = await geocode("Half");
    expect(out).toEqual(GEO);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("rememberGeo", () => {
  test("stores a resolution so a later geocode of that query needs no network", async () => {
    rememberGeo("Belém Tower", GEO);
    const out = await geocode("Belém Tower");
    expect(out).toEqual(GEO);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

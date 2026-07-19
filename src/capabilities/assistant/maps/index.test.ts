import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../../config.ts";
import { db } from "../../../db/index.ts";
import { geocache } from "../../../db/schema.ts";
import { geoRateOk, maps } from "./index.ts";

// The maps capability descriptor + its Hono routes. We drive the route sub-app directly
// via `routes.request(...)` (Hono's built-in test entry) and stub fetch so the /geo path
// exercises geocode without touching Nominatim.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function nominatim(items: unknown[], status = 200): Response {
  return new Response(JSON.stringify(items), { status, headers: { "content-type": "application/json" } });
}

const item = {
  lat: "38.7169",
  lon: "-9.1399",
  display_name: "Lisbon, Portugal",
  boundingbox: ["38.6", "38.8", "-9.3", "-9.0"],
};

describe("maps capability descriptor", () => {
  test("has the contract fields the registry/server depend on", () => {
    expect(maps.id).toBe("map");
    expect(maps.title).toBe("Maps");
    expect(maps.pillar).toBe("assistant");
    expect(maps.enabled).toBe(true);
    expect(typeof maps.systemPrompt).toBe("function");
    expect(maps.routes).toBeDefined();
  });
});

describe("maps.systemPrompt", () => {
  test("teaches the inline marker and the itinerary rules", () => {
    const p = maps.systemPrompt!();
    expect(p).toContain("[[map:Place name, City, Country]]");
    // The conservative-in-chat + mark-every-stop guidance is the load-bearing instruction.
    expect(p).toContain("mark EACH stop");
    expect(p).toContain("São Jorge Castle, Lisbon, Portugal");
    // The "one clean geocodable name, no parentheses" rule (mirrors geocode's retry).
    expect(p).toContain("no parentheses");
  });
});

describe("GET /geo", () => {
  test("400 when q is missing or blank", async () => {
    const res1 = await maps.routes!.request("/geo");
    expect(res1.status).toBe(400);
    const res2 = await maps.routes!.request("/geo?q=%20%20");
    expect(res2.status).toBe(400);
    expect(await res2.json()).toEqual({ error: "missing q" });
  });

  test("200 with the geocoded result on a hit", async () => {
    globalThis.fetch = (async () => nominatim([item])) as unknown as typeof fetch;
    const q = `lisbon-geo-route-${Math.random()}`;
    const res = await maps.routes!.request(`/geo?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      lat: 38.7169,
      lng: -9.1399,
      bbox: [38.6, 38.8, -9.3, -9.0],
      displayName: "Lisbon, Portugal",
    });
  });

  test("404 when geocode finds nothing", async () => {
    globalThis.fetch = (async () => nominatim([])) as unknown as typeof fetch;
    const q = `nowhere-route-${Math.random()}`;
    const res = await maps.routes!.request(`/geo?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("429 once a caller passes the per-IP limit; a different IP has its own bucket", async () => {
    // Cache the query so every request is a hit — the rate limit is the only gate (no network).
    const q = `rl-hit-${Math.random()}`;
    db.insert(geocache)
      .values({ query: q.toLowerCase(), lat: 1, lng: 2, bbox: null, displayName: "RL" })
      .run();
    // `cf-connecting-ip` is what trustedClientIp keys on (present => "via the edge"), so it's how
    // we inject a distinct caller per test — no shared bucket with the other /geo tests.
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const limit = config.geoRateLimitPerMin;
    for (let i = 0; i < limit; i++) {
      const ok = await maps.routes!.request(`/geo?q=${encodeURIComponent(q)}`, { headers: { "cf-connecting-ip": ip } });
      expect(ok.status).toBe(200);
    }
    // One past the limit within the same window -> 429, before any geocode work.
    const blocked = await maps.routes!.request(`/geo?q=${encodeURIComponent(q)}`, { headers: { "cf-connecting-ip": ip } });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate limited" });
    // A different caller is unaffected (per-IP, not global).
    const other = await maps.routes!.request(`/geo?q=${encodeURIComponent(q)}`, { headers: { "cf-connecting-ip": "198.51.100.7" } });
    expect(other.status).toBe(200);
  });
});

// geoRateOk is the exact predicate the /geo handler applies. `now` is injectable, so the
// per-caller sliding window is fully deterministic (no real clock).
describe("geoRateOk (per-caller window)", () => {
  test("allows up to the limit within a window, blocks over it, then resets", () => {
    const ip = `unit-${Math.random()}`; // unique bucket, isolated from other tests
    const t0 = 5_000_000;
    const limit = config.geoRateLimitPerMin;
    for (let i = 0; i < limit; i++) expect(geoRateOk(ip, t0)).toBe(true);
    expect(geoRateOk(ip, t0)).toBe(false); // at the cap within the minute
    expect(geoRateOk(ip, t0 + 61_000)).toBe(true); // the window elapsed -> reset
  });
});

describe("GET /basemap-status", () => {
  test("reports not ready when the PMTiles file is absent in the test data dir", async () => {
    const res = await maps.routes!.request("/basemap-status");
    expect(res.status).toBe(200);
    // The temp test env has no basemap.pmtiles, so this is the deterministic branch.
    expect(await res.json()).toEqual({ ready: false });
  });
});

describe("GET /basemap.pmtiles", () => {
  test("503 when the basemap archive is not present", async () => {
    const res = await maps.routes!.request("/basemap.pmtiles");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "basemap not ready" });
  });
});

// The PMTiles serving + Range-request branches only run when the file EXISTS. Rather than
// drop a multi-MB fixture into the real data dir, monkeypatch Bun.file to return a
// Blob-backed fake (Blob supplies .size/.slice and is a valid Response body) for the
// basemap path only — every other Bun.file call passes through.
describe("GET /basemap.pmtiles (present)", () => {
  const realBunFile = Bun.file;
  const SIZE = 2_000_000; // > the 1MB readiness floor
  const fakeBody = new Uint8Array(SIZE).fill(7);

  function fakeFile() {
    const blob = new Blob([fakeBody], { type: "application/octet-stream" });
    return Object.assign(blob, { exists: async () => true });
  }

  afterEach(() => {
    (Bun as unknown as { file: typeof Bun.file }).file = realBunFile;
  });
  function patchBunFile() {
    (Bun as unknown as { file: (p: string) => unknown }).file = ((p: string) =>
      String(p).endsWith("basemap.pmtiles") ? fakeFile() : realBunFile(p)) as typeof Bun.file;
  }

  test("basemap-status reports ready when present and over the size floor", async () => {
    patchBunFile();
    const res = await maps.routes!.request("/basemap-status");
    expect(await res.json()).toEqual({ ready: true });
  });

  test("serves the whole archive (200) with Accept-Ranges + Content-Length", async () => {
    patchBunFile();
    const res = await maps.routes!.request("/basemap.pmtiles");
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe(String(SIZE));
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  test("serves a 206 partial slice for a valid Range header", async () => {
    patchBunFile();
    const res = await maps.routes!.request("/basemap.pmtiles", {
      headers: { range: "bytes=0-99" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-99/${SIZE}`);
    expect(res.headers.get("Content-Length")).toBe("100");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(100);
  });

  test("open-ended Range (bytes=N-) serves to the end of the file", async () => {
    patchBunFile();
    const start = SIZE - 50;
    const res = await maps.routes!.request("/basemap.pmtiles", {
      headers: { range: `bytes=${start}-` },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes ${start}-${SIZE - 1}/${SIZE}`);
    expect(res.headers.get("Content-Length")).toBe("50");
  });

  test("an unsatisfiable Range (start past end) falls back to the full 200 response", async () => {
    patchBunFile();
    // start > end -> the `start <= end` guard fails -> full file served.
    const res = await maps.routes!.request("/basemap.pmtiles", {
      headers: { range: `bytes=${SIZE + 10}-${SIZE + 20}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(SIZE));
  });

  test("a malformed Range header (no bytes= match) falls back to the full 200 response", async () => {
    patchBunFile();
    const res = await maps.routes!.request("/basemap.pmtiles", {
      headers: { range: "garbage" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(SIZE));
  });
});

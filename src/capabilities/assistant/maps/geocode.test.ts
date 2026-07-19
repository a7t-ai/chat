import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../../../db/index.ts";
import { geocache } from "../../../db/schema.ts";
import { __resetGeocodeThrottle, geocode, pruneGeocache } from "./geocode.ts";

// geocode = Nominatim lookup + SQLite cache + parenthetical-strip retry + throttle. All
// external calls are stubbed; the DB is the isolated temp file from setup.ts. We assert
// real behavior: cache hit (no fetch), cache miss (fetch + write), retry-on-miss, and the
// trivial guards.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  // The throttle chain + pending counter are module-level; reset so one test's fills/waits never
  // leak backpressure (or a stale >=1s spacing clock) into the next.
  __resetGeocodeThrottle();
});

// A Nominatim search response: an array with (at most) one item.
function nominatimResponse(items: unknown[]): Response {
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const sampleItem = {
  lat: "38.7169",
  lon: "-9.1399",
  display_name: "Lisbon, Portugal",
  boundingbox: ["38.6", "38.8", "-9.3", "-9.0"],
};

describe("geocode guards", () => {
  test("empty / whitespace query returns null without any fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return nominatimResponse([sampleItem]);
    }) as unknown as typeof fetch;
    expect(await geocode("   ")).toBeNull();
    expect(await geocode("")).toBeNull();
    expect(called).toBe(false);
  });
});

describe("geocode cache hit", () => {
  test("a pre-seeded row is returned verbatim, parsing bbox, with no fetch", async () => {
    const key = `lisbon-cached-${Math.random()}`;
    db.insert(geocache)
      .values({
        query: key,
        lat: 38.7169,
        lng: -9.1399,
        bbox: JSON.stringify([38.6, 38.8, -9.3, -9.0]),
        displayName: "Lisbon, Portugal (cached)",
      })
      .run();

    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return nominatimResponse([sampleItem]);
    }) as unknown as typeof fetch;

    // Mixed case + surrounding space -> normalized to the lowercased key on lookup.
    const got = await geocode(`  ${key.toUpperCase()}  `);
    expect(called).toBe(false); // cache bypassed the network entirely
    expect(got).toEqual({
      query: key,
      lat: 38.7169,
      lng: -9.1399,
      bbox: [38.6, 38.8, -9.3, -9.0],
      displayName: "Lisbon, Portugal (cached)",
    });
  });

  test("a cached row with null bbox round-trips bbox as null", async () => {
    const key = `nobbox-${Math.random()}`;
    db.insert(geocache)
      .values({ query: key, lat: 1, lng: 2, bbox: null, displayName: "Nowhere" })
      .run();
    const got = await geocode(key);
    expect(got?.bbox).toBeNull();
  });
});

describe("geocode cache miss", () => {
  test("fetches Nominatim, returns the parsed result, and writes the cache", async () => {
    const key = `porto-${Math.random()}`;
    let calls = 0;
    let lastUrl = "";
    globalThis.fetch = (async (url: string) => {
      calls += 1;
      lastUrl = String(url);
      return nominatimResponse([sampleItem]);
    }) as unknown as typeof fetch;

    const got = await geocode(key);
    expect(calls).toBe(1);
    expect(lastUrl).toContain("nominatim.openstreetmap.org/search");
    expect(lastUrl).toContain(`q=${encodeURIComponent(key)}`);
    expect(got).toEqual({
      query: key.toLowerCase(),
      lat: 38.7169,
      lng: -9.1399,
      bbox: [38.6, 38.8, -9.3, -9.0],
      displayName: "Lisbon, Portugal",
    });

    // The result was persisted, so a second call is a cache hit (no further fetch).
    const row = db.select().from(geocache).where(eq(geocache.query, key.toLowerCase())).get();
    expect(row?.displayName).toBe("Lisbon, Portugal");

    globalThis.fetch = (async () => {
      throw new Error("should not fetch on cache hit");
    }) as unknown as typeof fetch;
    const again = await geocode(key);
    expect(again?.displayName).toBe("Lisbon, Portugal");
  });

  test("an item without boundingbox yields bbox null", async () => {
    const key = `nobb-fetch-${Math.random()}`;
    globalThis.fetch = (async () =>
      nominatimResponse([{ lat: "10", lon: "20", display_name: "Plain Place" }])) as unknown as typeof fetch;
    const got = await geocode(key);
    expect(got).toMatchObject({ lat: 10, lng: 20, bbox: null, displayName: "Plain Place" });
  });

  test("a non-2xx Nominatim response resolves to null (no cache write)", async () => {
    const key = `boom-${Math.random()}`;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await geocode(key)).toBeNull();
    const row = db.select().from(geocache).where(eq(geocache.query, key.toLowerCase())).get();
    expect(row).toBeUndefined();
  });

  test("an empty Nominatim result array (no parenthetical to strip) -> null", async () => {
    const key = `empty-${Math.random()}`;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return nominatimResponse([]);
    }) as unknown as typeof fetch;
    expect(await geocode(key)).toBeNull();
    // No parentheses in the query, so no retry: exactly one lookup.
    expect(calls).toBe(1);
  });
});

describe("geocode throttle resilience", () => {
  test("a rejecting fetch propagates as a rejection but the throttle chain recovers", async () => {
    const key = `network-fail-${Math.random()}`;
    let mode: "reject" | "ok" = "reject";
    globalThis.fetch = (async () => {
      if (mode === "reject") throw new Error("network down");
      return nominatimResponse([sampleItem]);
    }) as unknown as typeof fetch;

    // The first lookup rejects; geocode has no try/catch around lookup, so it rejects too.
    // This exercises throttle's `chain.catch(() => {})` (keeps the serialized chain alive).
    await expect(geocode(key)).rejects.toThrow("network down");

    // The chain survived the rejection: a subsequent lookup proceeds normally.
    mode = "ok";
    const got = await geocode(`recovered-${Math.random()}`);
    expect(got).toMatchObject({ displayName: "Lisbon, Portugal" });
  });
});

describe("geocode parenthetical-strip retry", () => {
  test("retries with parentheticals removed when the original misses", async () => {
    const key = `Time Out Market (Mercado da Ribeira)-${Math.random()}`;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = new URL(String(url));
      const q = u.searchParams.get("q") ?? "";
      seen.push(q);
      // First (full) query misses; the simplified retry hits.
      if (q.includes("(")) return nominatimResponse([]);
      return nominatimResponse([sampleItem]);
    }) as unknown as typeof fetch;

    const got = await geocode(key);
    expect(seen.length).toBe(2); // original miss + simplified retry
    expect(seen[0]).toContain("(Mercado da Ribeira)");
    expect(seen[1]).not.toContain("("); // parenthetical stripped on retry
    expect(seen[1]).toContain("Time Out Market");
    expect(got).toMatchObject({ displayName: "Lisbon, Portugal" });
    // Cached under the ORIGINAL (lowercased) query key, not the simplified one.
    const row = db.select().from(geocache).where(eq(geocache.query, key.toLowerCase())).get();
    expect(row).toBeDefined();
  });

  test("both the original and the simplified retry miss -> null", async () => {
    const key = `Ghost Venue (Closed)-${Math.random()}`;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return nominatimResponse([]);
    }) as unknown as typeof fetch;
    expect(await geocode(key)).toBeNull();
    expect(calls).toBe(2); // tried both
  });
});

// The geocode route is public (no-login), so the serialized outbound chain must not queue
// without bound: past a cap a new external lookup is refused FAST (resolves null, never throws,
// never hits the network) instead of piling up pending waiters.
describe("geocode pending-queue cap", () => {
  test("an over-cap lookup resolves null without hitting the network", async () => {
    // A fetch stub that NEVER resolves — so any call that actually reaches the network hangs.
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Promise<Response>(() => {}); // hangs forever
    }) as unknown as typeof fetch;

    // Fire enough unique (cache-miss) lookups to fill the pending queue. Each increments the
    // pending counter synchronously (before its first await), so the queue is full before we yield.
    const filling: Array<Promise<unknown>> = [];
    for (let i = 0; i < 8; i++) filling.push(geocode(`fill-${i}-${Math.random()}`));

    // Synchronously, no fetch has fired yet (all the throttle work is queued microtasks).
    const before = fetchCalls;
    const over = geocode(`over-cap-${Math.random()}`); // 9th — past MAX_PENDING_GEOCODES
    expect(fetchCalls).toBe(before); // the 9th added no network request…
    expect(await over).toBeNull(); // …and is refused with a clean null (the hung fetch would never resolve)

    // Reset so the 8 hung lookups don't leak a full queue into the next test (afterEach also does).
    __resetGeocodeThrottle();
    void filling;
  });
});

// The geocode route is a no-login (public) carve-out for the shared-page map, so the cache must
// not grow without bound on endless unique anonymous queries. pruneGeocache caps it FIFO.
describe("pruneGeocache — bounding the publicly-reachable cache", () => {
  // Seed n rows with strictly increasing created_at so the newest/oldest order is deterministic.
  function seed(n: number, prefix: string): void {
    for (let i = 0; i < n; i++) {
      db.insert(geocache)
        .values({
          query: `${prefix}-${i}`,
          lat: i,
          lng: i,
          bbox: null,
          displayName: `place ${i}`,
          createdAt: new Date(1_700_000_000_000 + i * 1000),
        })
        .run();
    }
  }

  test("keeps only the newest `cap` rows, evicting the oldest (FIFO by created_at)", () => {
    db.delete(geocache).run(); // take full control of the table for a precise assertion
    seed(5, "prune"); // prune-0 (oldest) .. prune-4 (newest)
    pruneGeocache(3);
    const kept = db
      .select()
      .from(geocache)
      .all()
      .map((r) => r.query)
      .sort();
    expect(kept).toEqual(["prune-2", "prune-3", "prune-4"]); // the two oldest were evicted
  });

  test("is a no-op when the row count is at or under the cap", () => {
    db.delete(geocache).run();
    seed(2, "under");
    pruneGeocache(5); // under cap
    expect(db.select().from(geocache).all().length).toBe(2);
    pruneGeocache(2); // exactly at cap
    expect(db.select().from(geocache).all().length).toBe(2);
  });
});

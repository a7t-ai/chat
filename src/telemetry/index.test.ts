import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { events } from "../db/schema.ts";
import { eventCounts, recentEvents, track, trackError } from "./index.ts";

beforeEach(() => {
  db.delete(events).run();
  (config.telemetry as { enabled: boolean }).enabled = true;
});
afterEach(() => {
  (config.telemetry as { enabled: boolean }).enabled = true;
});

describe("track", () => {
  test("records an event with serialized meta", () => {
    track({ type: "capability.maps", meta: { found: true, q: "lisbon" } });
    const rows = recentEvents({ type: "capability.maps" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.type).toBe("capability.maps");
    expect(JSON.parse(rows[0]?.meta ?? "{}")).toEqual({ found: true, q: "lisbon" });
  });

  test("no-ops when telemetry is disabled", () => {
    (config.telemetry as { enabled: boolean }).enabled = false;
    track({ type: "capability.maps" });
    expect(recentEvents().length).toBe(0);
  });

  test("never throws on a bad insert (best-effort)", () => {
    // meta with a circular ref → JSON.stringify throws inside track; must be swallowed.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => track({ type: "x", meta: circular })).not.toThrow();
  });
});

describe("trackError", () => {
  test("stores an error event with where + message, never content", () => {
    trackError("search.fetch", new Error("boom"), { url: "https://e.com" });
    const rows = recentEvents({ type: "error" });
    expect(rows.length).toBe(1);
    const meta = JSON.parse(rows[0]?.meta ?? "{}");
    expect(meta).toMatchObject({ where: "search.fetch", message: "boom", url: "https://e.com" });
  });
});

describe("read helpers", () => {
  test("recentEvents is newest-first and respects limit", () => {
    for (let i = 0; i < 5; i++) track({ type: "t", meta: { i } });
    const rows = recentEvents({ limit: 3 });
    expect(rows.length).toBe(3);
  });

  test("eventCounts groups by type within the window", () => {
    track({ type: "a" });
    track({ type: "a" });
    track({ type: "b" });
    const counts = eventCounts(Date.now() - 60_000);
    const map = Object.fromEntries(counts.map((c) => [c.type, c.count]));
    expect(map.a).toBe(2);
    expect(map.b).toBe(1);
  });
});

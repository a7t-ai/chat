import { describe, expect, test } from "bun:test";
import { allowRequest } from "./ratelimit.ts";

// `now` is injectable, so the sliding window is fully deterministic. Unique ids per test
// avoid sharing the module-level window map.
describe("allowRequest (sliding window)", () => {
  test("allows up to maxPerMin, then blocks", () => {
    const id = `r-${Math.random()}`;
    const now = 1_000_000;
    expect(allowRequest(id, 2, now)).toBe(true);
    expect(allowRequest(id, 2, now)).toBe(true);
    expect(allowRequest(id, 2, now)).toBe(false); // at cap within the minute
  });

  test("entries older than 60s drop out of the window", () => {
    const id = `r-${Math.random()}`;
    const t0 = 1_000_000;
    expect(allowRequest(id, 1, t0)).toBe(true);
    expect(allowRequest(id, 1, t0 + 30_000)).toBe(false); // still inside the window
    expect(allowRequest(id, 1, t0 + 61_000)).toBe(true); // the old hit expired
  });

  test("maxPerMin <= 0 means unlimited", () => {
    const id = `r-${Math.random()}`;
    for (let i = 0; i < 50; i++) expect(allowRequest(id, 0, 1)).toBe(true);
  });
});

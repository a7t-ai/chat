import { describe, expect, test } from "bun:test";
import { SETUP_CATALOG, hfResolveUrl, setupModelById } from "./catalog.ts";

// The catalog is data, but it feeds downloads and DEFAULT_MODEL, so pin its invariants: unique ids,
// sane sizes, and a well-formed HF path. A typo here would 404 a user's download.

describe("SETUP_CATALOG", () => {
  test("is non-empty", () => {
    expect(SETUP_CATALOG.length).toBeGreaterThan(0);
  });

  test("every id is unique", () => {
    const ids = SETUP_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every entry has positive sizes and a sensible budget", () => {
    for (const m of SETUP_CATALOG) {
      expect(m.sizeGB).toBeGreaterThan(0);
      expect(m.minBudgetGB).toBeGreaterThan(0);
      // A model must be smaller than the memory it is meant to run in.
      expect(m.sizeGB).toBeLessThan(m.minBudgetGB);
      expect(m.hfRepo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(m.ggufFile).toMatch(/\.gguf$/i);
    }
  });

  test("setupModelById finds a known model and misses an unknown one", () => {
    expect(setupModelById("qwen-omni")?.label).toContain("Qwen3-Omni");
    expect(setupModelById("nope")).toBeUndefined();
  });

  test("hfResolveUrl builds the direct download link", () => {
    const m = SETUP_CATALOG[0]!;
    expect(hfResolveUrl(m)).toBe(`https://huggingface.co/${m.hfRepo}/resolve/main/${m.ggufFile}`);
  });
});

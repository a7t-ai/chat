import { describe, expect, test } from "bun:test";
import type { SetupModel } from "./catalog.ts";
import { budgetFor, parseLinuxDfGb, parseMacDfGb, parseNvidiaSmiGb, recommend } from "./recommend.ts";

describe("budgetFor", () => {
  test("prefers discrete VRAM when present", () => {
    expect(budgetFor({ ramGB: 128, vramGB: 24 })).toBe(24);
  });
  test("falls back to unified/system RAM when there is no VRAM", () => {
    expect(budgetFor({ ramGB: 48, vramGB: null })).toBe(48);
  });
});

describe("recommend", () => {
  test("an 8 GB machine gets the smallest model (and nothing that won't fit)", () => {
    const r = recommend({ ramGB: 8, vramGB: null, diskFreeGB: 200 });
    expect(r.map((m) => m.id)).toEqual(["qwen3.5-4b"]);
  });

  test("a 48 GB Apple Silicon machine gets the biggest fit first", () => {
    const r = recommend({ ramGB: 48, vramGB: null, diskFreeGB: 500 });
    // 35B-A3B (22.1 GB) fits under 60% of 48 (28.8) and is the largest that does; Omni (18.6) fits too.
    // 70B (43 GB) needs a 64 GB budget, so it is excluded.
    expect(r[0]?.id).toBe("qwen3.6-35b-a3b");
    expect(r.map((m) => m.id)).toContain("qwen-omni");
    expect(r.map((m) => m.id)).not.toContain("llama3.3-70b");
  });

  test("results are sorted largest-that-fits first", () => {
    const r = recommend({ ramGB: 128, vramGB: null, diskFreeGB: 500 });
    const sizes = r.map((m) => m.sizeGB);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(r[0]?.id).toBe("llama3.3-70b");
  });

  test("a tiny disk excludes models that won't fit with headroom", () => {
    // 8 GB RAM would allow the 4B (2.7 GB), but only 6 GB free disk can't hold 2.7 + 5.
    expect(recommend({ ramGB: 8, vramGB: null, diskFreeGB: 6 })).toEqual([]);
  });

  test("a discrete 24 GB GPU budgets off VRAM, not the 128 GB of system RAM", () => {
    const r = recommend({ ramGB: 128, vramGB: 24, diskFreeGB: 500 });
    // Budget 24: Omni (18.6) exceeds 60% of 24 (14.4); the 9B (5.7) is the largest that fits.
    expect(r[0]?.id).toBe("qwen3.5-9b");
  });

  test("ranks a custom (live HF) catalog instead of the static fallback", () => {
    const live: SetupModel[] = [
      { id: "small", label: "Small", hfRepo: "o/Small-GGUF", ggufFile: "s.gguf", quant: "Q4_K_M", sizeGB: 4, minBudgetGB: 8 },
      { id: "big", label: "Big", hfRepo: "o/Big-GGUF", ggufFile: "b.gguf", quant: "Q4_K_M", sizeGB: 12, minBudgetGB: 20 },
    ];
    const r = recommend({ ramGB: 32, vramGB: null, diskFreeGB: 500 }, live);
    // Neither id is in the static catalog, so this proves the live list was ranked; largest-fit first.
    expect(r.map((m) => m.id)).toEqual(["big", "small"]);
  });
});

describe("parseMacDfGb", () => {
  test("reads the Available column of `df -g`", () => {
    const out = [
      "Filesystem   1G-blocks  Used  Available Capacity  iused    ifree %iused  Mounted on",
      "/dev/disk3s5      1000   400        590      41%  123456  7890123    2%   /",
    ].join("\n");
    expect(parseMacDfGb(out)).toBe(590);
  });
  test("returns 0 on garbage", () => {
    expect(parseMacDfGb("")).toBe(0);
    expect(parseMacDfGb("only a header line")).toBe(0);
  });
});

describe("parseLinuxDfGb", () => {
  test("reads `df -BG --output=avail` and strips the G", () => {
    expect(parseLinuxDfGb("Avail\n 590G\n")).toBe(590);
  });
  test("returns 0 on garbage", () => {
    expect(parseLinuxDfGb("")).toBe(0);
  });
});

describe("parseNvidiaSmiGb", () => {
  test("converts total MiB to whole GB", () => {
    expect(parseNvidiaSmiGb("24576")).toBe(24); // 24576 MiB = 24 GB
    expect(parseNvidiaSmiGb("40960\n")).toBe(40);
  });
  test("returns null when there is no GPU / no parseable figure", () => {
    expect(parseNvidiaSmiGb("")).toBeNull();
    expect(parseNvidiaSmiGb("No devices were found")).toBeNull();
    expect(parseNvidiaSmiGb("0")).toBeNull();
  });
});

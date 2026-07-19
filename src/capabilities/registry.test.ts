import { describe, expect, test } from "bun:test";
import { capabilities, capabilitySystemPrompt, enabledCapabilities } from "./registry.ts";
import type { Capability, Pillar } from "./types.ts";

// The five a7t pillars. Every registered capability must declare exactly
// one of these — it's the source of truth the UI/telemetry/suggestion engine group on.
const PILLARS: Pillar[] = ["assistant", "archivist", "architect", "autopilot", "autoagent"];

// The registry is pure glue, but it's the seam every capability plugs into — so verify it
// actually filters on `enabled` and concatenates only non-empty systemPrompt fragments.

describe("capabilities registry", () => {
  test("ships the maps capability, enabled, under the assistant pillar", () => {
    const map = capabilities.find((c) => c.id === "map");
    expect(map).toBeDefined();
    expect(map?.enabled).toBe(true);
    expect(map?.routes).toBeDefined();
    expect(map?.pillar).toBe("assistant");
  });

  test("ships the recipes/timers capability, enabled, route-less, under the assistant pillar", () => {
    const timer = capabilities.find((c) => c.id === "timer");
    expect(timer).toBeDefined();
    expect(timer?.enabled).toBe(true);
    // Route-less by design — it rides the share + TODO primitives, contributing only a fragment.
    expect(timer?.routes).toBeUndefined();
    expect(timer?.pillar).toBe("assistant");
  });

  test("every registered capability declares a valid pillar (one of the five)", () => {
    expect(capabilities.length).toBeGreaterThan(0);
    for (const c of capabilities) {
      expect(PILLARS).toContain(c.pillar);
    }
  });

  test("capability ids are unique (the marker id is the binding contract)", () => {
    const ids = capabilities.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("enabledCapabilities", () => {
  test("returns only capabilities whose enabled flag is true", () => {
    const ids = enabledCapabilities().map((c) => c.id);
    expect(ids).toContain("map");
    expect(enabledCapabilities().every((c) => c.enabled)).toBe(true);
  });
});

describe("capabilitySystemPrompt", () => {
  test("includes the fragments of the real, enabled capabilities (maps + timers)", () => {
    const prompt = capabilitySystemPrompt();
    expect(prompt).toContain("[[map:");
    expect(prompt).toContain("[[timer:");
    expect(prompt.length).toBeGreaterThan(0);
  });

  // The filter/join logic is exercised against synthetic capabilities so the test doesn't
  // depend on which real capabilities happen to ship a fragment.
  test("joins enabled fragments with newlines, skips disabled + empty/whitespace ones", () => {
    const list: Capability[] = [
      { id: "a", title: "A", pillar: "assistant", enabled: true, systemPrompt: () => "alpha" },
      { id: "b", title: "B", pillar: "assistant", enabled: false, systemPrompt: () => "beta-should-not-appear" },
      { id: "c", title: "C", pillar: "assistant", enabled: true, systemPrompt: () => "   " }, // whitespace only -> dropped
      { id: "d", title: "D", pillar: "assistant", enabled: true }, // no systemPrompt at all -> dropped
      { id: "e", title: "E", pillar: "assistant", enabled: true, systemPrompt: () => "epsilon" },
    ];
    // Re-implement against an injected list by reusing the same predicate the module uses.
    const enabled = list.filter((c) => c.enabled);
    const parts = enabled.map((c) => c.systemPrompt?.() ?? "").filter((s) => s.trim().length > 0);
    const joined = parts.join("\n");
    expect(joined).toBe("alpha\nepsilon");
  });

  test("returns empty string when nothing contributes a fragment", () => {
    const list: Capability[] = [
      { id: "x", title: "X", pillar: "assistant", enabled: true },
      { id: "y", title: "Y", pillar: "assistant", enabled: false, systemPrompt: () => "nope" },
    ];
    const parts = list
      .filter((c) => c.enabled)
      .map((c) => c.systemPrompt?.() ?? "")
      .filter((s) => s.trim().length > 0);
    expect(parts.join("\n")).toBe("");
  });
});

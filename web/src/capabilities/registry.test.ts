import { describe, expect, test } from "vitest";
import { capabilityById, clientCapabilities } from "./registry";

// The client registry is the single place a marker id resolves to its chip/surface. These
// lock the maps entry's presence + that lookup returns undefined (not throws) for unknowns,
// which is what lets CapabilityMarker fall back to plain text for a stray id.

describe("clientCapabilities", () => {
  test("registers the maps capability under the assistant pillar", () => {
    const map = clientCapabilities.find((c) => c.id === "map");
    expect(map).toBeDefined();
    expect(map?.pillar).toBe("assistant");
  });

  test("registers the recipes/timers capability, chip-only, under the assistant pillar", () => {
    const timer = clientCapabilities.find((c) => c.id === "timer");
    expect(timer).toBeDefined();
    expect(timer?.pillar).toBe("assistant");
    // Chip-only: an inline countdown, so no drawer Surface and no bulk action.
    expect(timer?.Surface).toBeUndefined();
    expect(timer?.bulkActionLabel).toBeUndefined();
  });

  test("every registered capability has an id and a Chip", () => {
    for (const c of clientCapabilities) {
      expect(typeof c.id).toBe("string");
      expect(c.Chip).toBeTruthy();
    }
  });

  test("capability ids are unique (a marker id resolves to exactly one chip)", () => {
    const ids = clientCapabilities.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("capabilityById", () => {
  test("resolves a known id", () => {
    const cap = capabilityById("map");
    expect(cap?.id).toBe("map");
    expect(cap?.Surface).toBeTruthy();
    expect(cap?.bulkActionLabel?.(3)).toBe("Show all 3 places on the map");
  });

  test("returns undefined for an unknown id", () => {
    expect(capabilityById("nope")).toBeUndefined();
  });
});

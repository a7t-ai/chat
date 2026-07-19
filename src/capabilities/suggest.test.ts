import { describe, expect, test } from "bun:test";
import type { AuthContext } from "../auth/middleware.ts";
import type { User } from "../db/schema.ts";
import { activeSuggestions } from "./suggest.ts";
import type { Capability } from "./types.ts";

// Minimal auth contexts — the capability `entitled` predicates we exercise only read `role`.
// (The real maps/timer caps are open to everyone, so role doesn't change their outcome; the
// synthetic-list assertions below cover the entitlement branch directly.)
function admin(): AuthContext {
  return { role: "admin", via: "owner", user: { plan: "free" } as User, key: null } as unknown as AuthContext;
}

describe("activeSuggestions (the #22 engine)", () => {
  test("includes the real maps + timer nudges (both enabled, open to everyone)", () => {
    const hints = activeSuggestions(admin());
    const ids = hints.map((h) => h.id);
    expect(ids).toContain("map");
    expect(ids).toContain("timer");
  });

  test("each hint carries a marker id, human copy, and a non-empty trigger list", () => {
    for (const h of activeSuggestions(admin())) {
      expect(h.id.length).toBeGreaterThan(0);
      expect(h.title.trim().length).toBeGreaterThan(0);
      expect(h.body.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(h.triggers)).toBe(true);
      expect(h.triggers.length).toBeGreaterThan(0);
      // Triggers are OUR strings — every one should be a non-blank keyword/phrase.
      expect(h.triggers.every((t) => typeof t === "string" && t.trim().length > 0)).toBe(true);
    }
  });

  test("the wire hint never leaks the marker payload format (copy only, no `[[`)", () => {
    for (const h of activeSuggestions(admin())) {
      expect(h.title).not.toContain("[[");
      expect(h.body).not.toContain("[[");
    }
  });

  // The filter branches are exercised against a synthetic list so the assertions don't depend on
  // which real capabilities happen to ship (or gate) a suggestion.
  test("skips capabilities without a suggestion, and honors the entitlement predicate", () => {
    const caps: Capability[] = [
      { id: "open", title: "Open", pillar: "assistant", enabled: true, suggestion: { title: "T", body: "B", triggers: ["k"] } },
      { id: "nosug", title: "No suggestion", pillar: "assistant", enabled: true },
      {
        id: "gated",
        title: "Gated",
        pillar: "assistant",
        enabled: true,
        entitled: () => false, // caller not entitled -> excluded (never nudge toward a wall)
        suggestion: { title: "T2", body: "B2", triggers: ["k2"] },
      },
      {
        id: "entitled",
        title: "Entitled",
        pillar: "assistant",
        enabled: true,
        entitled: () => true, // predicate present AND true -> included
        suggestion: { title: "T3", body: "B3", triggers: ["k3"] },
      },
    ];
    const ids = activeSuggestions(admin(), caps).map((h) => h.id);
    expect(ids).toEqual(["open", "entitled"]);
  });

  test("returns an empty list when nothing declares a suggestion", () => {
    const caps: Capability[] = [{ id: "x", title: "X", pillar: "assistant", enabled: true }];
    expect(activeSuggestions(admin(), caps)).toEqual([]);
  });
});

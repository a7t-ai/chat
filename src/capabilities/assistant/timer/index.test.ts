import { describe, expect, test } from "bun:test";
import { timer } from "./index.ts";

// The recipes/timers capability descriptor + its system-prompt fragment. This capability is
// route-less by design (it rides the share + TODO primitives), so the important surface to lock
// is the descriptor shape server.ts/registry depend on and the marker contract the client mirrors.

describe("recipes/timers capability descriptor", () => {
  test("has the contract fields the registry/server depend on", () => {
    expect(timer.id).toBe("timer");
    expect(timer.title).toBe("Recipes & timers");
    expect(timer.pillar).toBe("assistant");
    expect(timer.enabled).toBe(true);
    expect(typeof timer.systemPrompt).toBe("function");
  });

  test("ships no routes — it's the thin, primitive-riding capability", () => {
    // A route-less capability is a first-class shape; server.ts's mount loop skips it.
    expect(timer.routes).toBeUndefined();
  });

  test("is free to everyone (no entitlement gate)", () => {
    expect(timer.entitled).toBeUndefined();
    expect(timer.gate).toBeUndefined();
  });
});

describe("recipes/timers systemPrompt", () => {
  test("teaches the timer marker format and the shopping-list convention", () => {
    const p = timer.systemPrompt!();
    // The marker contract that binds the server fragment to the client renderer.
    expect(p).toContain("[[timer:DURATION|LABEL]]");
    // The shopping list must be a GFM task list — that's what makes it tick-able + shareable.
    expect(p).toContain("- [ ]");
    expect(p).toContain("Shopping list");
    // The conservative-outside-recipes guardrail is the load-bearing instruction.
    expect(p.toLowerCase()).toContain("only add a timer to a genuinely timed step");
    // A concrete example so a smaller local model has a pattern to copy.
    expect(p).toContain("[[timer:25m|Bake]]");
  });
});

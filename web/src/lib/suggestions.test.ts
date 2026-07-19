import { afterEach, describe, expect, test, vi } from "vitest";
import type { SuggestionHint } from "./api";
import { loadDismissed, matchSuggestion, persistDismissed } from "./suggestions";

const mapHint: SuggestionHint = {
  id: "map",
  title: "See it on a map",
  body: "Ask about a place or trip.",
  triggers: ["itinerary", "road trip", "directions to"],
};
const timerHint: SuggestionHint = {
  id: "timer",
  title: "Cook along with timers",
  body: "Ask for a recipe.",
  triggers: ["recipe"],
};

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("matchSuggestion", () => {
  const base = { hints: [mapHint, timerHint], dismissed: new Set<string>() };

  test("matches a single-word trigger on a word boundary", () => {
    const r = matchSuggestion({ ...base, contextText: "Give me a recipe for lasagna", assistantText: "" });
    expect(r?.id).toBe("timer");
  });

  test("matches a multi-word phrase trigger", () => {
    const r = matchSuggestion({ ...base, contextText: "Plan a road trip up the coast", assistantText: "" });
    expect(r?.id).toBe("map");
  });

  test("does NOT match a trigger that only appears as a substring inside another word", () => {
    // "map" is NOT a trigger, but verify the boundary logic: "recipe" must not fire on "recipes"?
    // (it should — plural is a boundary at the end). Use a clear negative: "itinerary" inside a word.
    const r = matchSuggestion({ ...base, contextText: "the shipitinerarylike blob", assistantText: "" });
    expect(r).toBeNull();
  });

  test("matches a plural/adjacent-punctuation form via the non-alphanumeric boundary", () => {
    const r = matchSuggestion({ ...base, contextText: "Compare these itineraries.", assistantText: "" });
    // "itinerary" won't match "itineraries" (different stem) — assert the boundary still works on
    // an exact word followed by punctuation instead:
    expect(r).toBeNull();
    const r2 = matchSuggestion({ ...base, contextText: "Here is the itinerary.", assistantText: "" });
    expect(r2?.id).toBe("map");
  });

  test("returns the FIRST matching hint in order (never stacks)", () => {
    const r = matchSuggestion({
      ...base,
      contextText: "an itinerary and a recipe together",
      assistantText: "",
    });
    expect(r?.id).toBe("map"); // map comes first in the hint list
  });

  test("suppresses a hint whose marker already appears in the reply", () => {
    const r = matchSuggestion({
      ...base,
      contextText: "Plan a Lisbon itinerary",
      assistantText: "Visit [[map:Alfama, Lisbon, Portugal]] in the morning.",
    });
    expect(r).toBeNull();
  });

  test("suppresses a dismissed hint (falls through to the next match)", () => {
    const r = matchSuggestion({
      hints: [mapHint, timerHint],
      dismissed: new Set(["map"]),
      contextText: "an itinerary and a recipe",
      assistantText: "",
    });
    expect(r?.id).toBe("timer");
  });

  test("returns null when nothing matches", () => {
    const r = matchSuggestion({ ...base, contextText: "explain quantum tunneling", assistantText: "" });
    expect(r).toBeNull();
  });

  test("returns null for empty/whitespace context", () => {
    expect(matchSuggestion({ ...base, contextText: "   ", assistantText: "" })).toBeNull();
  });

  test("ignores a blank trigger entry without throwing", () => {
    const junk: SuggestionHint = { id: "junk", title: "T", body: "B", triggers: ["   ", ""] };
    expect(matchSuggestion({ hints: [junk], dismissed: new Set(), contextText: "anything at all", assistantText: "" })).toBeNull();
  });

  test("matching is case-insensitive", () => {
    const r = matchSuggestion({ ...base, contextText: "GIVE ME A RECIPE", assistantText: "" });
    expect(r?.id).toBe("timer");
  });

  test("a regex-metacharacter trigger is matched literally (no ReDoS / accidental pattern)", () => {
    const weird: SuggestionHint = { id: "w", title: "T", body: "B", triggers: ["c++"] };
    const hit = matchSuggestion({ hints: [weird], dismissed: new Set(), contextText: "I love c++ a lot", assistantText: "" });
    expect(hit?.id).toBe("w");
    const miss = matchSuggestion({ hints: [weird], dismissed: new Set(), contextText: "I love cxx", assistantText: "" });
    expect(miss).toBeNull();
  });
});

describe("dismissal persistence", () => {
  test("loadDismissed returns an empty set when nothing is stored", () => {
    expect(loadDismissed().size).toBe(0);
  });

  test("persist then load round-trips the id set", () => {
    persistDismissed(new Set(["map", "timer"]));
    const loaded = loadDismissed();
    expect(loaded.has("map")).toBe(true);
    expect(loaded.has("timer")).toBe(true);
    expect(loaded.size).toBe(2);
  });

  test("loadDismissed tolerates corrupt JSON (degrades to empty)", () => {
    localStorage.setItem("a7t_suggest_dismissed", "{not json");
    expect(loadDismissed().size).toBe(0);
  });

  test("loadDismissed ignores a non-array payload and filters non-string members", () => {
    localStorage.setItem("a7t_suggest_dismissed", JSON.stringify({ nope: true }));
    expect(loadDismissed().size).toBe(0);
    localStorage.setItem("a7t_suggest_dismissed", JSON.stringify(["map", 42, null, "timer"]));
    const loaded = loadDismissed();
    expect([...loaded].sort()).toEqual(["map", "timer"]);
  });

  test("loadDismissed swallows a throwing localStorage.getItem", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadDismissed().size).toBe(0);
  });

  test("persistDismissed swallows a throwing localStorage.setItem (safe no-op)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => persistDismissed(new Set(["map"]))).not.toThrow();
  });
});

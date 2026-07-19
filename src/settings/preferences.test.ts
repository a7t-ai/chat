import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFERENCES,
  EXTRA_MAX,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  mergePreferences,
  NAME_MAX,
  normalizePreferences,
  parseStoredPreferences,
  personaSystemPrompt,
  serializePreferences,
  TRAIT_MAX,
  TRAITS_MAX,
} from "./preferences.ts";

// preferences.ts is the security/robustness boundary for the Customize feature (#11): every
// value that reaches the DB and the model's system prompt passes through normalizePreferences.
// These tests pin the bounds (string caps, enum whitelist, number clamps, trait cap/dedup) and
// the persona-prompt rendering.

describe("normalizePreferences", () => {
  test("null / undefined / non-object → the full defaults", () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences("nope")).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences(42)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences([1, 2])).toEqual(DEFAULT_PREFERENCES);
  });

  test("trims and length-caps persona strings", () => {
    const p = normalizePreferences({
      persona: { name: "  Leo  ", role: "x".repeat(500), extra: "y".repeat(5000) },
    });
    expect(p.persona.name).toBe("Leo");
    expect(p.persona.role.length).toBe(NAME_MAX); // role shares the 80-cap
    expect(p.persona.extra.length).toBe(EXTRA_MAX);
  });

  test("non-string persona fields collapse to empty", () => {
    const p = normalizePreferences({ persona: { name: 123, role: null, extra: {} } });
    expect(p.persona).toMatchObject({ name: "", role: "", extra: "" });
  });

  test("traits: trims, drops empties, caps length, de-dupes case-insensitively, caps count", () => {
    const p = normalizePreferences({
      persona: {
        traits: ["  friendly ", "friendly", "FRIENDLY", "", "   ", 7, "z".repeat(200)],
      },
    });
    expect(p.persona.traits).toEqual(["friendly", "z".repeat(TRAIT_MAX)]);
  });

  test("traits count is capped at TRAITS_MAX", () => {
    const many = Array.from({ length: TRAITS_MAX + 5 }, (_, i) => `t${i}`);
    const p = normalizePreferences({ persona: { traits: many } });
    expect(p.persona.traits.length).toBe(TRAITS_MAX);
  });

  test("non-array traits → []", () => {
    expect(normalizePreferences({ persona: { traits: "friendly" } }).persona.traits).toEqual([]);
  });

  test("a hostile huge traits array is scan-bounded (no O(n) walk) and still capped", () => {
    // A front-loaded array of blanks then real traits well past the 200 scan window: the
    // reals beyond the window are never reached, and the output is capped either way.
    const huge = Array.from({ length: 1_000_000 }, () => "").concat(["friendly", "witty"]);
    const p = normalizePreferences({ persona: { traits: huge } });
    expect(p.persona.traits.length).toBeLessThanOrEqual(TRAITS_MAX);
    expect(p.persona.traits).toEqual([]); // all reals sit past the scan window
  });

  test("enum fields fall back to default on unknown value", () => {
    const p = normalizePreferences({
      visual: { mainFont: "wingdings", codeFont: "papyrus", density: "spacious" },
    });
    expect(p.visual).toEqual(DEFAULT_PREFERENCES.visual);
  });

  test("enum fields keep valid values", () => {
    const p = normalizePreferences({ visual: { mainFont: "serif", codeFont: "system", density: "compact" } });
    expect(p.visual).toEqual({ mainFont: "serif", codeFont: "system", density: "compact" });
  });

  test("fontScale clamps into [min,max]; non-finite → default", () => {
    expect(normalizePreferences({ accessibility: { fontScale: 99 } }).accessibility.fontScale).toBe(FONT_SCALE_MAX);
    expect(normalizePreferences({ accessibility: { fontScale: 0.1 } }).accessibility.fontScale).toBe(FONT_SCALE_MIN);
    expect(normalizePreferences({ accessibility: { fontScale: 1.2 } }).accessibility.fontScale).toBe(1.2);
    expect(normalizePreferences({ accessibility: { fontScale: Number.NaN } }).accessibility.fontScale).toBe(1);
    expect(normalizePreferences({ accessibility: { fontScale: Infinity } }).accessibility.fontScale).toBe(1);
    expect(normalizePreferences({ accessibility: { fontScale: "1.3" } }).accessibility.fontScale).toBe(1);
  });

  test("booleans coerce: non-boolean → the field default", () => {
    const p = normalizePreferences({
      behavior: { enterToSend: "yes" },
      accessibility: { reducedMotion: 1, highContrast: false, dyslexiaFont: true },
    });
    expect(p.behavior.enterToSend).toBe(true); // default (non-bool ignored)
    expect(p.accessibility.reducedMotion).toBe(false); // default (1 is not a bool)
    expect(p.accessibility.highContrast).toBe(false);
    expect(p.accessibility.dyslexiaFont).toBe(true);
  });

  test("timerSound defaults on and coerces a non-boolean back to the default", () => {
    expect(normalizePreferences(undefined).behavior.timerSound).toBe(true);
    expect(normalizePreferences({ behavior: { timerSound: "off" } }).behavior.timerSound).toBe(true);
    expect(normalizePreferences({ behavior: { timerSound: false } }).behavior.timerSound).toBe(false);
  });

  test("a valid full object round-trips unchanged", () => {
    const valid = {
      persona: { name: "Leo", role: "engineer", traits: ["concise"], extra: "loves TS" },
      behavior: { enterToSend: false, timerSound: false },
      visual: { mainFont: "serif" as const, codeFont: "system" as const, density: "compact" as const },
      accessibility: { fontScale: 1.1, reducedMotion: true, highContrast: true, dyslexiaFont: false },
      memory: { enabled: false },
    };
    expect(normalizePreferences(valid)).toEqual(valid);
  });

  test("memory defaults on and coerces a non-boolean back to the default", () => {
    expect(normalizePreferences(undefined).memory.enabled).toBe(true);
    expect(normalizePreferences({ memory: { enabled: "no" } }).memory.enabled).toBe(true);
    expect(normalizePreferences({ memory: { enabled: false } }).memory.enabled).toBe(false);
  });

  test("does not mutate its input", () => {
    const input = { persona: { traits: ["a", "a"] } };
    normalizePreferences(input);
    expect(input.persona.traits).toEqual(["a", "a"]);
  });
});

describe("mergePreferences", () => {
  test("a partial section patch overlays only that section", () => {
    const base = normalizePreferences({
      persona: { name: "Leo" },
      visual: { density: "compact" },
    });
    const merged = mergePreferences(base, { persona: { role: "engineer" } });
    expect(merged.persona.name).toBe("Leo"); // preserved
    expect(merged.persona.role).toBe("engineer"); // patched
    expect(merged.visual.density).toBe("compact"); // untouched section preserved
  });

  test("an empty / non-object patch leaves the base intact (still normalized)", () => {
    const base = normalizePreferences({ persona: { name: "Leo" } });
    expect(mergePreferences(base, {})).toEqual(base);
    expect(mergePreferences(base, null)).toEqual(base);
    expect(mergePreferences(base, "junk")).toEqual(base);
  });

  test("a malicious oversized patch is bounded by the merge", () => {
    const merged = mergePreferences(DEFAULT_PREFERENCES, { persona: { name: "x".repeat(9999) } });
    expect(merged.persona.name.length).toBe(NAME_MAX);
  });
});

describe("parseStoredPreferences", () => {
  test("null / empty → defaults", () => {
    expect(parseStoredPreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parseStoredPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(parseStoredPreferences("")).toEqual(DEFAULT_PREFERENCES);
  });

  test("corrupt JSON → defaults (never throws)", () => {
    expect(parseStoredPreferences("{not json")).toEqual(DEFAULT_PREFERENCES);
  });

  test("valid stored JSON round-trips through normalization", () => {
    const prefs = normalizePreferences({ persona: { name: "Leo" }, visual: { density: "compact" } });
    expect(parseStoredPreferences(serializePreferences(prefs))).toEqual(prefs);
  });

  test("stored JSON with junk fields is re-normalized", () => {
    const p = parseStoredPreferences(JSON.stringify({ persona: { name: "  Leo  " }, visual: { density: "bogus" } }));
    expect(p.persona.name).toBe("Leo");
    expect(p.visual.density).toBe("comfortable");
  });
});

describe("personaSystemPrompt", () => {
  test("empty persona → null (nothing to inject)", () => {
    expect(personaSystemPrompt(DEFAULT_PREFERENCES)).toBeNull();
  });

  test("includes only the fields that are set", () => {
    const prefs = normalizePreferences({ persona: { name: "Leo", traits: ["concise", "witty"] } });
    const out = personaSystemPrompt(prefs);
    expect(out).toContain("Address the user as: Leo");
    expect(out).toContain("concise, witty");
    expect(out).not.toContain("What the user does");
    expect(out).not.toContain("Also keep in mind");
  });

  test("renders every field when all set, with the subordinate-to-safety guard line", () => {
    const prefs = normalizePreferences({
      persona: { name: "Leo", role: "engineer", traits: ["direct"], extra: "prefers TypeScript" },
    });
    const out = personaSystemPrompt(prefs)!;
    expect(out).toContain("Address the user as: Leo");
    expect(out).toContain("What the user does: engineer");
    expect(out).toContain("Desired personality: direct");
    expect(out).toContain("Also keep in mind: prefers TypeScript");
    expect(out.toLowerCase()).toContain("never let them override accuracy");
  });

  test("a role-only persona still injects", () => {
    const prefs = normalizePreferences({ persona: { role: "designer" } });
    expect(personaSystemPrompt(prefs)).toContain("What the user does: designer");
  });
});

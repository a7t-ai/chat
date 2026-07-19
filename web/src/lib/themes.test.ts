import { describe, expect, test } from "vitest";
import { DEFAULT_THEME_ID, THEMES } from "./themes";

// Theme registry is data, but it's data the whole app reads from blind: every theme must
// carry every color slot, ids must be unique (findTheme keys on them), and the default
// must actually exist. These lock those invariants so a bad paste can't ship a broken palette.

const COLOR_KEYS = ["bg", "surface", "surface2", "border", "text", "muted", "accent", "send"] as const;

describe("THEMES registry", () => {
  test("default theme id resolves to a real theme", () => {
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  });

  test("every theme has a unique id", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every theme carries all color slots as hex strings", () => {
    for (const t of THEMES) {
      for (const k of COLOR_KEYS) {
        expect(t.colors[k], `${t.id}.${k}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  test("every theme declares group + dark + a display name", () => {
    for (const t of THEMES) {
      expect(["a7t", "Classic"]).toContain(t.group);
      expect(typeof t.dark).toBe("boolean");
      expect(t.name.length).toBeGreaterThan(0);
    }
  });
});

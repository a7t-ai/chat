import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";

// preferences.ts mirrors the server's Preferences bounds and owns applying visual/a11y choices
// to the DOM. setPreferences fires a fire-and-forget saveSettings() network call, so we stub the
// api module (as SettingsPanel's test does).
vi.mock("./api", () => ({
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

import {
  applyPreferences,
  DEFAULT_PREFERENCES,
  FONT_SCALE_MAX,
  getPreferences,
  initPreferences,
  NAME_MAX,
  normalizePreferences,
  setPreferences,
  syncPreferences,
} from "./preferences";

beforeEach(() => {
  installLocalStorage();
  // Reset the DOM root between tests.
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.motion;
  delete document.documentElement.dataset.contrast;
  delete document.documentElement.dataset.dysfont;
  // Reset the module store to defaults.
  syncPreferences(DEFAULT_PREFERENCES);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("normalizePreferences (client)", () => {
  test("garbage → defaults", () => {
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences("x")).toEqual(DEFAULT_PREFERENCES);
  });

  test("timerSound defaults on and coerces non-booleans back to the default", () => {
    expect(normalizePreferences(null).behavior.timerSound).toBe(true);
    expect(normalizePreferences({ behavior: { timerSound: "off" } }).behavior.timerSound).toBe(true);
    expect(normalizePreferences({ behavior: { timerSound: false } }).behavior.timerSound).toBe(false);
  });

  test("memory defaults on and coerces a non-boolean back to the default (#27)", () => {
    expect(normalizePreferences(null).memory.enabled).toBe(true);
    expect(normalizePreferences({ memory: { enabled: "no" } }).memory.enabled).toBe(true);
    expect(normalizePreferences({ memory: { enabled: false } }).memory.enabled).toBe(false);
  });

  test("bounds strings and whitelists enums", () => {
    const p = normalizePreferences({
      persona: { name: " " + "a".repeat(200) },
      visual: { mainFont: "bogus", density: "compact" },
      accessibility: { fontScale: 5 },
    });
    expect(p.persona.name.length).toBe(NAME_MAX);
    expect(p.visual.mainFont).toBe("sans"); // fell back
    expect(p.visual.density).toBe("compact"); // kept
    expect(p.accessibility.fontScale).toBe(FONT_SCALE_MAX); // clamped
  });
});

describe("applyPreferences", () => {
  test("writes font vars, scale, and toggles data-attributes", () => {
    applyPreferences(
      normalizePreferences({
        visual: { mainFont: "serif", codeFont: "system", density: "compact" },
        accessibility: { fontScale: 1.2, reducedMotion: true, highContrast: true, dyslexiaFont: false },
      }),
    );
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--font-sans")).toContain("Instrument Serif");
    expect(root.style.getPropertyValue("--font-mono")).toContain("ui-monospace");
    expect(root.style.getPropertyValue("--font-scale")).toBe("1.2");
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.motion).toBe("reduced");
    expect(root.dataset.contrast).toBe("high");
    expect(root.dataset.dysfont).toBeUndefined();
  });

  test("dyslexia font overrides the chosen main font", () => {
    applyPreferences(normalizePreferences({ visual: { mainFont: "serif" }, accessibility: { dyslexiaFont: true } }));
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--font-sans")).toContain("OpenDyslexic");
    expect(root.dataset.dysfont).toBe("on");
  });

  test("turning a flag off removes its data-attribute", () => {
    applyPreferences(normalizePreferences({ accessibility: { highContrast: true } }));
    expect(document.documentElement.dataset.contrast).toBe("high");
    applyPreferences(DEFAULT_PREFERENCES);
    expect(document.documentElement.dataset.contrast).toBeUndefined();
  });
});

describe("setPreferences", () => {
  test("merges a partial patch, applies it, persists locally, and syncs to the account", async () => {
    const { saveSettings } = await import("./api");
    setPreferences({ persona: { name: "Leo" } });
    setPreferences({ visual: { density: "compact" } });
    const cur = getPreferences();
    expect(cur.persona.name).toBe("Leo"); // survived the second patch
    expect(cur.visual.density).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem("a7t_chat_prefs")).toContain("Leo");
    expect(saveSettings).toHaveBeenCalledTimes(2);
    // The full normalized object is sent (server merges too, but this is race-free).
    expect(saveSettings).toHaveBeenLastCalledWith({ preferences: cur });
  });

  test("patches the memory section without clobbering the rest (#27)", async () => {
    const { saveSettings } = await import("./api");
    setPreferences({ persona: { name: "Leo" } });
    setPreferences({ memory: { enabled: false } });
    const cur = getPreferences();
    expect(cur.memory.enabled).toBe(false);
    expect(cur.persona.name).toBe("Leo"); // untouched by the memory patch
    expect(saveSettings).toHaveBeenLastCalledWith({ preferences: cur });
  });

  test("an oversized field is bounded before it is saved", async () => {
    const { saveSettings } = await import("./api");
    setPreferences({ persona: { name: "z".repeat(9999) } });
    expect(getPreferences().persona.name.length).toBe(NAME_MAX);
    expect((saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0].preferences.persona.name.length).toBe(NAME_MAX);
  });
});

describe("syncPreferences", () => {
  test("applies server prefs without re-saving", async () => {
    const { saveSettings } = await import("./api");
    syncPreferences(normalizePreferences({ visual: { density: "compact" } }));
    expect(getPreferences().visual.density).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(saveSettings).not.toHaveBeenCalled(); // no echo write
  });

  test("null/undefined is a no-op", () => {
    setPreferences({ persona: { name: "Leo" } });
    syncPreferences(null);
    expect(getPreferences().persona.name).toBe("Leo");
    syncPreferences(undefined);
    expect(getPreferences().persona.name).toBe("Leo");
  });
});

describe("initPreferences", () => {
  test("applies the current store to the DOM", () => {
    syncPreferences(normalizePreferences({ accessibility: { fontScale: 1.3 } }));
    document.documentElement.removeAttribute("style");
    initPreferences();
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.3");
  });
});

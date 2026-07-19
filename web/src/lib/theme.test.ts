import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import { applyTheme, findTheme, getThemeId, initTheme, setTheme, syncTheme } from "./theme";
import { DEFAULT_THEME_ID, THEMES } from "./themes";

const KEY = "a7t_chat_theme";

// setTheme persists to the account via saveSettings -> fetch. We don't want a real call,
// and we want setTheme to resolve even though it fires-and-forgets (void ... .catch).
function stubFetchOk() {
  // Typed as the fetch signature so `.mock.calls[0]` destructures to [url, init].
  const fn = vi.fn((async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function readVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

beforeEach(() => {
  installLocalStorage();
  // a meta theme-color tag so applyTheme's optional chaining hits its set path
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.mode;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getThemeId", () => {
  test("returns the default when nothing is stored", () => {
    expect(getThemeId()).toBe(DEFAULT_THEME_ID);
  });

  test("returns the stored id when present", () => {
    localStorage.setItem(KEY, "nord");
    expect(getThemeId()).toBe("nord");
  });
});

describe("findTheme", () => {
  test("finds a known theme by id", () => {
    expect(findTheme("nord").id).toBe("nord");
  });

  test("falls back to the first theme for an unknown id", () => {
    expect(findTheme("does-not-exist")).toBe(THEMES[0]);
  });
});

describe("applyTheme", () => {
  test("writes every CSS var + dataset + meta theme-color for a dark theme", () => {
    const nord = findTheme("nord");
    applyTheme("nord");
    expect(readVar("--bg")).toBe(nord.colors.bg);
    expect(readVar("--surface")).toBe(nord.colors.surface);
    expect(readVar("--surface-2")).toBe(nord.colors.surface2);
    expect(readVar("--border")).toBe(nord.colors.border);
    expect(readVar("--text")).toBe(nord.colors.text);
    expect(readVar("--muted")).toBe(nord.colors.muted);
    expect(readVar("--accent")).toBe(nord.colors.accent);
    expect(readVar("--send")).toBe(nord.colors.send);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("nord");
    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(nord.colors.bg);
  });

  test("sets light color-scheme + mode for a light theme", () => {
    applyTheme("a7t-white");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.dataset.mode).toBe("light");
  });

  test("does not throw when the meta theme-color tag is absent", () => {
    document.head.innerHTML = "";
    expect(() => applyTheme("nord")).not.toThrow();
  });
});

describe("setTheme", () => {
  test("persists locally, applies, and PUTs the theme to /api/settings", async () => {
    const fetchMock = stubFetchOk();
    setTheme("dracula");
    expect(localStorage.getItem(KEY)).toBe("dracula");
    expect(document.documentElement.dataset.theme).toBe("dracula");
    // saveSettings is fire-and-forget; allow the microtask to flush before asserting.
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ theme: "dracula" });
  });

  test("swallows a failed settings save (no throw)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(() => setTheme("nord")).not.toThrow();
    expect(localStorage.getItem(KEY)).toBe("nord");
    await Promise.resolve();
  });
});

describe("syncTheme", () => {
  test("applies a server theme without re-saving it", () => {
    const fetchMock = stubFetchOk();
    syncTheme("gruvbox-dark");
    expect(localStorage.getItem(KEY)).toBe("gruvbox-dark");
    expect(document.documentElement.dataset.theme).toBe("gruvbox-dark");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("is a no-op for a null server theme", () => {
    syncTheme(null);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("initTheme", () => {
  test("applies the stored theme on boot", () => {
    localStorage.setItem(KEY, "tokyo-night");
    initTheme();
    expect(document.documentElement.dataset.theme).toBe("tokyo-night");
  });
});

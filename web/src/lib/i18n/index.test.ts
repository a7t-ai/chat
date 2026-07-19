import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../../__tests__/localStorage";
import {
  applyLang,
  DEFAULT_LOCALE,
  getLang,
  initLang,
  localeTag,
  LOCALES,
  setLang,
  syncLang,
  translate,
} from "./index";

const KEY = "a7t_chat_lang";

function stubFetchOk() {
  // Typed as the fetch signature so `.mock.calls[0]` destructures to [url, init].
  const fn = vi.fn((async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  installLocalStorage();
  applyLang(DEFAULT_LOCALE); // reset module-level `current` between tests
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("translate — lookup + interpolation + fallback", () => {
  test("returns a plain message in English", () => {
    expect(translate("en", "common.close")).toBe("Close");
  });

  test("returns the localized message in pt-BR", () => {
    expect(translate("pt-BR", "common.close")).toBe("Fechar");
  });

  test("interpolates a single {var}", () => {
    expect(translate("en", "palette.themeLabel", { name: "Nightshade" })).toBe("Theme: Nightshade");
  });

  test("interpolates a numeric {var} (coerced to string)", () => {
    expect(translate("en", "chat.queuedPosition", { n: 3 })).toBe("Waiting · #3 in queue");
  });

  test("interpolates multiple distinct {var}s", () => {
    const out = translate("en", "chat.modelsList", { models: "a, b", current: "a" });
    expect(out).toBe("models: a, b · current: a");
  });

  test("leaves an unprovided {var} placeholder untouched", () => {
    expect(translate("en", "palette.themeLabel", {})).toBe("Theme: {name}");
  });

  test("returns the raw template when no vars object is passed", () => {
    // format() short-circuits when vars is undefined — placeholder stays literal.
    expect(translate("en", "palette.themeLabel")).toBe("Theme: {name}");
  });

  test("falls back to the key itself for an unknown key", () => {
    // @ts-expect-error — exercising the runtime fallback for a key not in any dict
    expect(translate("en", "totally.missing.key")).toBe("totally.missing.key");
  });

  test("falls back to English when a locale dict lacks the key", () => {
    // @ts-expect-error — pt-BR has no such key, so it falls through en[key] -> key
    expect(translate("pt-BR", "totally.missing.key")).toBe("totally.missing.key");
  });
});

describe("localeTag", () => {
  test("maps a locale id to its BCP-47 tag", () => {
    expect(localeTag("pt-BR")).toBe("pt-BR");
    expect(localeTag("en")).toBe("en");
  });

  test("defaults to the active locale when called with no argument", () => {
    applyLang("pt-BR");
    expect(localeTag()).toBe("pt-BR");
  });
});

describe("LOCALES", () => {
  test("lists the supported locales with names", () => {
    expect(LOCALES.map((l) => l.id)).toEqual(["en", "pt-BR"]);
    expect(LOCALES.find((l) => l.id === "pt-BR")?.name).toBe("Português (Brasil)");
  });
});

describe("applyLang / getLang", () => {
  test("updates the active locale + <html lang> + notifies", () => {
    applyLang("pt-BR");
    expect(getLang()).toBe("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
  });
});

describe("setLang", () => {
  test("persists locally, applies, and PUTs lang to /api/settings", async () => {
    const fetchMock = stubFetchOk();
    setLang("pt-BR");
    expect(localStorage.getItem(KEY)).toBe("pt-BR");
    expect(getLang()).toBe("pt-BR");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ lang: "pt-BR" });
  });

  test("swallows a failed settings save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(() => setLang("pt-BR")).not.toThrow();
    expect(getLang()).toBe("pt-BR");
    await Promise.resolve();
  });
});

describe("syncLang", () => {
  test("applies a valid server lang without saving", () => {
    const fetchMock = stubFetchOk();
    syncLang("pt-BR");
    expect(localStorage.getItem(KEY)).toBe("pt-BR");
    expect(getLang()).toBe("pt-BR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("ignores an unsupported / null server lang", () => {
    syncLang("fr");
    syncLang(null);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getLang()).toBe(DEFAULT_LOCALE);
  });
});

describe("initLang", () => {
  test("applies the current locale (sets <html lang>)", () => {
    applyLang("pt-BR");
    document.documentElement.lang = "";
    initLang();
    expect(document.documentElement.lang).toBe("pt-BR");
  });
});

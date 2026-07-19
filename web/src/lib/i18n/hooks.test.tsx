import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../../__tests__/localStorage";
import { applyLang, DEFAULT_LOCALE, useLang, useT } from "./index";

// useLang/useT bind to the module-level locale via useSyncExternalStore. These exercise the
// subscribe path + the re-render-on-change behavior that backs live language switching.

beforeEach(() => {
  installLocalStorage();
  applyLang(DEFAULT_LOCALE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLang", () => {
  test("reflects the active locale and updates when it changes", () => {
    const { result } = renderHook(() => useLang());
    expect(result.current).toBe("en");
    act(() => applyLang("pt-BR"));
    expect(result.current).toBe("pt-BR");
  });
});

describe("useT", () => {
  test("returns a translator bound to the active locale", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("common.close")).toBe("Close");
    expect(result.current("palette.themeLabel", { name: "Mocha" })).toBe("Theme: Mocha");
  });

  test("rebinds when the locale switches", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("common.close")).toBe("Close");
    act(() => applyLang("pt-BR"));
    expect(result.current("common.close")).toBe("Fechar");
  });
});

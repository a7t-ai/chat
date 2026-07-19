import { beforeEach, describe, expect, test } from "vitest";
import { applyEnvFavicon } from "./favicon";

// Rebuild the <head> the app ships in index.html before each test so assertions are isolated.
beforeEach(() => {
  document.head.innerHTML = `
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <meta name="theme-color" content="#0B3838" />
  `;
});

function svgIconHref(): string | null {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"][type="image/svg+xml"]')!.getAttribute("href");
}
function themeColor(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.getAttribute("content");
}

describe("applyEnvFavicon", () => {
  test("staging replaces the favicon with the orange mark and tints the theme-color", () => {
    applyEnvFavicon("staging");
    expect(svgIconHref()).toBe("/favicon-staging.svg");
    expect(themeColor()).toBe("#F59E0B");
  });

  test("staging leaves EXACTLY ONE icon link — the teal .ico fallback is removed", () => {
    // Dropping the .ico is deliberate: Chrome can otherwise keep painting the cached teal .ico.
    applyEnvFavicon("staging");
    const icons = document.querySelectorAll('link[rel~="icon"]');
    expect(icons).toHaveLength(1);
    expect(icons[0]!.getAttribute("href")).toBe("/favicon-staging.svg");
    expect(document.querySelector('link[rel~="icon"][sizes="any"]')).toBeNull();
  });

  test("production leaves both the teal mark and the .ico fallback untouched", () => {
    applyEnvFavicon("production");
    expect(svgIconHref()).toBe("/favicon.svg");
    expect(document.querySelectorAll('link[rel~="icon"]')).toHaveLength(2);
    expect(themeColor()).toBe("#0B3838");
  });

  test("an undefined env is treated as production (no change)", () => {
    applyEnvFavicon(undefined);
    expect(svgIconHref()).toBe("/favicon.svg");
    expect(themeColor()).toBe("#0B3838");
  });

  test("does not throw when the icon / theme-color elements are absent", () => {
    document.head.innerHTML = "";
    expect(() => applyEnvFavicon("staging")).not.toThrow();
  });
});

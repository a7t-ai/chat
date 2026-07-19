import { describe, expect, test } from "vitest";
import { footerLinks } from "./footer";

describe("footerLinks", () => {
  test("returns only the enabled links (the a7t.ai cross-link; Help is disabled)", () => {
    const ids = footerLinks().map((l) => l.id);
    expect(ids).toContain("a7t");
    // Help was disabled (owner request); the removed hosted-SaaS surfaces never rendered.
    for (const gone of ["help", "privacy", "terms", "imprint", "changelog"]) {
      expect(ids).not.toContain(gone);
    }
  });

  test("the help link is disabled and not returned", () => {
    expect(footerLinks().find((l) => l.id === "help")).toBeUndefined();
  });

  test("the a7t.ai link is external and points at the absolute https URL", () => {
    const a7t = footerLinks().find((l) => l.id === "a7t");
    expect(a7t?.href).toBe("https://a7t.ai");
    expect(a7t?.external).toBe(true);
  });

  test("every returned link carries a label key (nothing renders blank)", () => {
    for (const l of footerLinks()) expect(l.labelKey).toBeTruthy();
  });
});

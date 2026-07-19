import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Help } from "./Help";

describe("Help", () => {
  test("renders the contact + bug-report sections", () => {
    render(<Help />);
    expect(screen.getByRole("heading", { name: "Help & Contact" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contact" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Report a bug" })).toBeInTheDocument();
  });

  test("links the live support inbox (contact + prefilled bug report)", () => {
    render(<Help />);
    const mailtos = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.startsWith("mailto:support@a7t.chat"));
    // Both the plain contact link and the subject-prefilled bug-report link point at support.
    expect(mailtos.length).toBeGreaterThanOrEqual(2);
    expect(
      mailtos.some((a) => a.getAttribute("href") === "mailto:support@a7t.chat"),
    ).toBe(true);
    expect(
      mailtos.some((a) => a.getAttribute("href")?.includes("subject=Bug")),
    ).toBe(true);
  });

  test("does not link the removed legal pages (Privacy/Terms/Imprint)", () => {
    render(<Help />);
    for (const name of [/Privacy/, /Terms/, /Imprint/]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
  });

  test("offers a way back to the app", () => {
    render(<Help />);
    expect(screen.getByRole("link", { name: /Back to a7t\.chat/ })).toHaveAttribute("href", "/");
  });

  test("renders the global footer with the a7t.ai cross-link", () => {
    render(<Help />);
    expect(screen.getByRole("navigation", { name: "Footer" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Part of a7t.ai" })).toHaveAttribute(
      "href",
      "https://a7t.ai",
    );
  });
});

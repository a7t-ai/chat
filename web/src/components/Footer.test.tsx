import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Footer } from "./Footer";

describe("Footer", () => {
  test("does not render the Help link (disabled in the footer registry)", () => {
    render(<Footer />);
    expect(screen.queryByRole("link", { name: "Help" })).toBeNull();
  });

  test("the a7t.ai cross-link opens a new tab with a hardened rel", () => {
    render(<Footer />);
    const cross = screen.getByRole("link", { name: "Part of a7t.ai" });
    expect(cross).toHaveAttribute("href", "https://a7t.ai");
    expect(cross).toHaveAttribute("target", "_blank");
    // noopener (no reverse tabnabbing) + noreferrer (no referrer leak).
    expect(cross).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("does not render the removed hosted-SaaS surfaces (Privacy/Terms/Imprint/Changelog)", () => {
    render(<Footer />);
    for (const name of ["Privacy", "Terms", "Imprint", "Changelog"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
  });

  test("exposes the footer landmark with an accessible label", () => {
    render(<Footer />);
    expect(screen.getByRole("navigation", { name: "Footer" })).toBeInTheDocument();
  });
});

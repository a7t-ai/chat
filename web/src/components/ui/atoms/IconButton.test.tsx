import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { IconButton } from "./IconButton";

describe("IconButton", () => {
  test("uses label as the accessible name + title, with icon-btn classes", () => {
    render(
      <IconButton label="Close">
        <svg />
      </IconButton>,
    );
    const b = screen.getByRole("button", { name: "Close" });
    expect(b).toHaveClass("btn", "icon-btn", "ghost");
    expect(b).toHaveAttribute("title", "Close");
  });

  test("active adds the .active class and sets aria-pressed", () => {
    render(
      <IconButton label="Minimap" active>
        <svg />
      </IconButton>,
    );
    const b = screen.getByRole("button", { name: "Minimap" });
    expect(b).toHaveClass("active");
    expect(b).toHaveAttribute("aria-pressed", "true");
  });

  test("without active, no aria-pressed (a plain action button)", () => {
    render(
      <IconButton label="Search">
        <svg />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Search" })).not.toHaveAttribute("aria-pressed");
  });

  test("ghost=false drops ghost; size sm adds small", () => {
    render(
      <IconButton label="X" ghost={false} size="sm">
        <svg />
      </IconButton>,
    );
    const b = screen.getByRole("button", { name: "X" });
    expect(b).not.toHaveClass("ghost");
    expect(b).toHaveClass("small");
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { MapChip } from "./MapChip";

// MapChip is the inline pill rendered for a [[map:…]] marker. It must show only the SHORT
// place name (first comma-segment), carry the FULL payload in its title, and fire open() on
// click — nothing external loads until that click (the "consent to load" posture).

describe("MapChip", () => {
  test("shows the first comma-segment as the short label, full payload in the title", () => {
    render(<MapChip payload="Belém Tower, Lisbon, Portugal" open={() => {}} />);
    expect(screen.getByText("Belém Tower")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "Show Belém Tower, Lisbon, Portugal on the map",
    );
  });

  test("falls back to the whole payload when there is no comma", () => {
    render(<MapChip payload="Berlin" open={() => {}} />);
    expect(screen.getByText("Berlin")).toBeInTheDocument();
  });

  test("uses the whole payload when the first segment is blank (leading comma)", () => {
    // `", x".split(",")[0].trim()` is "" → falls back to the raw payload.
    render(<MapChip payload=", x" open={() => {}} />);
    expect(screen.getByText(", x")).toBeInTheDocument();
  });

  test("trims surrounding whitespace from the short label", () => {
    render(<MapChip payload="  Paris  , France" open={() => {}} />);
    expect(screen.getByText("Paris")).toBeInTheDocument();
  });

  test("clicking the chip fires open()", async () => {
    const open = vi.fn();
    render(<MapChip payload="Tokyo, Japan" open={open} />);
    await userEvent.click(screen.getByRole("button"));
    expect(open).toHaveBeenCalledTimes(1);
  });
});

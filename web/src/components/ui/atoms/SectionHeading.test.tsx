import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SectionHeading } from "./SectionHeading";

describe("SectionHeading", () => {
  test("renders an <h3> with the sub class", () => {
    render(<SectionHeading>Appearance</SectionHeading>);
    const el = screen.getByRole("heading", { level: 3, name: "Appearance" });
    expect(el).toHaveClass("sub");
  });

  test("merges an extra className", () => {
    render(<SectionHeading className="x">A</SectionHeading>);
    expect(screen.getByRole("heading", { level: 3 })).toHaveClass("sub", "x");
  });
});

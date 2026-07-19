import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  test("applies the variant class", () => {
    render(<Badge variant="warning">staging</Badge>);
    expect(screen.getByText("staging")).toHaveClass("ui-badge", "ui-badge-warning");
  });

  test("defaults to the neutral variant", () => {
    render(<Badge>x</Badge>);
    expect(screen.getByText("x")).toHaveClass("ui-badge-neutral");
  });
});

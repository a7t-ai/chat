import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { StagingBadge } from "./StagingBadge";

describe("StagingBadge", () => {
  test("renders the pill on staging", () => {
    render(<StagingBadge env="staging" />);
    expect(screen.getByText("staging")).toBeInTheDocument();
  });

  test("renders nothing on production or when env is unset", () => {
    const { container } = render(<StagingBadge env="production" />);
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(<StagingBadge />);
    expect(c2).toBeEmptyDOMElement();
  });

  test("merges an extra className (the mobile/topbar variant)", () => {
    render(<StagingBadge env="staging" className="staging-badge--topbar" />);
    expect(screen.getByText("staging").className).toContain("staging-badge--topbar");
  });
});

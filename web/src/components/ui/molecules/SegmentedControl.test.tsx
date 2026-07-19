import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

const OPTIONS = [
  { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "system", label: "System" },
] as const;

describe("SegmentedControl", () => {
  test("marks the selected option with aria-pressed + .on", () => {
    render(<SegmentedControl value="serif" options={OPTIONS} onChange={() => {}} ariaLabel="Font" />);
    const serif = screen.getByRole("button", { name: "Serif", pressed: true });
    expect(serif).toHaveClass("chip", "on");
    expect(screen.getByRole("button", { name: "Sans" })).toHaveAttribute("aria-pressed", "false");
  });

  test("fires onChange with the picked value", () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="sans" options={OPTIONS} onChange={onChange} ariaLabel="Font" />);
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(onChange).toHaveBeenCalledWith("system");
  });

  test("exposes the group with its aria-label", () => {
    render(<SegmentedControl value="sans" options={OPTIONS} onChange={() => {}} ariaLabel="Text font" />);
    expect(screen.getByRole("group", { name: "Text font" })).toBeInTheDocument();
  });
});

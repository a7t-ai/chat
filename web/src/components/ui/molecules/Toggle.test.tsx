import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  test("is a switch reflecting checked, with the label as its name", () => {
    render(<Toggle label="Reduce motion" checked onChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Reduce motion" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw).toHaveClass("pref-toggle", "on");
  });

  test("clicking fires onChange with the flipped value", () => {
    const onChange = vi.fn();
    render(<Toggle label="High contrast" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "High contrast" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test("renders a hint when given", () => {
    render(<Toggle label="Enter to send" hint="Off: Enter adds a line" checked={false} onChange={() => {}} />);
    expect(screen.getByText("Off: Enter adds a line")).toBeInTheDocument();
  });
});

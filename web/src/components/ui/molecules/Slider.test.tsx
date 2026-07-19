import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { Slider } from "./Slider";

describe("Slider", () => {
  test("renders a range input at the given value with the label", () => {
    render(<Slider label="Text size" value={0.95} min={0.8} max={1.2} step={0.05} onChange={() => {}} />);
    const input = screen.getByLabelText("Text size") as HTMLInputElement;
    expect(input.type).toBe("range");
    expect(input.value).toBe("0.95");
  });

  test("format renders a live readout beside the label", () => {
    render(
      <Slider label="Text size" value={0.95} min={0.8} max={1.2} onChange={() => {}} format={(v) => `${Math.round(v * 100)}%`} />,
    );
    expect(screen.getByText("95%")).toBeInTheDocument();
  });

  test("fires onChange with a number", () => {
    const onChange = vi.fn();
    render(<Slider label="X" value={1} min={0} max={2} step={1} onChange={onChange} ariaLabel="X" />);
    fireEvent.change(screen.getByLabelText("X"), { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith(2);
  });
});

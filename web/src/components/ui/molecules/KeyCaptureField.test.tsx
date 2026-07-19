import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { KeyCaptureField } from "./KeyCaptureField";

const base = {
  keys: ["⌘", "."],
  placeholder: "Press keys…",
  ariaLabel: "Change shortcut",
  onStart: () => {},
};

describe("KeyCaptureField", () => {
  test("idle: shows the chord (Kbd chips), not the placeholder", () => {
    const { container } = render(<KeyCaptureField {...base} recording={false} />);
    expect(container.querySelectorAll("kbd.ui-kbd")).toHaveLength(2);
    expect(screen.queryByText("Press keys…")).toBeNull();
  });

  test("recording: shows the placeholder, no chips", () => {
    const { container } = render(<KeyCaptureField {...base} recording />);
    expect(screen.getByText("Press keys…")).toBeInTheDocument();
    expect(container.querySelectorAll("kbd")).toHaveLength(0);
  });

  test("uses ariaLabel and fires onStart on click", () => {
    const onStart = vi.fn();
    render(<KeyCaptureField {...base} recording={false} onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Change shortcut" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("sets data-recording only while recording", () => {
    const { rerender } = render(<KeyCaptureField {...base} recording />);
    expect(screen.getByRole("button")).toHaveAttribute("data-recording", "true");
    rerender(<KeyCaptureField {...base} recording={false} />);
    expect(screen.getByRole("button")).not.toHaveAttribute("data-recording");
  });
});

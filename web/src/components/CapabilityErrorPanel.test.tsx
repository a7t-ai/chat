import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CapabilityErrorPanel } from "./CapabilityErrorPanel";

// The fallback an ErrorBoundary shows when a drawer surface throws. It keeps the drawer chrome
// (so the crash reads as a contained panel) and its dismiss runs the same onClose as the real
// drawer, so a crash never leaves the app blank.

describe("CapabilityErrorPanel", () => {
  test("renders a contained drawer panel with the map error message", () => {
    render(<CapabilityErrorPanel onClose={() => {}} />);
    const panel = screen.getByRole("alert");
    expect(panel).toHaveClass("cap-drawer");
    expect(panel).toHaveTextContent("The map ran into a problem");
  });

  test("the header close button runs onClose", async () => {
    const onClose = vi.fn();
    render(<CapabilityErrorPanel onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close map" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("the Dismiss button runs onClose", async () => {
    const onClose = vi.fn();
    render(<CapabilityErrorPanel onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

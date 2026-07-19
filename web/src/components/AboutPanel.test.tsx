import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AboutPanel } from "./AboutPanel";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AboutPanel", () => {
  test("renders the title and the a7t.ai link (Help link removed)", () => {
    render(<AboutPanel onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Help" })).toBeNull();
    const cross = screen.getByRole("link", { name: "Part of a7t.ai" });
    expect(cross).toHaveAttribute("href", "https://a7t.ai");
    expect(cross).toHaveAttribute("target", "_blank");
    expect(cross).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("does not surface the removed Help link", () => {
    render(<AboutPanel onClose={() => {}} />);
    expect(screen.queryByRole("link", { name: "Help" })).toBeNull();
  });

  test("the close button calls onClose", async () => {
    const onClose = vi.fn();
    render(<AboutPanel onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking the overlay backdrop closes; clicking the panel does not", async () => {
    const onClose = vi.fn();
    const { container } = render(<AboutPanel onClose={onClose} />);
    // Clicking inside the panel must NOT close (stopPropagation).
    await userEvent.click(screen.getByRole("heading", { name: "About" }));
    expect(onClose).not.toHaveBeenCalled();
    // Clicking the overlay backdrop closes.
    fireEvent.click(container.querySelector(".overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape closes the dialog and the handler is cleaned up on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(<AboutPanel onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // After unmount the listener is gone — no further calls.
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

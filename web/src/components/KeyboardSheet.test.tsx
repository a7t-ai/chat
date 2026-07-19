import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import { getBindings, resetBindings } from "../lib/keybindings";
import { KeyboardSheet } from "./KeyboardSheet";

// KeyboardSheet is the command cheat-sheet overlay AND the shortcut rebinding UI (#16). Cover:
// it lists the groups + rows, Esc/close/backdrop close it (panel body does not), and the
// General group rows record + rebind chords (with conflict rejection + reset). The MOD glyph is
// computed at module load from navigator, so we assert rows render rather than a specific ⌘/Ctrl.

beforeEach(() => {
  installLocalStorage();
  resetBindings();
});

describe("KeyboardSheet — cheat-sheet", () => {
  test("renders the three shortcut groups", () => {
    render(<KeyboardSheet onClose={() => {}} />);
    expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument();
    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.getByText("Send message")).toBeInTheDocument();
    // Several rows render kbd keys.
    expect(document.querySelectorAll("kbd").length).toBeGreaterThan(3);
  });

  test("the close button fires onClose", async () => {
    const onClose = vi.fn();
    render(<KeyboardSheet onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking the backdrop fires onClose", () => {
    const onClose = vi.fn();
    const { container } = render(<KeyboardSheet onClose={onClose} />);
    fireEvent.click(container.querySelector(".overlay")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking inside the panel does NOT close it", () => {
    const onClose = vi.fn();
    const { container } = render(<KeyboardSheet onClose={onClose} />);
    fireEvent.click(container.querySelector(".kbd-panel")!);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("Escape closes the sheet", () => {
    const onClose = vi.fn();
    render(<KeyboardSheet onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a non-Escape key does not close", () => {
    const onClose = vi.fn();
    render(<KeyboardSheet onClose={onClose} />);
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("removes its keydown listener on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(<KeyboardSheet onClose={onClose} />);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("KeyboardSheet — rebinding", () => {
  const rebindBtn = (label: string) => screen.getByRole("button", { name: `Change the shortcut for ${label}` });

  test("clicking a shortcut enters recording mode", async () => {
    render(<KeyboardSheet onClose={() => {}} />);
    await userEvent.click(rebindBtn("Toggle sidebar"));
    expect(screen.getByText("Press keys…")).toBeInTheDocument();
  });

  test("recording a new chord rebinds the action and persists it", async () => {
    render(<KeyboardSheet onClose={() => {}} />);
    await userEvent.click(rebindBtn("Toggle sidebar"));
    fireEvent.keyDown(window, { key: "g", metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByText("Press keys…")).toBeNull());
    expect(getBindings().toggleSidebar).toBe("mod+shift+g");
  });

  test("an incomplete combo (lone modifier) keeps recording", async () => {
    render(<KeyboardSheet onClose={() => {}} />);
    await userEvent.click(rebindBtn("Toggle sidebar"));
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    // Still waiting — the combo wasn't complete.
    expect(screen.getByText("Press keys…")).toBeInTheDocument();
    expect(getBindings().toggleSidebar).toBe("mod+b");
  });

  test("Escape cancels recording without closing the sheet", async () => {
    const onClose = vi.fn();
    render(<KeyboardSheet onClose={onClose} />);
    await userEvent.click(rebindBtn("Toggle sidebar"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Press keys…")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(getBindings().toggleSidebar).toBe("mod+b"); // unchanged
  });

  test("a conflicting chord is rejected with a message", async () => {
    render(<KeyboardSheet onClose={() => {}} />);
    await userEvent.click(rebindBtn("Toggle sidebar"));
    fireEvent.keyDown(window, { key: "k", metaKey: true }); // mod+k is Search's
    expect(await screen.findByRole("alert")).toHaveTextContent("Already used by");
    expect(getBindings().toggleSidebar).toBe("mod+b"); // unchanged
  });

  test("Reset to defaults restores every binding", async () => {
    render(<KeyboardSheet onClose={() => {}} />);
    await userEvent.click(rebindBtn("Toggle sidebar"));
    fireEvent.keyDown(window, { key: "g", metaKey: true, shiftKey: true });
    await waitFor(() => expect(getBindings().toggleSidebar).toBe("mod+shift+g"));
    await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(getBindings().toggleSidebar).toBe("mod+b");
  });
});

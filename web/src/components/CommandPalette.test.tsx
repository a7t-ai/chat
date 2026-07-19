import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type CommandItem, CommandPalette } from "./CommandPalette";

// CommandPalette: fuzzy filter over grouped items, arrow-key nav, Enter to run, Esc/backdrop
// to close, hover to set active, and query-match highlighting. We feed a small item set and
// drive it through the keyboard + pointer paths.

function items(): CommandItem[] {
  return [
    { id: "new", label: "New chat", group: "Actions", run: vi.fn() },
    { id: "temp", label: "Temporary chat", group: "Actions", keywords: "ghost", run: vi.fn() },
    { id: "theme", label: "Switch theme", group: "Settings", hint: "⌘T", run: vi.fn() },
  ];
}

// jsdom doesn't implement scrollIntoView (called on the active row).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("CommandPalette", () => {
  test("renders every item grouped, focuses the input on mount", () => {
    render(<CommandPalette items={items()} onClose={() => {}} />);
    expect(screen.getByPlaceholderText("Search chats, settings, actions…")).toHaveFocus();
    expect(screen.getByText("Actions")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("New chat")).toBeInTheDocument();
    expect(screen.getByText("Switch theme")).toBeInTheDocument();
    // hint renders.
    expect(screen.getByText("⌘T")).toBeInTheDocument();
  });

  test("filters by label, group, or keyword and highlights the match", async () => {
    render(<CommandPalette items={items()} onClose={() => {}} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "ghost"); // matches Temporary chat via keywords
    expect(screen.getByText("Temporary chat")).toBeInTheDocument();
    expect(screen.queryByText("New chat")).toBeNull();
  });

  test("highlights the matched run of the query in the label", async () => {
    render(<CommandPalette items={items()} onClose={() => {}} />);
    await userEvent.type(screen.getByRole("textbox"), "theme");
    const strong = document.querySelector("strong.match");
    expect(strong).not.toBeNull();
    expect(strong!.textContent?.toLowerCase()).toBe("theme");
  });

  test("shows the no-results state when nothing matches", async () => {
    render(<CommandPalette items={items()} onClose={() => {}} />);
    await userEvent.type(screen.getByRole("textbox"), "zzzzz");
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  test("ArrowDown/ArrowUp move the active row (clamped at the ends)", () => {
    render(<CommandPalette items={items()} onClose={() => {}} />);
    const palette = document.querySelector(".palette")!;
    // Index 0 active by default.
    expect(document.querySelector('[data-idx="0"]')).toHaveClass("active");
    fireEvent.keyDown(palette, { key: "ArrowDown" });
    expect(document.querySelector('[data-idx="1"]')).toHaveClass("active");
    // Up past the top stays at 0.
    fireEvent.keyDown(palette, { key: "ArrowUp" });
    fireEvent.keyDown(palette, { key: "ArrowUp" });
    expect(document.querySelector('[data-idx="0"]')).toHaveClass("active");
  });

  test("Enter runs the active item and closes", () => {
    const data = items();
    const onClose = vi.fn();
    render(<CommandPalette items={data} onClose={onClose} />);
    const palette = document.querySelector(".palette")!;
    fireEvent.keyDown(palette, { key: "ArrowDown" }); // active → index 1
    fireEvent.keyDown(palette, { key: "Enter" });
    expect(data[1].run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking an item runs it and closes", async () => {
    const data = items();
    const onClose = vi.fn();
    render(<CommandPalette items={data} onClose={onClose} />);
    await userEvent.click(screen.getByText("Switch theme"));
    expect(data[2].run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("hovering an item makes it active", () => {
    render(<CommandPalette items={items()} onClose={() => {}} />);
    const row = screen.getByText("Switch theme").closest("button")!;
    fireEvent.mouseMove(row);
    expect(row).toHaveClass("active");
  });

  test("Escape and backdrop both close", () => {
    const onClose = vi.fn();
    const { container } = render(<CommandPalette items={items()} onClose={onClose} />);
    fireEvent.keyDown(document.querySelector(".palette")!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector(".palette-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test("clicking inside the palette body does not close it", () => {
    const onClose = vi.fn();
    render(<CommandPalette items={items()} onClose={onClose} />);
    fireEvent.click(document.querySelector(".palette")!);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("query reset returns to the full list (active resets to 0)", async () => {
    render(<CommandPalette items={items()} onClose={() => {}} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "theme");
    await userEvent.clear(input);
    expect(within(document.querySelector(".palette-list") as HTMLElement).getByText("New chat")).toBeInTheDocument();
  });
});

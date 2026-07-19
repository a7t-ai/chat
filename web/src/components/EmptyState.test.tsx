import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { EmptyState } from "./EmptyState";

// EmptyState is the new-chat welcome: a greeting, a tablist of capability "lanes", and the
// active lane's curated prompts. Cover the normal/temporary greeting swap, lane switching by
// click + arrow keys (roving focus, wrapping), and that picking a prompt drops its TEXT into
// the composer via onPick.

describe("EmptyState", () => {
  test("shows the standard greeting and the first lane's prompts by default", () => {
    render(<EmptyState onPick={() => {}} />);
    expect(screen.getByText("What can I help with?")).toBeInTheDocument();
    // "Create" lane (first) is selected by default.
    const create = screen.getByRole("tab", { name: "Create" });
    expect(create).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
  });

  test("shows the ghost-flavored greeting in a temporary chat", () => {
    render(<EmptyState onPick={() => {}} temporary />);
    expect(screen.getByText("Temporary chat")).toBeInTheDocument();
    expect(screen.queryByText("What can I help with?")).toBeNull();
  });

  test("clicking another lane selects it", async () => {
    render(<EmptyState onPick={() => {}} />);
    const code = screen.getByRole("tab", { name: "Code" });
    await userEvent.click(code);
    expect(code).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Create" })).toHaveAttribute("aria-selected", "false");
  });

  test("ArrowRight moves to the next lane with roving focus", () => {
    render(<EmptyState onPick={() => {}} />);
    const create = screen.getByRole("tab", { name: "Create" });
    fireEvent.keyDown(create, { key: "ArrowRight" });
    const code = screen.getByRole("tab", { name: "Code" });
    expect(code).toHaveAttribute("aria-selected", "true");
    expect(code).toHaveFocus();
  });

  test("ArrowLeft from the first lane wraps to the last", () => {
    render(<EmptyState onPick={() => {}} />);
    const create = screen.getByRole("tab", { name: "Create" });
    fireEvent.keyDown(create, { key: "ArrowLeft" });
    // Last lane is "Plan".
    expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
  });

  test("a non-arrow key on a tab is ignored", () => {
    render(<EmptyState onPick={() => {}} />);
    const create = screen.getByRole("tab", { name: "Create" });
    fireEvent.keyDown(create, { key: "Enter" });
    expect(create).toHaveAttribute("aria-selected", "true");
  });

  test("picking a prompt forwards its full text to onPick", async () => {
    const onPick = vi.fn();
    render(<EmptyState onPick={onPick} />);
    // The starter rows are the prompt buttons (not the lane tabs).
    const rows = screen.getAllByRole("button").filter((b) => b.classList.contains("starter-row"));
    expect(rows.length).toBeGreaterThan(0);
    await userEvent.click(rows[0]);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(typeof onPick.mock.calls[0][0]).toBe("string");
    expect(onPick.mock.calls[0][0].length).toBeGreaterThan(0);
  });
});

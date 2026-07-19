import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SidebarModal } from "./SidebarModal";

const ITEMS = [
  { id: "profile", label: "Profile" },
  { id: "plans", label: "Plans & billing" },
  { id: "settings", label: "Settings" },
];

function setup() {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <SidebarModal title="Settings" items={ITEMS} activeId="plans" onSelect={onSelect} onClose={onClose}>
      <div>plans content</div>
    </SidebarModal>,
  );
  return { onSelect, onClose };
}

describe("SidebarModal", () => {
  test("renders a labelled dialog, the nav, and the active section's content", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("plans content")).toBeInTheDocument();
    const active = screen.getByRole("button", { name: "Plans & billing" });
    expect(active).toHaveClass("active");
    expect(active).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Profile" })).not.toHaveClass("active");
  });

  test("clicking a nav item fires onSelect with its id", () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(onSelect).toHaveBeenCalledWith("profile");
  });

  test("Escape and the Close button both close it", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

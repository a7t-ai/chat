import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { Menu, MenuItem, MenuSeparator } from "./Menu";

describe("Menu", () => {
  test("opens on trigger click, shows items, closes on Escape", () => {
    render(
      <Menu trigger={<span>⋯</span>} triggerLabel="Options">
        <MenuItem>Star</MenuItem>
        <MenuSeparator />
        <MenuItem variant="danger">Delete</MenuItem>
      </Menu>,
    );
    const trigger = screen.getByRole("button", { name: "Options" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Star" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("an outside pointerdown closes it", () => {
    render(
      <Menu trigger={<span>x</span>} triggerLabel="M">
        <MenuItem>A</MenuItem>
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "M" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("MenuItem", () => {
  test("danger + active add classes and set aria-current", () => {
    render(
      <MenuItem variant="danger" active>
        Del
      </MenuItem>,
    );
    const item = screen.getByRole("menuitem", { name: "Del" });
    expect(item).toHaveClass("menu-item", "ui-menu-item", "danger", "active");
    expect(item).toHaveAttribute("aria-current", "true");
  });

  test("a disabled item is disabled and swallows clicks", () => {
    const onClick = vi.fn();
    render(
      <MenuItem disabled onClick={onClick}>
        Nope
      </MenuItem>,
    );
    const item = screen.getByRole("menuitem", { name: "Nope" });
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("fires onClick when enabled", () => {
    const onClick = vi.fn();
    render(<MenuItem onClick={onClick}>Go</MenuItem>);
    fireEvent.click(screen.getByRole("menuitem", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

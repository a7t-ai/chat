import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  test("default variant + size is just .btn", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" }).className).toBe("btn");
  });

  test("primary + small add their classes", () => {
    render(
      <Button variant="primary" size="sm">
        P
      </Button>,
    );
    expect(screen.getByRole("button", { name: "P" })).toHaveClass("btn", "primary", "small");
  });

  test("ghost and danger variants map to their classes", () => {
    const { rerender } = render(<Button variant="ghost">G</Button>);
    expect(screen.getByRole("button")).toHaveClass("ghost");
    rerender(<Button variant="danger">D</Button>);
    expect(screen.getByRole("button")).toHaveClass("danger");
  });

  test("forwards native props (type, onClick)", () => {
    const onClick = vi.fn();
    render(
      <Button type="submit" onClick={onClick}>
        X
      </Button>,
    );
    const b = screen.getByRole("button", { name: "X" });
    expect(b).toHaveAttribute("type", "submit");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

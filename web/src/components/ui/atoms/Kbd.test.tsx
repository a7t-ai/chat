import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Kbd } from "./Kbd";

describe("Kbd", () => {
  test("renders a <kbd> element with the ui-kbd class and its content", () => {
    render(<Kbd>⌘</Kbd>);
    const el = screen.getByText("⌘");
    expect(el.tagName).toBe("KBD");
    expect(el).toHaveClass("ui-kbd");
  });

  test("merges an extra className", () => {
    render(<Kbd className="x">A</Kbd>);
    expect(screen.getByText("A")).toHaveClass("ui-kbd", "x");
  });
});

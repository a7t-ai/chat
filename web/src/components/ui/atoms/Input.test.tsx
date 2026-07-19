import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Input, TextArea } from "./Input";

describe("Input / TextArea", () => {
  test("Input renders an .input text field and forwards props", () => {
    render(<Input placeholder="name" defaultValue="Leo" />);
    const el = screen.getByPlaceholderText("name") as HTMLInputElement;
    expect(el.tagName).toBe("INPUT");
    expect(el).toHaveClass("input");
    expect(el.value).toBe("Leo");
  });

  test("TextArea renders a .input textarea", () => {
    render(<TextArea placeholder="notes" />);
    const el = screen.getByPlaceholderText("notes");
    expect(el.tagName).toBe("TEXTAREA");
    expect(el).toHaveClass("input");
  });

  test("merges an extra className", () => {
    render(<Input className="mono" aria-label="x" />);
    expect(screen.getByLabelText("x")).toHaveClass("input", "mono");
  });
});

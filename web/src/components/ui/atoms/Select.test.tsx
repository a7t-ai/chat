import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Select } from "./Select";

describe("Select", () => {
  test("renders an .input <select> and forwards props", () => {
    render(
      <Select aria-label="role" defaultValue="edit">
        <option value="view">View</option>
        <option value="edit">Edit</option>
      </Select>,
    );
    const el = screen.getByLabelText("role") as HTMLSelectElement;
    expect(el.tagName).toBe("SELECT");
    expect(el).toHaveClass("input");
    expect(el.value).toBe("edit");
  });

  test("merges an extra className", () => {
    render(
      <Select aria-label="x" className="collab-role">
        <option value="a">A</option>
      </Select>,
    );
    expect(screen.getByLabelText("x")).toHaveClass("input", "collab-role");
  });
});

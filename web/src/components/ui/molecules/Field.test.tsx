import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Field } from "./Field";

describe("Field", () => {
  test("renders a bound <label> when htmlFor is given", () => {
    render(
      <Field label="Name" htmlFor="n">
        <input id="n" />
      </Field>,
    );
    const label = screen.getByText("Name");
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveAttribute("for", "n");
  });

  test("renders a <span> label when htmlFor is omitted (a group of controls)", () => {
    render(
      <Field label="Font">
        <button>Sans</button>
      </Field>,
    );
    expect(screen.getByText("Font").tagName).toBe("SPAN");
  });

  test("shows a hint", () => {
    render(
      <Field label="X" hint="helper text">
        <input />
      </Field>,
    );
    expect(screen.getByText("helper text")).toBeInTheDocument();
  });

  test("renders an error as an alert InlineMessage", () => {
    render(
      <Field label="X" error="Required">
        <input />
      </Field>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
  });

  test("no label element when label is omitted", () => {
    const { container } = render(
      <Field>
        <input />
      </Field>,
    );
    expect(container.querySelector(".pref-label")).toBeNull();
  });
});

import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { KeyCombo } from "./KeyCombo";

describe("KeyCombo", () => {
  test("renders one Kbd per key, in order", () => {
    const { container } = render(<KeyCombo keys={["⌘", "⇧", "K"]} />);
    const kbds = container.querySelectorAll("kbd.ui-kbd");
    expect(kbds).toHaveLength(3);
    expect([...kbds].map((k) => k.textContent)).toEqual(["⌘", "⇧", "K"]);
  });

  test("an empty chord renders no keys", () => {
    const { container } = render(<KeyCombo keys={[]} />);
    expect(container.querySelectorAll("kbd")).toHaveLength(0);
  });
});

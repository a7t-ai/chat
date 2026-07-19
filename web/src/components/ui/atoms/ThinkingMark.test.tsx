import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ThinkingMark } from "./ThinkingMark";

describe("ThinkingMark", () => {
  test("renders the three pulsing bars in an animated svg", () => {
    const { container } = render(<ThinkingMark />);
    const svg = container.querySelector("svg.ui-thinking-mark");
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll("rect.tb")).toHaveLength(3);
  });

  test("accepts a custom size", () => {
    const { container } = render(<ThinkingMark size={32} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "32");
  });
});

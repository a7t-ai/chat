import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { TempChatIcon } from "./TempChatIcon";

// TempChatIcon is the dashed speech-bubble glyph (a thin wrapper over Lucide's
// MessageCircleDashed). Pure render — assert it honors its size default + override and
// forwards a className, since those are the only inputs.

describe("TempChatIcon", () => {
  test("renders an svg with the default size", () => {
    const { container } = render(<TempChatIcon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("width", "18");
    expect(svg).toHaveAttribute("height", "18");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  test("honors a custom size for both width and height", () => {
    const { container } = render(<TempChatIcon size={40} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "40");
    expect(svg).toHaveAttribute("height", "40");
  });

  test("forwards a className", () => {
    const { container } = render(<TempChatIcon className="topbar-ico" />);
    expect(container.querySelector("svg")).toHaveClass("topbar-ico");
  });
});

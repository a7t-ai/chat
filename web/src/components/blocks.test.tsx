import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { BLOCK_ICONS, BlockAct, BlockBar, BlockFrame } from "./blocks";

// blocks.tsx is the shared toolbar primitive set for rich markdown blocks. Cover the frame's
// className merge, the bar's label slot, and the act button's toggle/aria wiring + click.

describe("BlockFrame", () => {
  test("merges the base class with a passed className and forwards props", () => {
    const { container } = render(<BlockFrame className="code-block" data-testid="frame" />);
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveClass("block-frame");
    expect(el).toHaveClass("code-block");
    expect(el).toHaveAttribute("data-testid", "frame");
  });

  test("trims to just the base class when no className is given", () => {
    const { container } = render(<BlockFrame />);
    expect((container.firstChild as HTMLElement).className).toBe("block-frame");
  });
});

describe("BlockBar", () => {
  test("renders the label slot and its action children", () => {
    render(
      <BlockBar label={<span>shell</span>}>
        <button type="button">act</button>
      </BlockBar>,
    );
    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "act" })).toBeInTheDocument();
  });

  test("renders an (empty) label slot even when omitted", () => {
    const { container } = render(
      <BlockBar>
        <span>child</span>
      </BlockBar>,
    );
    expect(container.querySelector(".block-label")).not.toBeNull();
  });
});

describe("BlockAct", () => {
  test("fires onClick", async () => {
    const onClick = vi.fn();
    render(<BlockAct icon={BLOCK_ICONS.copy} title="Copy" onClick={onClick} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("falls back to the title for aria-label when no label is given", () => {
    render(<BlockAct icon={BLOCK_ICONS.copy} title="Copy" onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Copy");
  });

  test("uses an explicit label for aria-label and marks active state", () => {
    render(<BlockAct icon={BLOCK_ICONS.wrap} title="Wrap" label="Wrap lines" on pressed onClick={() => {}} />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-label", "Wrap lines");
    expect(btn).toHaveClass("on");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  test("is not active by default", () => {
    render(<BlockAct icon={BLOCK_ICONS.copy} title="Copy" onClick={() => {}} />);
    expect(screen.getByRole("button").className).toBe("block-act");
  });
});

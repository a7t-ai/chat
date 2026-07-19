import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CodeBlock } from "./CodeBlock";

// CodeBlock renders a fenced code block with our own toolbar: a wrap toggle, copy (to
// clipboard), and download (Blob → anchor). Highlight.js is real (works in jsdom); we mock
// clipboard + URL object-URL plumbing and assert the toolbar behavior + branches.

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CodeBlock", () => {
  test("shows the language label and highlights a known language", () => {
    const { container } = render(<CodeBlock code="const x = 1;" language="javascript" />);
    expect(screen.getByText("javascript")).toBeInTheDocument();
    // hljs adds .hljs-* spans for known languages.
    expect(container.querySelector("code.hljs")).not.toBeNull();
  });

  test("falls back to the 'text' label for an empty language", () => {
    render(<CodeBlock code="plain" language="" />);
    expect(screen.getByText("text")).toBeInTheDocument();
  });

  test("escapes the code (no markup leaks) for an unknown language", () => {
    const { container } = render(<CodeBlock code="<b>&amp;</b>" language="nope-lang" />);
    const code = container.querySelector("code.hljs") as HTMLElement;
    // The raw < was escaped, so no real <b> element exists inside.
    expect(code.querySelector("b")).toBeNull();
    expect(code.textContent).toContain("<b>");
  });

  test("copy writes the code to the clipboard and flips the icon", async () => {
    render(<CodeBlock code="copy me" language="text" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("copy me");
  });

  test("the wrap toggle flips the pre's wrap class and aria-pressed", async () => {
    const { container } = render(<CodeBlock code="x" language="text" />);
    const wrapBtn = screen.getByRole("button", { name: "Wrap lines" });
    expect(container.querySelector("pre")).not.toHaveClass("wrap");
    await userEvent.click(wrapBtn);
    expect(container.querySelector("pre")).toHaveClass("wrap");
    // The label/title swaps once wrapped.
    expect(screen.getByRole("button", { name: "No wrap" })).toHaveAttribute("aria-pressed", "true");
  });

  test("download builds a blob URL with the language-derived extension", async () => {
    render(<CodeBlock code="print(1)" language="python" />);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "Download code" }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    clickSpy.mockRestore();
  });

  test("download falls back to .txt for an unmapped language", async () => {
    render(<CodeBlock code="x" language="brainfuck" />);
    const anchors: HTMLAnchorElement[] = [];
    const orig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "a") {
        vi.spyOn(el as HTMLAnchorElement, "click").mockImplementation(() => {});
        anchors.push(el as HTMLAnchorElement);
      }
      return el;
    });
    fireEvent.click(screen.getByRole("button", { name: "Download code" }));
    await waitFor(() => expect(anchors.length).toBe(1));
    expect(anchors[0].download).toBe("snippet.txt");
  });
});

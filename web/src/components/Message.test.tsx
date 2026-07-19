import { createElement, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import { encodeCapability } from "../capabilities/remark";

// Streamdown pulls a heavy markdown pipeline; per the test rules we stub it. Our stub renders
// the raw children AND drives Message's own `components` overrides (the <pre>/<table>/<span>
// renderers it passes in) so those code paths — fenced code → CodeBlock, table → TableBlock,
// capability span → chip, and the childrenToText flattener — are exercised too. The override
// set is exposed on a global so a dedicated test can invoke them with crafted nodes.
type MdComponents = {
  pre: (p: { children?: ReactNode }) => ReactNode;
  table: (p: { children?: ReactNode }) => ReactNode;
  span: (p: { children?: ReactNode; node?: unknown }) => ReactNode;
  input?: (p: { type?: string; checked?: boolean; node?: unknown }) => ReactNode;
};
let captured: MdComponents | null = null;

vi.mock("streamdown", () => ({
  Streamdown: ({ children, components }: { children?: ReactNode; components?: MdComponents }) => {
    captured = components ?? null;
    return <div data-testid="md">{children}</div>;
  },
}));

import { CapabilityProvider } from "../capabilities/context";
import { Message, TodoCheckedContext } from "./Message";

beforeEach(() => installLocalStorage());
afterEach(() => vi.restoreAllMocks());

describe("Message — roles", () => {
  test("a system message renders a bare system row", () => {
    const { container } = render(<Message role="system" content="server note" />);
    expect(container.querySelector(".msg.system")?.textContent).toBe("server note");
    // No action buttons for system rows.
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("an assistant message renders its content through the markdown renderer", () => {
    render(<Message role="assistant" content="Hello **world**" id="m1" />);
    expect(screen.getByTestId("md")).toHaveTextContent("Hello **world**");
  });

  test("a user message linkifies bare URLs into anchors", () => {
    render(<Message role="user" content="see https://a7t.ai/docs. thanks" />);
    const link = screen.getByRole("link", { name: "https://a7t.ai/docs" });
    expect(link).toHaveAttribute("href", "https://a7t.ai/docs");
    expect(link).toHaveAttribute("target", "_blank");
  });

  test("a user message prefixes www. links with https://", () => {
    render(<Message role="user" content="www.example.com" />);
    expect(screen.getByRole("link", { name: "www.example.com" })).toHaveAttribute(
      "href",
      "https://www.example.com",
    );
  });
});

describe("Message — in-flight indicators", () => {
  test("an empty in-flight assistant turn shows the thinking verb", () => {
    render(<Message role="assistant" content="" inFlight queuePosition={0} />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  test("a queued turn shows its queue position", () => {
    render(<Message role="assistant" content="" inFlight queuePosition={3} />);
    expect(screen.getByText("Waiting · #3 in queue")).toBeInTheDocument();
  });

  test("the web-search phase shows the search status instead of thinking", () => {
    render(<Message role="assistant" content="" inFlight search={{ stage: "searching", queries: [] }} />);
    expect(screen.getByText("Searching the web…")).toBeInTheDocument();
  });

  test("the reading stage reports the source count", () => {
    render(<Message role="assistant" content="" inFlight search={{ stage: "reading", count: 4 }} />);
    expect(screen.getByText("Reading 4 sources…")).toBeInTheDocument();
  });

  test("a search error stage shows the unavailable note", () => {
    render(<Message role="assistant" content="" inFlight search={{ stage: "error", message: "x" }} />);
    expect(screen.getByText(/Web search unavailable/)).toBeInTheDocument();
  });

  test("an empty stopped assistant turn renders nothing in the body (no indicator)", () => {
    render(<Message role="assistant" content="" stopped />);
    expect(screen.queryByText("Thinking…")).toBeNull();
    expect(screen.getByText("You stopped this response.")).toBeInTheDocument();
  });
});

describe("Message — sources", () => {
  test("renders cited sources as out-links", () => {
    render(
      <Message
        role="assistant"
        content="answer"
        id="m1"
        sources={[{ n: 1, title: "Docs", url: "https://a7t.ai", domain: "a7t.ai" }]}
      />,
    );
    expect(screen.getByText("1 sources")).toBeInTheDocument();
    const chip = screen.getByRole("link", { name: /Docs/ });
    expect(chip).toHaveAttribute("href", "https://a7t.ai");
    expect(chip).toHaveAttribute("title", "Docs — https://a7t.ai");
  });

  test("renders no sources block for an empty list", () => {
    render(<Message role="assistant" content="answer" id="m1" sources={[]} />);
    expect(screen.queryByText(/sources/)).toBeNull();
  });
});

describe("Message — attachments (files-to-prompt)", () => {
  const att = { id: "f1", name: "notes.txt", contentType: "text/plain", size: 2048 };

  test("renders a user message's attachments as read-only chips (name + size)", () => {
    render(<Message role="user" content="here" attachments={[att]} />);
    const list = screen.getByRole("list", { name: "Attachments" });
    expect(list).toBeInTheDocument();
    expect(screen.getByTitle("notes.txt")).toHaveTextContent("notes.txt");
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    // Read-only: no remove control (unlike the composer's pending chips).
    expect(screen.queryByRole("button", { name: "Remove attachment" })).toBeNull();
  });

  test("renders nothing for an empty attachments list", () => {
    render(<Message role="user" content="here" attachments={[]} />);
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  test("does not render attachments on an assistant message", () => {
    render(<Message role="assistant" content="answer" id="m1" attachments={[att]} />);
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });
});

describe("Message — action buttons", () => {
  function assistant(props: Partial<Parameters<typeof Message>[0]> = {}) {
    render(<Message role="assistant" content="answer text" id="m1" {...props} />);
  }

  test("copy writes content to the clipboard and flips the icon", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    assistant();
    const copyBtn = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(copyBtn);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("answer text"));
    vi.useRealTimers();
  });

  test("speak starts speech synthesis and toggles to stop", () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak, cancel });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      vi.fn(function (this: Record<string, unknown>, text: string) {
        this.text = text;
      }),
    );
    assistant();
    const speakBtn = screen.getByRole("button", { name: "Speak" });
    fireEvent.click(speakBtn);
    expect(speak).toHaveBeenCalledTimes(1);
    // Now labelled Stop (toggle on).
    const stopBtn = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(stopBtn);
    // cancel called twice (once per click, at the top of toggleSpeak).
    expect(cancel).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Speak" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  test("speak swallows a missing speechSynthesis (no throw)", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    assistant();
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Speak" }))).not.toThrow();
    vi.unstubAllGlobals();
  });

  test("upvote toggles on, then off, calling onVote with the right value", () => {
    const onVote = vi.fn();
    assistant({ onVote, vote: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Good reply" }));
    expect(onVote).toHaveBeenCalledWith("m1", 1);
  });

  test("an already-upvoted message toggles back to 0", () => {
    const onVote = vi.fn();
    assistant({ onVote, vote: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Good reply" }));
    expect(onVote).toHaveBeenCalledWith("m1", 0);
  });

  test("downvote toggles to -1", () => {
    const onVote = vi.fn();
    assistant({ onVote, vote: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Bad reply" }));
    expect(onVote).toHaveBeenCalledWith("m1", -1);
  });

  test("retry button fires onRetry when provided", () => {
    const onRetry = vi.fn();
    assistant({ onRetry });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("branch button fires onBranch on an assistant message when provided", () => {
    const onBranch = vi.fn();
    assistant({ onBranch });
    fireEvent.click(screen.getByRole("button", { name: "Branch into a new chat" }));
    expect(onBranch).toHaveBeenCalledTimes(1);
  });

  test("no branch button when onBranch is absent", () => {
    assistant();
    expect(screen.queryByRole("button", { name: "Branch into a new chat" })).toBeNull();
  });

  test("branch button fires onBranch on a user message when provided", () => {
    const onBranch = vi.fn();
    render(<Message role="user" content="my question" onBranch={onBranch} />);
    fireEvent.click(screen.getByRole("button", { name: "Branch into a new chat" }));
    expect(onBranch).toHaveBeenCalledTimes(1);
  });

  test("no action row when content is empty and there are no variants", () => {
    render(<Message role="assistant" content="" id="m1" />);
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});

describe("Message — variant navigator", () => {
  test("renders n/m and disables prev at the first variant", () => {
    const onVariantNext = vi.fn();
    render(
      <Message
        role="assistant"
        content="v1"
        id="m1"
        variantCount={2}
        variantIndex={0}
        onVariantPrev={() => {}}
        onVariantNext={onVariantNext}
      />,
    );
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous answer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next answer" }));
    expect(onVariantNext).toHaveBeenCalledTimes(1);
  });

  test("disables next at the last variant", () => {
    render(
      <Message role="assistant" content="v2" id="m1" variantCount={2} variantIndex={1} />,
    );
    expect(screen.getByRole("button", { name: "Next answer" })).toBeDisabled();
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });
});

describe("Message — stopped continue", () => {
  test("a stopped turn with content offers a Continue button", () => {
    const onContinue = vi.fn();
    render(<Message role="assistant" content="partial" id="m1" stopped onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe("Message — user actions", () => {
  test("shows the date, edit, retry, and copy controls", () => {
    const onEdit = vi.fn();
    const onRetry = vi.fn();
    render(<Message role="user" content="hi" createdAt={Date.UTC(2026, 5, 14)} onEdit={onEdit} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // A formatted date label is present.
    expect(screen.getByText(/Jun/)).toBeInTheDocument();
  });
});

describe("Message — markdown component overrides", () => {
  // Render an assistant message so Message hands its `components` map to our Streamdown stub,
  // then invoke each override directly with crafted nodes (what streamdown would feed them).
  function getComponents(): MdComponents {
    captured = null;
    render(<Message role="assistant" content="anything" id="m1" />);
    if (!captured) throw new Error("components were not captured");
    return captured;
  }

  test("the <pre> override renders a fenced code block (language + flattened text)", () => {
    const comps = getComponents();
    // streamdown passes <pre> a single <code class="language-ts"> child whose children are
    // the (possibly nested) source text — childrenToText must flatten it.
    const code = createElement(
      "code",
      { className: "language-ts" },
      ["const ", createElement("span", { key: "a" }, "x"), " = 1;\n"],
    );
    const out = comps.pre({ children: code });
    const { container } = render(<>{out}</>);
    // CodeBlock shows the language label.
    expect(container.querySelector(".code-lang")?.textContent).toBe("ts");
    // Trailing newline trimmed, nested text flattened.
    expect(container.textContent).toContain("const x = 1;");
  });

  test("the <pre> override passes non-code children straight through", () => {
    const comps = getComponents();
    const out = comps.pre({ children: "just text, no <code>" });
    const { container } = render(<>{out}</>);
    expect(container.querySelector("pre")?.textContent).toBe("just text, no <code>");
    expect(container.querySelector(".code-block")).toBeNull();
  });

  test("the <table> override wraps children in our TableBlock", () => {
    const comps = getComponents();
    const out = comps.table({ children: createElement("tbody", {}, createElement("tr", {}, createElement("td", {}, "v"))) });
    const { container } = render(<>{out}</>);
    expect(container.querySelector("table.md-table")?.textContent).toContain("v");
  });

  test("the <span> override swaps a capability marker for its chip", () => {
    const comps = getComponents();
    const out = comps.span({ children: encodeCapability("map", "Lisbon, Portugal") });
    const { container } = render(<>{out}</>);
    expect(container.querySelector(".map-chip")?.textContent).toBe("Lisbon");
  });

  test("the <span> override passes a non-marker span through unchanged", () => {
    const comps = getComponents();
    const out = comps.span({ children: "plain inline" });
    const { container } = render(<>{out}</>);
    expect(container.querySelector("span")?.textContent).toBe("plain inline");
    expect(container.querySelector(".map-chip")).toBeNull();
  });
});

describe("Message — interactive TODO checkboxes (shared page)", () => {
  // Render a shared assistant message so Message hands its `components` (with the interactive
  // `input` override) to the Streamdown stub, then return the captured set. The throw-guard
  // re-widens `captured` away from the `null` we reset it to (mirrors getComponents above).
  function toggleComponents(content: string, onToggle: (i: number, d: boolean) => void): MdComponents {
    captured = null;
    render(<Message role="assistant" content={content} id="m1" onToggleTodo={onToggle} />);
    if (!captured) throw new Error("components were not captured");
    return captured;
  }

  // Without onToggleTodo, the base component set is used (no interactive `input` override) —
  // task-list checkboxes render read-only, exactly as in the normal chat.
  test("no `input` override unless onToggleTodo is provided", () => {
    captured = null;
    render(<Message role="assistant" content="- [ ] a" id="m1" />);
    if (!captured) throw new Error("components were not captured");
    const comps: MdComponents = captured;
    expect(comps.input).toBeUndefined();
  });

  // With onToggleTodo, streamdown's checkbox is replaced by an enabled, controlled one whose CHECKED
  // state comes from TodoCheckedContext (by ordinal — NOT streamdown's cached parse, which won't
  // repaint a same-length flip, #138) and whose change reports the item's 0-based ordinal + the next
  // state. Streamdown is stubbed here, so we drive the override with the {type:"checkbox"} nodes it
  // hands us, wrapped in the Provider the way Message wraps its real Streamdown; that streamdown
  // really passes one node per checkbox in document order is pinned against the real library in
  // todo-ordinal.test.tsx, and the end-to-end repaint in todo-repaint.test.tsx.
  test("wires each checkbox to onToggleTodo with its ordinal index and next state", () => {
    const onToggle = vi.fn();
    const input = toggleComponents("- [ ] a\n- [x] b", onToggle).input;
    if (!input) throw new Error("input override not captured");

    // Context says: item 0 unchecked, item 1 checked (mirrors the content above).
    const withStates = (node: ReactNode) => (
      <TodoCheckedContext.Provider value={[false, true]}>{node}</TodoCheckedContext.Provider>
    );

    // First checkbox (index 0) reads context[0] = false → renders unchecked; a click ticks it.
    const first = render(withStates(input({ type: "checkbox" })));
    const box0 = first.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box0).not.toBeDisabled();
    expect(box0.checked).toBe(false);
    fireEvent.click(box0);
    expect(onToggle).toHaveBeenLastCalledWith(0, true);

    // Second checkbox (index 1) reads context[1] = true → renders checked; a click unticks it.
    const second = render(withStates(input({ type: "checkbox" })));
    const box1 = second.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box1.checked).toBe(true);
    fireEvent.click(box1);
    expect(onToggle).toHaveBeenLastCalledWith(1, false);
  });

  test("an ordinal with no context state (e.g. still loading) renders unchecked", () => {
    const input = toggleComponents("- [ ] a", vi.fn()).input;
    if (!input) throw new Error("input override not captured");
    // No Provider → context default [] → the checkbox falls back to unchecked.
    const { container } = render(<>{input({ type: "checkbox" })}</>);
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  });

  test("passes non-checkbox inputs through untouched", () => {
    const input = toggleComponents("x", vi.fn()).input;
    if (!input) throw new Error("input override not captured");
    const { container } = render(<>{input({ type: "text" })}</>);
    expect((container.querySelector("input") as HTMLInputElement).type).toBe("text");
  });
});

describe("Message — bulk capability action", () => {
  test("offers a single bulk button when >=2 map markers are present, opening all on click", async () => {
    const open = vi.fn();
    const content = "Visit [[map:Lisbon, Portugal]] then [[map:Porto, Portugal]].";
    render(
      <CapabilityProvider value={open}>
        <Message role="assistant" content={content} id="m1" />
      </CapabilityProvider>,
    );
    const bulk = screen.getByRole("button", { name: /Show all 2 places/ });
    await userEvent.click(bulk);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, "map", "Lisbon, Portugal");
    expect(open).toHaveBeenNthCalledWith(2, "map", "Porto, Portugal");
  });

  test("no bulk action for a single marker", () => {
    const content = "Just [[map:Lisbon, Portugal]].";
    render(<Message role="assistant" content={content} id="m1" />);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  test("no bulk action on a user message even with markers", () => {
    const content = "[[map:A]] [[map:B]]";
    render(<Message role="user" content={content} />);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

describe("Message — reasoning / thinking (#68)", () => {
  test("renders a collapsed-by-default 'Reasoning' disclosure above the answer", () => {
    const { container } = render(
      <Message role="assistant" content="the final answer" reasoning="step one, step two" id="m1" />,
    );
    const details = container.querySelector("details.reasoning");
    expect(details).not.toBeNull();
    // Collapsed by default — no `open` attribute (the power-user expands it).
    expect((details as HTMLDetailsElement).open).toBe(false);
    // The label + the thinking text are present (details keeps children in the DOM when collapsed).
    expect(container.querySelector(".reasoning-label")?.textContent).toBe("Reasoning");
    expect(details?.textContent).toContain("step one, step two");
  });

  test("shows no reasoning section when the reply carries none (graceful degradation)", () => {
    const { container } = render(<Message role="assistant" content="plain answer" id="m1" />);
    expect(container.querySelector(".reasoning")).toBeNull();
  });

  test("never shows reasoning on a user message", () => {
    const { container } = render(<Message role="user" content="my question" reasoning="leaked?" />);
    expect(container.querySelector(".reasoning")).toBeNull();
  });

  test("marks the disclosure live while the turn is still streaming", () => {
    const { container } = render(
      <Message role="assistant" content="" reasoning="thinking…" inFlight />,
    );
    expect(container.querySelector(".reasoning")).not.toBeNull();
    expect(container.querySelector(".reasoning-live")).not.toBeNull();
  });
});

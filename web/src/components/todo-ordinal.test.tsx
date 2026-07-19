import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import remarkGfm from "remark-gfm";
import { Streamdown } from "streamdown";
import { setTaskItem } from "../lib/todos";

// The one integration test the whole shared-TODO feature hinges on, run against the REAL
// Streamdown (unmocked, unlike Message.test.tsx / WatchView.test.tsx). The feature maps two
// independently-computed ordinals: the client DOM counter (Message.tsx increments once per
// checkbox streamdown renders) and the regex walk in src/chat/todos.ts + web/src/lib/todos.ts
// (counts TASK_ITEM_RE matches over the raw markdown). If those diverge, a viewer's click
// toggles the wrong line (#53 review). This pins the contract: streamdown honors the `input`
// override AND emits <input type="checkbox"> in the SAME document order the mirror walk counts,
// so index N always names the same task item on both sides.

// Render the real Streamdown with the exact `input` override Message.tsx installs, capturing the
// checked-state each checkbox is rendered with, in call (document) order.
function renderCheckboxSequence(content: string): boolean[] {
  const seq: boolean[] = [];
  // Mirror Message.tsx: the `input` override is built into a components object passed as a
  // variable (relaxing tsc's inline-literal prop check the same way the component does).
  const components = {
    input: ({ type, checked, node, ...rest }: { type?: string; checked?: boolean; node?: unknown }) => {
      if (type === "checkbox") {
        seq.push(!!checked);
        return <input type="checkbox" readOnly checked={!!checked} />;
      }
      return <input type={type} {...rest} />;
    },
  };
  render(
    <Streamdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </Streamdown>,
  );
  return seq;
}

// The client mirror's rendered-checkbox count: probe setTaskItem at rising indices until it
// rejects (out of range → null), which is exactly how many items eachTaskItem visited.
function mirrorCheckboxCount(content: string): number {
  let n = 0;
  while (setTaskItem(content, n, true) !== null) n++;
  return n;
}

describe("streamdown ↔ mirror ordinal contract (real Streamdown)", () => {
  test("streamdown renders GFM checkboxes in the same order and count the mirror walk sees", () => {
    // A document mixing every ambiguity the mirror walk guards: a fenced-code look-alike and a
    // no-space bracket that render NO checkbox, plus a blockquoted task that DOES. Only alpha,
    // beta, gamma are real checkboxes — in that order, with beta pre-checked.
    const md = [
      "- [ ] alpha",
      "- [x] beta",
      "",
      "```md",
      "- [ ] fenced-lookalike",
      "```",
      "",
      "> - [ ] gamma",
      "",
      "- [ ]delta",
    ].join("\n");

    const rendered = renderCheckboxSequence(md);
    // Streamdown skips the fenced look-alike and the no-space `delta`, and unwraps the blockquote.
    expect(rendered).toEqual([false, true, false]);
    // The mirror walk must agree on the count, or every ordinal after a skipped line would drift.
    expect(mirrorCheckboxCount(md)).toBe(rendered.length);
  });

  test("each DOM ordinal names the same source item the mirror toggles at that index", () => {
    const md = "- [ ] one\n- [ ] two\n- [ ] three";
    const rendered = renderCheckboxSequence(md);
    expect(rendered).toEqual([false, false, false]);
    // Ticking DOM ordinal 1 must flip exactly the second source item — the mirror's index 1.
    expect(setTaskItem(md, 1, true)).toBe("- [ ] one\n- [x] two\n- [ ] three");
  });
});

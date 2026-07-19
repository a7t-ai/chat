import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test } from "vitest";
import type { CatalogModel } from "../lib/api";
import { ModelPicker } from "./ModelPicker";

// A small mock catalog: a free local model, a $$ pro BYOK model, and a $$$ ultra BYOK model — enough
// that the selected-state (check beside the name + accent tint) and the tag cluster both render.
const MODELS = ["qwen", "gpt-5", "opus"];
const LABELS: Record<string, string> = { qwen: "Qwen 3", "gpt-5": "GPT-5", opus: "Claude Opus 4" };
const CATALOG: Record<string, CatalogModel> = {
  qwen: { id: "qwen", displayName: "Qwen 3", input: ["text"], tier: "free", byokOnly: false, provider: "qwen", recommendedFor: ["chat"] },
  "gpt-5": { id: "gpt-5", displayName: "GPT-5", input: ["text"], tier: "pro", byokOnly: true, provider: "openai", recommendedFor: ["coding"] },
  opus: { id: "opus", displayName: "Claude Opus 4", input: ["text"], tier: "ultra", byokOnly: true, provider: "anthropic", recommendedFor: ["reasoning"] },
};

// A tiny harness that owns the selection so a click actually moves the active row (mirrors ChatView).
function Harness({ initial = "qwen" }: { initial?: string }) {
  const [model, setModel] = useState(initial);
  return (
    <ModelPicker
      inline
      model={model}
      models={MODELS}
      labels={LABELS}
      catalog={CATALOG}
      onSelect={setModel}
      disabled={false}
      openNonce={0}
    />
  );
}

const row = (list: HTMLElement, name: string) => within(list).getByText(name).closest(".model-option") as HTMLElement;

describe("ModelPicker selected-state (#144)", () => {
  test("only the current model's row is active, and the check lives beside the name (not among the badges)", () => {
    render(<Harness initial="gpt-5" />);
    const list = screen.getByRole("listbox", { name: "Select model" });

    // Exactly the selected row carries `.active`; the option button reports aria-selected.
    expect(row(list, "GPT-5")).toHaveClass("active");
    expect(row(list, "Qwen 3")).not.toHaveClass("active");
    expect(within(row(list, "GPT-5")).getByRole("option")).toHaveAttribute("aria-selected", "true");

    // Every row reserves the leading check slot (so names align + badges never shift), and the check
    // sits in that LEADING slot before the name — never inside the right-side `.model-option-tags`.
    for (const name of ["Qwen 3", "GPT-5", "Claude Opus 4"]) {
      const r = row(list, name);
      const lead = r.querySelector(".model-option-lead");
      expect(lead).not.toBeNull();
      expect(lead?.querySelector(".model-option-check")).not.toBeNull();
      expect(r.querySelector(".model-option-tags")?.querySelector(".model-option-check")).toBeNull();
      // The leading slot precedes the name in DOM order (so it renders to its left).
      const main = r.querySelector(".model-option-main") as HTMLElement;
      const kids = Array.from(main.children);
      expect(kids.indexOf(lead as Element)).toBeLessThan(kids.indexOf(main.querySelector(".model-option-name") as Element));
    }
  });

  test("selecting another model moves the active state without touching the badges", async () => {
    render(<Harness initial="gpt-5" />);
    const list = screen.getByRole("listbox", { name: "Select model" });
    // The $$$ badge belongs to the ultra row and must stay put regardless of the selection.
    expect(within(row(list, "Claude Opus 4")).getByText("$$$")).toBeInTheDocument();

    await userEvent.click(within(list).getByText("Claude Opus 4"));

    expect(row(list, "Claude Opus 4")).toHaveClass("active");
    expect(row(list, "GPT-5")).not.toHaveClass("active");
    // The badge is still on its row (the check moved via the reserved slot, not by re-flowing badges).
    expect(within(row(list, "Claude Opus 4")).getByText("$$$")).toBeInTheDocument();
    expect(within(row(list, "Claude Opus 4")).getByText("BYOK")).toBeInTheDocument();
  });
});

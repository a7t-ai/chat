import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { ContextUsage } from "../lib/api";
import { CompactionBanner } from "./CompactionBanner";

function usage(over: Partial<ContextUsage> = {}): ContextUsage {
  return { usedTokens: 20000, windowTokens: 32768, ratio: 0.61, shouldPrompt: false, showMeter: true, ...over };
}

const noop = () => {};

describe("CompactionBanner", () => {
  test("renders nothing until the thread is long enough (showMeter false)", () => {
    const { container } = render(
      <CompactionBanner context={usage({ showMeter: false })} dismissed={false} compacting={false} onCompact={noop} onDismiss={noop} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("shows a subtle meter with a percent label but no nudge below the limit", () => {
    render(<CompactionBanner context={usage({ ratio: 0.6, shouldPrompt: false })} dismissed={false} compacting={false} onCompact={noop} onDismiss={noop} />);
    expect(screen.getByText("60% of context used")).toBeInTheDocument();
    // No compact action while below the prompt threshold.
    expect(screen.queryByRole("button", { name: "Compact" })).not.toBeInTheDocument();
    const meter = screen.getByRole("progressbar");
    expect(meter).toHaveAttribute("aria-valuenow", "60");
  });

  test("near the limit it grows the compact nudge + a compact button", async () => {
    const onCompact = vi.fn();
    render(<CompactionBanner context={usage({ ratio: 0.82, shouldPrompt: true })} dismissed={false} compacting={false} onCompact={onCompact} onDismiss={noop} />);
    expect(screen.getByText("This chat is filling the context window.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  test("dismissing the nudge hides it but keeps the meter", () => {
    render(<CompactionBanner context={usage({ ratio: 0.82, shouldPrompt: true })} dismissed={true} compacting={false} onCompact={noop} onDismiss={noop} />);
    // The meter stays (still shows usage) but the nudge/message + compact button are gone.
    expect(screen.getByText("82% of context used")).toBeInTheDocument();
    expect(screen.queryByText("This chat is filling the context window.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compact" })).not.toBeInTheDocument();
  });

  test("the dismiss X fires onDismiss", async () => {
    const onDismiss = vi.fn();
    render(<CompactionBanner context={usage({ ratio: 0.82, shouldPrompt: true })} dismissed={false} compacting={false} onCompact={noop} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("while compacting the button is disabled and shows the working label", () => {
    const onCompact = vi.fn();
    render(<CompactionBanner context={usage({ ratio: 0.82, shouldPrompt: true })} dismissed={false} compacting={true} onCompact={onCompact} onDismiss={noop} />);
    const btn = screen.getByRole("button", { name: "Compacting..." });
    expect(btn).toBeDisabled();
  });
});

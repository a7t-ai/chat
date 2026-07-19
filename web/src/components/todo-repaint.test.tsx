import { useState } from "react";
import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import { CapabilityProvider } from "../capabilities/context";
import { setTaskItem } from "../lib/todos";
import { Message } from "./Message";

// End-to-end regression for #138, run against the REAL Streamdown + REAL Message + REAL TimerChip
// (only the audio/notification side effects are stubbed). It reproduces the actual bug: streamdown
// memoizes an already-rendered block and won't re-render it for a same-length `[ ]`↔`[x]` flip, so
// the owner-side checkbox stayed visually stuck until a page refresh. The fix routes the checkbox's
// checked state through a context Message controls, which repaints it immediately — with NO refetch
// or poll (this test never calls a server) and WITHOUT remounting the block, so a running timer
// co-located in the same recipe message keeps counting.

// Stub the timer's alarm so starting it never touches real WebAudio / Notification.
vi.mock("../capabilities/assistant/timer/alarm", () => ({
  unlockAudio: vi.fn(),
  requestNotifyPermission: vi.fn(),
  notifyDone: vi.fn(() => false),
  playChime: vi.fn(() => ({ stop: vi.fn() })),
}));

installLocalStorage();
afterEach(() => vi.restoreAllMocks());

// A minimal host that mirrors ChatView.onToggleTodo's OPTIMISTIC path only: flip the checkbox in
// the message content locally (setTaskItem) and re-render. There is deliberately no server call and
// no poll here — so a passing repaint proves the client alone repaints the box.
function Host({ initial }: { initial: string }) {
  const [content, setContent] = useState(initial);
  return (
    <CapabilityProvider value={() => {}}>
      <Message
        role="assistant"
        content={content}
        id="m1"
        onToggleTodo={(index, done) => setContent((c) => setTaskItem(c, index, done) ?? c)}
      />
    </CapabilityProvider>
  );
}

// A recipe message: a shopping task-list block PLUS a step carrying a live `[[timer:…]]` countdown.
const RECIPE = ["- [ ] Pasta", "- [ ] Salt", "", "1. Boil the water [[timer:10m|Boil]]"].join("\n");

describe("owner task-list checkbox repaint (#138, real Streamdown)", () => {
  test("ticking a checkbox repaints it immediately, no refetch", () => {
    const { container } = render(<Host initial={"- [ ] Pasta\n- [ ] Salt"} />);
    const boxes = () => [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes().map((b) => b.checked)).toEqual([false, false]);

    fireEvent.click(boxes()[0]);
    // Repaints synchronously off the optimistic content flip alone.
    expect(boxes().map((b) => b.checked)).toEqual([true, false]);

    fireEvent.click(boxes()[1]);
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);

    // And it un-ticks just as immediately.
    fireEvent.click(boxes()[0]);
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
  });

  test("a running timer in the same message survives a sibling checkbox toggle", () => {
    const { container, getByRole } = render(<Host initial={RECIPE} />);
    const timer = container.querySelector(".timer-chip") as HTMLElement;
    expect(timer).not.toBeNull();
    // Start the countdown — the chip goes "running" and reveals its reset control.
    fireEvent.click(within(timer).getByRole("button", { name: "Start Boil" }));
    expect(container.querySelector(".timer-chip.running")).not.toBeNull();
    expect(within(timer).getByRole("button", { name: "Reset Boil" })).toBeInTheDocument();

    // Toggle a checkbox in the same message. If the block had remounted, the timer would snap back
    // to a pristine, not-running state (no reset button); it must not.
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(container.querySelector(".timer-chip.running")).not.toBeNull();
    expect(getByRole("button", { name: "Reset Boil" })).toBeInTheDocument();
  });
});

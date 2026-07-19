import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import type { MemoryListing, RememberedFact } from "../lib/api";

// MemoryPanel is the archivist transparency + control surface (#27): the memory on/off switch (rides
// preferences), the list of remembered facts, and forget-one / forget-all. We mock the api module
// (no network) — including saveSettings, which the real preferences store calls when the toggle flips.
const listMemory = vi.fn();
const forgetFact = vi.fn();
const forgetAllMemory = vi.fn();
const saveSettings = vi.fn();
vi.mock("../lib/api", () => ({
  listMemory: (...a: unknown[]) => listMemory(...a),
  forgetFact: (...a: unknown[]) => forgetFact(...a),
  forgetAllMemory: (...a: unknown[]) => forgetAllMemory(...a),
  saveSettings: (...a: unknown[]) => saveSettings(...a),
}));

import { DEFAULT_PREFERENCES, getPreferences, syncPreferences } from "../lib/preferences";
import { MemoryPanel } from "./MemoryPanel";

function fact(over: Partial<RememberedFact> = {}): RememberedFact {
  return { id: "m1", content: "prefers concise answers", createdAt: "2026-01-02T00:00:00.000Z", ...over };
}
function listing(over: Partial<MemoryListing> = {}): MemoryListing {
  return { enabled: true, facts: [], ...over };
}

beforeEach(() => {
  installLocalStorage();
  syncPreferences(DEFAULT_PREFERENCES); // reset the store to memory-on defaults
  listMemory.mockReset().mockResolvedValue(listing());
  forgetFact.mockReset().mockResolvedValue(undefined);
  forgetAllMemory.mockReset().mockResolvedValue(0);
  saveSettings.mockReset().mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("MemoryPanel — listing", () => {
  test("empty state when nothing is remembered", async () => {
    render(<MemoryPanel onClose={() => {}} />);
    expect(await screen.findByText(/Nothing remembered yet/)).toBeInTheDocument();
    expect(screen.getByText("0 thing(s) remembered")).toBeInTheDocument();
  });

  test("lists remembered facts with their learned date and a Forget button", async () => {
    listMemory.mockResolvedValue(listing({ facts: [fact({ content: "lives in Berlin" })] }));
    render(<MemoryPanel onClose={() => {}} />);
    expect(await screen.findByText("lives in Berlin")).toBeInTheDocument();
    expect(screen.getByText("1 thing(s) remembered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forget" })).toBeInTheDocument();
  });

  test("shows a load error when the fetch fails", async () => {
    listMemory.mockRejectedValue(new Error("boom"));
    render(<MemoryPanel onClose={() => {}} />);
    expect(await screen.findByText("Could not load your memory.")).toBeInTheDocument();
  });
});

describe("MemoryPanel — toggle", () => {
  test("reflects the enabled preference and persists a flip", async () => {
    render(<MemoryPanel onClose={() => {}} />);
    const sw = await screen.findByRole("switch", { name: "Remember me across conversations" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.click(sw);
    expect(getPreferences().memory.enabled).toBe(false);
    expect(saveSettings).toHaveBeenCalled();
    // The off-state note appears.
    expect(await screen.findByText(/Memory is off/)).toBeInTheDocument();
  });

  test("starts from the synced off-state and shows the note", async () => {
    syncPreferences({ ...DEFAULT_PREFERENCES, memory: { enabled: false } });
    render(<MemoryPanel onClose={() => {}} />);
    expect(await screen.findByText(/Memory is off/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Remember me across conversations" })).toHaveAttribute("aria-checked", "false");
  });
});

describe("MemoryPanel — forget", () => {
  test("Forget on a row removes that fact (after confirm) and refreshes", async () => {
    listMemory
      .mockResolvedValueOnce(listing({ facts: [fact({ id: "m1", content: "fact one" })] }))
      .mockResolvedValueOnce(listing());
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findByText("fact one");
    await userEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(forgetFact).toHaveBeenCalledWith("m1");
    await waitFor(() => expect(screen.getByText(/Nothing remembered yet/)).toBeInTheDocument());
  });

  test("Forget everything clears all facts", async () => {
    listMemory
      .mockResolvedValueOnce(listing({ facts: [fact({ id: "m1", content: "a" }), fact({ id: "m2", content: "b" })] }))
      .mockResolvedValueOnce(listing());
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findByText("a");
    await userEvent.click(screen.getByRole("button", { name: "Forget everything" }));
    expect(forgetAllMemory).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText(/Nothing remembered yet/)).toBeInTheDocument());
  });

  test("declining the confirm forgets nothing", async () => {
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    listMemory.mockResolvedValue(listing({ facts: [fact({ content: "keep me" })] }));
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findByText("keep me");
    await userEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(forgetFact).not.toHaveBeenCalled();
  });

  test("Forget everything is disabled with nothing to forget", async () => {
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findByText(/Nothing remembered yet/);
    expect(screen.getByRole("button", { name: "Forget everything" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Forget everything" }));
    expect(forgetAllMemory).not.toHaveBeenCalled();
  });

  test("surfaces an error when a forget fails", async () => {
    listMemory.mockResolvedValue(listing({ facts: [fact({ content: "boom" })] }));
    forgetFact.mockRejectedValue(new Error("nope"));
    render(<MemoryPanel onClose={() => {}} />);
    await screen.findByText("boom");
    await userEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(await screen.findByText("Couldn't update your memory. Please try again.")).toBeInTheDocument();
  });
});

describe("MemoryPanel — close", () => {
  test("the close button dismisses", async () => {
    const onClose = vi.fn();
    render(<MemoryPanel onClose={onClose} />);
    await screen.findByText(/Nothing remembered yet/);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ShareInfo } from "../lib/api";

// ShareControl is the owner's opt-in toggle for the shareable-live-collab link. We mock the
// api (no network) and cover: lazy status load on open, the create flow, the shared state
// (link + copy + unshare), copy to clipboard, and the error branch.
const getShare = vi.fn();
const createShare = vi.fn();
const deleteShare = vi.fn();
vi.mock("../lib/api", () => ({
  getShare: (...a: unknown[]) => getShare(...a),
  createShare: (...a: unknown[]) => createShare(...a),
  deleteShare: (...a: unknown[]) => deleteShare(...a),
}));

import { ShareControl } from "./ShareControl";

const SHARED: ShareInfo = { shared: true, slug: "abc", url: "https://a7t.chat/s/abc" };
const NOT_SHARED: ShareInfo = { shared: false, slug: null, url: null };

beforeEach(() => {
  getShare.mockReset().mockResolvedValue(NOT_SHARED);
  createShare.mockReset().mockResolvedValue(SHARED);
  deleteShare.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

function openPopover() {
  return userEvent.click(screen.getByRole("button", { name: "Share" }));
}

describe("ShareControl", () => {
  test("renders just the share button until opened", () => {
    render(<ShareControl conversationId="c1" />);
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.queryByText("Share this chat")).not.toBeInTheDocument();
  });

  test("loads the share status on mount and marks the button active when the chat is shared", async () => {
    getShare.mockResolvedValue(SHARED);
    render(<ShareControl conversationId="c1" />);
    // Fetched once at rest (no popover open), and the button reflects the published state.
    await waitFor(() => expect(getShare).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toHaveClass("active"));
    // Still closed — the at-rest load must not pop the dialog open.
    expect(screen.queryByText("Share this chat")).not.toBeInTheDocument();
  });

  test("an unshared chat leaves the button un-accented at rest", async () => {
    render(<ShareControl conversationId="c1" />); // getShare → NOT_SHARED (default)
    await waitFor(() => expect(getShare).toHaveBeenCalledWith("c1"));
    expect(screen.getByRole("button", { name: "Share" })).not.toHaveClass("active");
  });

  test("opening loads the status and offers a create link when unshared", async () => {
    render(<ShareControl conversationId="c1" />);
    await openPopover();
    expect(await screen.findByText("Share this chat")).toBeInTheDocument();
    expect(getShare).toHaveBeenCalledWith("c1");
    expect(await screen.findByRole("button", { name: "Create link" })).toBeInTheDocument();
  });

  test("create produces the link, copy, and unshare affordances", async () => {
    render(<ShareControl conversationId="c1" />);
    await openPopover();
    await userEvent.click(await screen.findByRole("button", { name: "Create link" }));
    expect(createShare).toHaveBeenCalledWith("c1");
    const input = (await screen.findByLabelText("Copy link")) as HTMLInputElement;
    expect(input.value).toBe("https://a7t.chat/s/abc");
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeInTheDocument();
  });

  test("opening an already-shared chat shows the link straight away", async () => {
    getShare.mockResolvedValue(SHARED);
    render(<ShareControl conversationId="c1" />);
    await openPopover();
    const input = (await screen.findByLabelText("Copy link")) as HTMLInputElement;
    expect(input.value).toBe("https://a7t.chat/s/abc");
  });

  test("copy writes the link to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    getShare.mockResolvedValue(SHARED);
    render(<ShareControl conversationId="c1" />);
    await openPopover();
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://a7t.chat/s/abc");
    expect(await screen.findByRole("button", { name: "Copied ✓" })).toBeInTheDocument();
  });

  test("unshare flips back to the create state", async () => {
    getShare.mockResolvedValue(SHARED);
    render(<ShareControl conversationId="c1" />);
    await openPopover();
    await userEvent.click(await screen.findByRole("button", { name: "Stop sharing" }));
    expect(deleteShare).toHaveBeenCalledWith("c1");
    expect(await screen.findByRole("button", { name: "Create link" })).toBeInTheDocument();
  });

  test("surfaces an error when the status load fails", async () => {
    getShare.mockRejectedValue(new Error("boom"));
    render(<ShareControl conversationId="c1" />);
    await openPopover();
    expect(await screen.findByText("Couldn't update sharing. Try again.")).toBeInTheDocument();
  });

  test("surfaces an error when create fails", async () => {
    createShare.mockRejectedValue(new Error("nope"));
    render(<ShareControl conversationId="c1" />);
    await openPopover();
    await userEvent.click(await screen.findByRole("button", { name: "Create link" }));
    expect(await screen.findByText("Couldn't update sharing. Try again.")).toBeInTheDocument();
  });

  test("toggling the button again closes the popover", async () => {
    render(<ShareControl conversationId="c1" />);
    await openPopover();
    expect(await screen.findByText("Share this chat")).toBeInTheDocument();
    await openPopover();
    await waitFor(() => expect(screen.queryByText("Share this chat")).not.toBeInTheDocument());
  });
});

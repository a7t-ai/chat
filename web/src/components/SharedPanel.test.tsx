import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SharedConversationMeta } from "../lib/api";

// SharedPanel is the invitee's "shared with me" list (the Share primitive's other side). We mock
// the api and cover: the load, the empty state, the error branch, and opening a row (which hands
// the id to ChatView and closes the panel).
const fetchSharedConversations = vi.fn();
vi.mock("../lib/api", () => ({
  fetchSharedConversations: (...a: unknown[]) => fetchSharedConversations(...a),
}));

import { SharedPanel } from "./SharedPanel";

const SHARED: SharedConversationMeta = {
  id: "c-shared",
  title: "Owner's chat",
  model: null,
  updatedAt: 1,
  role: "view",
  ownerName: "Leo",
};

beforeEach(() => {
  fetchSharedConversations.mockReset().mockResolvedValue([SHARED]);
});
afterEach(() => vi.clearAllMocks());

describe("SharedPanel", () => {
  test("lists the conversations shared with the caller, with owner + role", async () => {
    render(<SharedPanel onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText("Owner's chat")).toBeInTheDocument();
    expect(screen.getByText(/Shared by Leo/)).toBeInTheDocument();
    expect(screen.getByText(/Can view/)).toBeInTheDocument();
  });

  test("shows the empty state when nothing is shared", async () => {
    fetchSharedConversations.mockResolvedValue([]);
    render(<SharedPanel onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText("Nothing's been shared with you yet.")).toBeInTheDocument();
  });

  test("a row without a title falls back to the shared-chat placeholder", async () => {
    fetchSharedConversations.mockResolvedValue([{ ...SHARED, title: null }]);
    render(<SharedPanel onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText("Shared chat")).toBeInTheDocument();
  });

  test("opening a row hands the id to onOpen and closes", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<SharedPanel onClose={onClose} onOpen={onOpen} />);
    await userEvent.click(await screen.findByText("Owner's chat"));
    expect(onOpen).toHaveBeenCalledWith("c-shared");
    expect(onClose).toHaveBeenCalled();
  });

  test("the close button calls onClose", async () => {
    const onClose = vi.fn();
    render(<SharedPanel onClose={onClose} onOpen={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  test("surfaces an error when the load fails", async () => {
    fetchSharedConversations.mockRejectedValue(new Error("boom"));
    render(<SharedPanel onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText("Couldn't load shared conversations.")).toBeInTheDocument();
  });

  test("clicking the overlay backdrop closes the panel", async () => {
    const onClose = vi.fn();
    render(<SharedPanel onClose={onClose} onOpen={() => {}} />);
    await screen.findByText("Owner's chat");
    await userEvent.click(document.querySelector(".overlay")!);
    expect(onClose).toHaveBeenCalled();
  });
});

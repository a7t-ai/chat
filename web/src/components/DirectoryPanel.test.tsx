import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import type { DirectoryUser } from "../lib/api";

// DirectoryPanel is the user directory "People" surface (#190): a debounced search over the
// instance's handle-set accounts, rendering handle + display name per row. We mock the api module
// (no network) so we drive only the panel's behavior.
const fetchDirectory = vi.fn();
vi.mock("../lib/api", () => ({
  fetchDirectory: (...a: unknown[]) => fetchDirectory(...a),
}));

import { DirectoryPanel } from "./DirectoryPanel";

function user(over: Partial<DirectoryUser> = {}): DirectoryUser {
  return { id: "u1", handle: "alice", name: "Alice A", ...over };
}

beforeEach(() => {
  installLocalStorage();
  fetchDirectory.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("DirectoryPanel", () => {
  test("loads the full listing on mount and renders name + @handle", async () => {
    fetchDirectory.mockResolvedValue([user({ handle: "alice", name: "Alice A" }), user({ id: "u2", handle: "bob", name: "Bob B" })]);
    render(<DirectoryPanel onClose={() => {}} />);
    expect(await screen.findByText("Alice A")).toBeInTheDocument();
    expect(screen.getByText("@alice")).toBeInTheDocument();
    expect(screen.getByText("Bob B")).toBeInTheDocument();
    // The initial load is a blank search (whole listing).
    await waitFor(() => expect(fetchDirectory).toHaveBeenCalledWith(""));
  });

  test("does not render a redundant @handle line when the name IS the handle", async () => {
    fetchDirectory.mockResolvedValue([user({ handle: "leo_42", name: "leo_42" })]);
    render(<DirectoryPanel onClose={() => {}} />);
    expect(await screen.findByText("leo_42")).toBeInTheDocument();
    expect(screen.queryByText("@leo_42")).not.toBeInTheDocument();
  });

  test("empty state (no query) when the instance has no one to show", async () => {
    fetchDirectory.mockResolvedValue([]);
    render(<DirectoryPanel onClose={() => {}} />);
    expect(await screen.findByText(/People show up once they set a handle/)).toBeInTheDocument();
  });

  test("typing a search debounces into a filtered fetch and shows the no-match empty state", async () => {
    fetchDirectory.mockResolvedValue([]);
    render(<DirectoryPanel onClose={() => {}} />);
    // Let the initial mount load settle.
    await screen.findByText(/People show up once they set a handle/);

    await userEvent.type(screen.getByPlaceholderText("Search by handle or name"), "zzz");
    await waitFor(() => expect(fetchDirectory).toHaveBeenCalledWith("zzz"));
    // With a non-empty query and no results, the no-match copy replaces the generic empty state.
    expect(await screen.findByText("No one matches your search.")).toBeInTheDocument();
  });

  test("shows an error message when the fetch fails", async () => {
    fetchDirectory.mockRejectedValue(new Error("boom"));
    render(<DirectoryPanel onClose={() => {}} />);
    expect(await screen.findByText(/Couldn't load the directory/)).toBeInTheDocument();
  });
});

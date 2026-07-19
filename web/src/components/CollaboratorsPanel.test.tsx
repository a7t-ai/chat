import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Collaborator, DirectoryUser } from "../lib/api";

// CollaboratorsPanel is the owner's identity-bound Share control: invite a specific account by its
// HANDLE (#189, #177) + role, then manage who has access. We mock the api (no network) and cover:
// lazy list + directory load on open, the invite-by-handle flow, the directory autocomplete
// suggestions, the typed failure messages (no_account / self), role change, removal, that the row
// shows handle/display name (never email), and the error branch.
const listCollaborators = vi.fn();
const inviteCollaborator = vi.fn();
const updateCollaboratorRole = vi.fn();
const removeCollaborator = vi.fn();
const fetchDirectory = vi.fn();
vi.mock("../lib/api", () => ({
  listCollaborators: (...a: unknown[]) => listCollaborators(...a),
  inviteCollaborator: (...a: unknown[]) => inviteCollaborator(...a),
  updateCollaboratorRole: (...a: unknown[]) => updateCollaboratorRole(...a),
  removeCollaborator: (...a: unknown[]) => removeCollaborator(...a),
  fetchDirectory: (...a: unknown[]) => fetchDirectory(...a),
}));

import { CollaboratorsPanel } from "./CollaboratorsPanel";

// A collaborator row carries a HANDLE + display name — never an email (passkey accounts have none).
const ALICE: Collaborator = { userId: "u-alice", handle: "alice", displayName: "Alice A", role: "view", createdAt: 1 };
const DIR: DirectoryUser[] = [
  { id: "u-alice", handle: "alice", name: "Alice A" },
  { id: "u-bob", handle: "bob", name: "Bob B" },
];

beforeEach(() => {
  listCollaborators.mockReset().mockResolvedValue([]);
  inviteCollaborator.mockReset().mockResolvedValue({ ok: true, collaborator: { userId: "u-alice", role: "view" } });
  updateCollaboratorRole.mockReset().mockResolvedValue(undefined);
  removeCollaborator.mockReset().mockResolvedValue(undefined);
  fetchDirectory.mockReset().mockResolvedValue(DIR);
});
afterEach(() => vi.clearAllMocks());

function open() {
  return userEvent.click(screen.getByRole("button", { name: "People" }));
}

describe("CollaboratorsPanel", () => {
  test("renders just the button until opened", () => {
    render(<CollaboratorsPanel conversationId="c1" />);
    expect(screen.getByRole("button", { name: "People" })).toBeInTheDocument();
    expect(screen.queryByText("Share with people")).not.toBeInTheDocument();
  });

  test("opening loads the collaborator list + the directory (empty → 'no one yet')", async () => {
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    expect(await screen.findByText("Share with people")).toBeInTheDocument();
    expect(listCollaborators).toHaveBeenCalledWith("c1");
    // The directory is loaded to back the handle autocomplete.
    await waitFor(() => expect(fetchDirectory).toHaveBeenCalled());
    expect(await screen.findByText("No one else has access yet.")).toBeInTheDocument();
  });

  test("the handle field offers directory handles as autocomplete options", async () => {
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    await waitFor(() => expect(fetchDirectory).toHaveBeenCalled());
    const field = screen.getByPlaceholderText("their handle");
    expect(field).toHaveAttribute("list", "collab-directory");
    // The datalist carries an <option> per directory row (value = handle).
    await waitFor(() => {
      const opts = Array.from(document.querySelectorAll("#collab-directory option")).map((o) => o.getAttribute("value"));
      expect(opts).toEqual(["alice", "bob"]);
    });
  });

  test("inviting by handle + role calls the api (handle only, no email) and refreshes the list", async () => {
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    // A pasted "@Alice" is normalized to the stored lowercase handle before the call.
    await userEvent.type(screen.getByPlaceholderText("their handle"), "@Alice");
    // After a successful invite the refresh returns Alice.
    listCollaborators.mockResolvedValue([ALICE]);
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(inviteCollaborator).toHaveBeenCalledWith("c1", "alice", "view");
    // Shown by handle (primary) + display name (secondary) — never an email.
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("Alice A")).toBeInTheDocument();
  });

  test("shows the 'no account' message when the handle has no account", async () => {
    inviteCollaborator.mockResolvedValue({ ok: false, reason: "no_account" });
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    await userEvent.type(screen.getByPlaceholderText("their handle"), "ghost");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByText("No account with that handle yet.")).toBeInTheDocument();
  });

  test("shows the 'you already own this' message when inviting yourself", async () => {
    inviteCollaborator.mockResolvedValue({ ok: false, reason: "self" });
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    await userEvent.type(screen.getByPlaceholderText("their handle"), "me");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByText("You already own this conversation.")).toBeInTheDocument();
  });

  test("a blank handle does not call the api", async () => {
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(inviteCollaborator).not.toHaveBeenCalled();
  });

  test("changing a collaborator's role calls the api", async () => {
    listCollaborators.mockResolvedValue([ALICE]);
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    const row = (await screen.findByText("alice")).closest("li")!;
    await userEvent.selectOptions(within(row).getByRole("combobox"), "prompt");
    expect(updateCollaboratorRole).toHaveBeenCalledWith("c1", "u-alice", "prompt");
  });

  test("removing a collaborator calls the api and drops them from the list", async () => {
    listCollaborators.mockResolvedValueOnce([ALICE]).mockResolvedValue([]);
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(removeCollaborator).toHaveBeenCalledWith("c1", "u-alice");
    await waitFor(() => expect(screen.getByText("No one else has access yet.")).toBeInTheDocument());
  });

  test("surfaces an error when the list load fails", async () => {
    listCollaborators.mockRejectedValue(new Error("boom"));
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    expect(await screen.findByText("Couldn't update. Try again.")).toBeInTheDocument();
  });

  test("a failed directory load is non-fatal — the panel + handle field still work", async () => {
    fetchDirectory.mockRejectedValue(new Error("boom"));
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    // The invite field is present and usable even though the directory couldn't load.
    expect(await screen.findByPlaceholderText("their handle")).toBeInTheDocument();
    expect(screen.getByText("No one else has access yet.")).toBeInTheDocument();
  });

  test("toggling the button again closes the popover", async () => {
    render(<CollaboratorsPanel conversationId="c1" />);
    await open();
    expect(await screen.findByText("Share with people")).toBeInTheDocument();
    await open();
    await waitFor(() => expect(screen.queryByText("Share with people")).not.toBeInTheDocument());
  });
});

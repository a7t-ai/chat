import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Passkey } from "../lib/webauthn";

// PasskeysPanel manages the account's WebAuthn credentials (#20): list, add, remove. We mock the
// webauthn lib (no navigator/network) and cover the loaded/empty/unavailable/error states plus the
// add + delete flows.
const listPasskeys = vi.fn();
const registerPasskey = vi.fn();
const deletePasskey = vi.fn();
const passkeySupported = vi.fn();
vi.mock("../lib/webauthn", () => ({
  listPasskeys: (...a: unknown[]) => listPasskeys(...a),
  registerPasskey: (...a: unknown[]) => registerPasskey(...a),
  deletePasskey: (...a: unknown[]) => deletePasskey(...a),
  passkeySupported: () => passkeySupported(),
}));

import { PasskeysPanel } from "./PasskeysPanel";

function pk(over: Partial<Passkey> = {}): Passkey {
  return { id: "p1", label: "Laptop", createdAt: Date.parse("2026-01-02"), lastUsedAt: null, ...over };
}

beforeEach(() => {
  listPasskeys.mockReset().mockResolvedValue({ available: true, passkeys: [] });
  registerPasskey.mockReset().mockResolvedValue({ ok: true, passkey: pk() });
  deletePasskey.mockReset().mockResolvedValue(undefined);
  passkeySupported.mockReset().mockReturnValue(true);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("PasskeysPanel — states", () => {
  test("empty state + Add button when none registered", async () => {
    render(<PasskeysPanel onClose={() => {}} embedded />);
    expect(await screen.findByText("You haven't added any passkeys yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a passkey" })).toBeEnabled();
  });

  test("lists registered passkeys with their labels", async () => {
    listPasskeys.mockResolvedValue({ available: true, passkeys: [pk(), pk({ id: "p2", label: null, lastUsedAt: Date.parse("2026-02-02") })] });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    expect(await screen.findByText("Laptop")).toBeInTheDocument();
    // The unnamed one falls back to the generic label.
    expect(screen.getByText("Passkey")).toBeInTheDocument();
  });

  test("shows an unavailable notice when the server is dark", async () => {
    listPasskeys.mockResolvedValue({ available: false, passkeys: [] });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    expect(await screen.findByText("Passkeys aren't enabled on this server.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).not.toBeInTheDocument();
  });

  test("shows a load error when listing fails", async () => {
    listPasskeys.mockRejectedValue(new Error("boom"));
    render(<PasskeysPanel onClose={() => {}} embedded />);
    expect(await screen.findByText("Could not load your passkeys.")).toBeInTheDocument();
  });

  test("disables Add + explains when the browser is unsupported", async () => {
    passkeySupported.mockReturnValue(false);
    render(<PasskeysPanel onClose={() => {}} embedded />);
    expect(await screen.findByText("This browser doesn't support passkeys.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a passkey" })).toBeDisabled();
  });
});

describe("PasskeysPanel — add", () => {
  test("adds a passkey and refreshes", async () => {
    listPasskeys.mockResolvedValueOnce({ available: true, passkeys: [] }).mockResolvedValueOnce({ available: true, passkeys: [pk()] });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    await screen.findByRole("button", { name: "Add a passkey" });
    await userEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("Passkey added.")).toBeInTheDocument();
    expect(registerPasskey).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Laptop")).toBeInTheDocument());
  });

  test("passes the typed name as the label", async () => {
    listPasskeys.mockResolvedValueOnce({ available: true, passkeys: [] }).mockResolvedValueOnce({ available: true, passkeys: [pk({ label: "YubiKey" })] });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    await userEvent.type(await screen.findByLabelText("Passkey name"), "  YubiKey  ");
    await userEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    // The name is trimmed before it reaches the register call.
    expect(registerPasskey).toHaveBeenCalledWith("YubiKey");
    // A successful enrol clears the field for the next one.
    await waitFor(() => expect(screen.getByLabelText("Passkey name")).toHaveValue(""));
  });

  test("registers with no label when the name is left blank", async () => {
    render(<PasskeysPanel onClose={() => {}} embedded />);
    await userEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    expect(registerPasskey).toHaveBeenCalledWith(undefined);
  });

  test("keeps the typed name when registration fails", async () => {
    registerPasskey.mockResolvedValue({ ok: false, reason: "error" });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    await userEvent.type(await screen.findByLabelText("Passkey name"), "Laptop");
    await userEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("Couldn't add that passkey. Please try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Passkey name")).toHaveValue("Laptop");
  });

  test("stays quiet when the user cancels the prompt", async () => {
    registerPasskey.mockResolvedValue({ ok: false, reason: "cancelled" });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    await userEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    expect(screen.queryByText("Passkey added.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("shows an error when registration fails", async () => {
    registerPasskey.mockResolvedValue({ ok: false, reason: "error" });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    await userEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText("Couldn't add that passkey. Please try again.")).toBeInTheDocument();
  });
});

describe("PasskeysPanel — delete", () => {
  test("removes a passkey after confirm", async () => {
    listPasskeys.mockResolvedValueOnce({ available: true, passkeys: [pk()] }).mockResolvedValueOnce({ available: true, passkeys: [] });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    await screen.findByText("Laptop");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deletePasskey).toHaveBeenCalledWith("p1");
    await waitFor(() => expect(screen.queryByText("Laptop")).not.toBeInTheDocument());
  });

  test("does nothing when the confirm is declined", async () => {
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    listPasskeys.mockResolvedValue({ available: true, passkeys: [pk()] });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    await screen.findByText("Laptop");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deletePasskey).not.toHaveBeenCalled();
  });

  test("shows an error when deletion fails", async () => {
    deletePasskey.mockRejectedValue(new Error("no"));
    listPasskeys.mockResolvedValue({ available: true, passkeys: [pk()] });
    render(<PasskeysPanel onClose={() => {}} embedded />);
    await screen.findByText("Laptop");
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Couldn't remove that passkey. Please try again.")).toBeInTheDocument();
  });
});

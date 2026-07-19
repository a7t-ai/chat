import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AccountModal } from "./AccountModal";
import type { Me } from "../lib/api";

// The passkeys section (#20) mounts PasskeysPanel, which talks to the webauthn lib — stub it so the
// modal renders without touching navigator/network.
vi.mock("../lib/webauthn", () => ({
  listPasskeys: vi.fn().mockResolvedValue({ available: true, passkeys: [] }),
  registerPasskey: vi.fn(),
  deletePasskey: vi.fn(),
  passkeySupported: () => true,
}));

function makeMe(role: Me["role"]): Me {
  return {
    role,
    via: "token",
    user: { id: "u1", email: "person@a7t.chat", login: "person" },
    plan: "free",
  } as unknown as Me;
}

const noop = () => {};

describe("AccountModal", () => {
  test("admin rail includes the admin section; the active section heading shows", () => {
    render(
      <AccountModal me={makeMe("admin")} section="profile" onSection={noop} onClose={noop} onOpenConversation={noop} />,
    );
    // Rail nav items are buttons; the admin group is present for an admin (#169: invites + data
    // sections removed; #179: the Accounts manager removed, so the admin group is now just Telemetry).
    expect(screen.getByRole("button", { name: "Telemetry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accounts" })).toBeNull();
    // The content pane heads with the active section's name.
    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
  });

  test("a non-admin gets no admin sections, and an admin section id falls back to Profile", () => {
    render(
      <AccountModal me={makeMe("guest")} section="stats" onSection={noop} onClose={noop} onOpenConversation={noop} />,
    );
    expect(screen.queryByRole("button", { name: "Telemetry" })).toBeNull();
    // An admin-only section requested by a non-admin degrades to Profile rather than a 403 panel.
    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
  });

  test("the Passkeys section appears only when the server has WebAuthn configured (#20)", () => {
    const me = makeMe("account");
    // Dark: no passkeys rail item.
    const { rerender } = render(
      <AccountModal me={me} section="profile" onSection={noop} onClose={noop} onOpenConversation={noop} />,
    );
    expect(screen.queryByRole("button", { name: "Passkeys" })).toBeNull();
    // Lit: the item appears and its panel renders.
    const lit = { ...me, passkeys: { available: true } } as Me;
    rerender(<AccountModal me={lit} section="passkeys" onSection={noop} onClose={noop} onOpenConversation={noop} />);
    expect(screen.getByRole("button", { name: "Passkeys" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Passkeys" })).toBeInTheDocument();
  });
});

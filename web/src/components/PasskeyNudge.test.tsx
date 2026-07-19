import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Me } from "../lib/api";

// PasskeyNudge (#149) invites an account with no passkey to set one up. We mock the webauthn lib
// (no navigator/network) and cover the gate (role / availability / browser support / count / prior
// dismissal) plus the set-up + dismiss flows.
const listPasskeys = vi.fn();
const registerPasskey = vi.fn();
const passkeySupported = vi.fn();
vi.mock("../lib/webauthn", () => ({
  listPasskeys: (...a: unknown[]) => listPasskeys(...a),
  registerPasskey: (...a: unknown[]) => registerPasskey(...a),
  passkeySupported: () => passkeySupported(),
}));

import { PasskeyNudge } from "./PasskeyNudge";

function me(over: Partial<Me> = {}): Me {
  return {
    role: "account",
    via: "email",
    user: { id: "u1", login: "leo", displayName: "Leo" },
    key: null,
    theme: null,
    lang: null,
    accessGranted: true,
    passkeys: { available: true },
    ...over,
  };
}

const CTA = "Set up a passkey";

beforeEach(() => {
  localStorage.clear();
  listPasskeys.mockReset().mockResolvedValue({ available: true, passkeys: [] });
  registerPasskey.mockReset().mockResolvedValue({ ok: true, passkey: { id: "p1", label: null, createdAt: 1, lastUsedAt: null } });
  passkeySupported.mockReset().mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("PasskeyNudge — gate", () => {
  test("shows for an account with zero passkeys on a capable browser", async () => {
    render(<PasskeyNudge me={me()} />);
    expect(await screen.findByRole("button", { name: CTA })).toBeInTheDocument();
    expect(screen.getByText("Sign in faster next time")).toBeInTheDocument();
  });

  test("stays hidden — and makes no network probe — for a non-account caller", async () => {
    const { container } = render(<PasskeyNudge me={me({ role: "guest" })} />);
    expect(container).toBeEmptyDOMElement();
    expect(listPasskeys).not.toHaveBeenCalled();
  });

  test("stays hidden when passkeys are dark on the server", async () => {
    const { container } = render(<PasskeyNudge me={me({ passkeys: { available: false } })} />);
    expect(container).toBeEmptyDOMElement();
    expect(listPasskeys).not.toHaveBeenCalled();
  });

  test("stays hidden when passkeys are absent from /api/me (older response)", () => {
    const bare = me();
    delete bare.passkeys;
    const { container } = render(<PasskeyNudge me={bare} />);
    expect(container).toBeEmptyDOMElement();
    expect(listPasskeys).not.toHaveBeenCalled();
  });

  test("stays hidden when the browser doesn't support WebAuthn", () => {
    passkeySupported.mockReturnValue(false);
    const { container } = render(<PasskeyNudge me={me()} />);
    expect(container).toBeEmptyDOMElement();
    expect(listPasskeys).not.toHaveBeenCalled();
  });

  test("stays hidden when the account already has a passkey", async () => {
    listPasskeys.mockResolvedValue({ available: true, passkeys: [{ id: "p1", label: "Laptop", createdAt: 1, lastUsedAt: null }] });
    const { container } = render(<PasskeyNudge me={me()} />);
    await waitFor(() => expect(listPasskeys).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: CTA })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  test("stays hidden when the list probe reports the server dark despite /api/me", async () => {
    listPasskeys.mockResolvedValue({ available: false, passkeys: [] });
    const { container } = render(<PasskeyNudge me={me()} />);
    await waitFor(() => expect(listPasskeys).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test("stays hidden when the list probe fails (never nag on an error)", async () => {
    listPasskeys.mockRejectedValue(new Error("boom"));
    const { container } = render(<PasskeyNudge me={me()} />);
    await waitFor(() => expect(listPasskeys).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test("stays hidden — no probe — when a prior dismissal is remembered", () => {
    localStorage.setItem("a7t_passkey_nudge_dismissed", "1");
    const { container } = render(<PasskeyNudge me={me()} />);
    expect(container).toBeEmptyDOMElement();
    expect(listPasskeys).not.toHaveBeenCalled();
  });
});

describe("PasskeyNudge — actions", () => {
  test("dismiss hides the nudge and remembers it", async () => {
    render(<PasskeyNudge me={me()} />);
    await screen.findByRole("button", { name: CTA });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: CTA })).not.toBeInTheDocument();
    expect(localStorage.getItem("a7t_passkey_nudge_dismissed")).toBe("1");
  });

  test("setting up a passkey runs the register ceremony and hides the nudge", async () => {
    render(<PasskeyNudge me={me()} />);
    await userEvent.click(await screen.findByRole("button", { name: CTA }));
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: CTA })).not.toBeInTheDocument();
    // Remembered so a stale /api/me can't resurface it before the count refreshes.
    expect(localStorage.getItem("a7t_passkey_nudge_dismissed")).toBe("1");
  });

  test("cancelling the OS prompt keeps the nudge and shows no error", async () => {
    registerPasskey.mockResolvedValue({ ok: false, reason: "cancelled" });
    render(<PasskeyNudge me={me()} />);
    await userEvent.click(await screen.findByRole("button", { name: CTA }));
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: CTA })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem("a7t_passkey_nudge_dismissed")).toBeNull();
  });

  test("a failed registration surfaces an error and keeps the nudge", async () => {
    registerPasskey.mockResolvedValue({ ok: false, reason: "error" });
    render(<PasskeyNudge me={me()} />);
    await userEvent.click(await screen.findByRole("button", { name: CTA }));
    expect(await screen.findByText("Couldn't add that passkey. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CTA })).toBeInTheDocument();
  });

  test("an unsupported result explains why", async () => {
    registerPasskey.mockResolvedValue({ ok: false, reason: "unsupported" });
    render(<PasskeyNudge me={me()} />);
    await userEvent.click(await screen.findByRole("button", { name: CTA }));
    expect(await screen.findByText("This browser doesn't support passkeys.")).toBeInTheDocument();
  });
});

describe("PasskeyNudge — storage failures degrade gracefully", () => {
  test("a throwing localStorage read is treated as not-dismissed (still shows)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<PasskeyNudge me={me()} />);
    expect(await screen.findByRole("button", { name: CTA })).toBeInTheDocument();
  });

  test("a throwing localStorage write still hides the nudge for the session", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    render(<PasskeyNudge me={me()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: CTA })).not.toBeInTheDocument();
  });
});

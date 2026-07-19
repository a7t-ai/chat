import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// LoginView is now passkey-only (#169): email OTP + invites were removed. A visitor either signs UP
// (registers a passkey → the server creates their account + session) or signs IN with an existing
// passkey. We mock the webauthn module so the test drives only the UI, not the platform/network.
// DotGrid touches canvas; stand it in.

const passkeySupported = vi.fn(() => true);
const fetchPasskeyAvailable = vi.fn(async () => true);
const loginWithPasskey = vi.fn();
const signUpWithPasskey = vi.fn();
vi.mock("../lib/webauthn", () => ({
  passkeySupported: () => passkeySupported(),
  fetchPasskeyAvailable: () => fetchPasskeyAvailable(),
  loginWithPasskey: () => loginWithPasskey(),
  signUpWithPasskey: () => signUpWithPasskey(),
}));
vi.mock("./DotGrid", () => ({ DotGrid: () => <div data-testid="dotgrid" /> }));

import { LoginView } from "./LoginView";

const onAuthed = vi.fn();

beforeEach(() => {
  passkeySupported.mockReset().mockReturnValue(true);
  fetchPasskeyAvailable.mockReset().mockResolvedValue(true);
  loginWithPasskey.mockReset();
  signUpWithPasskey.mockReset();
  onAuthed.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SIGN_UP = "Sign up with a passkey";
const SIGN_IN = "Sign in with a passkey";

function renderLogin() {
  return render(<LoginView onAuthed={onAuthed} />);
}

describe("LoginView — availability", () => {
  test("shows both passkey actions when the browser supports it AND the server has it configured", async () => {
    renderLogin();
    expect(await screen.findByRole("button", { name: SIGN_UP })).toBeEnabled();
    expect(screen.getByRole("button", { name: SIGN_IN })).toBeEnabled();
  });

  test("an unsupported browser shows the private-instance wall and no buttons (never probes the server)", async () => {
    passkeySupported.mockReturnValue(false);
    renderLogin();
    await screen.findByRole("navigation", { name: "Footer" });
    expect(screen.queryByRole("button", { name: SIGN_UP })).toBeNull();
    expect(screen.queryByRole("button", { name: SIGN_IN })).toBeNull();
    expect(screen.queryByText("a7t.chat is a private instance.")).toBeNull();
    expect(fetchPasskeyAvailable).not.toHaveBeenCalled();
  });

  // The public-edge case: the availability probe 401s over the edge, so fetchPasskeyAvailable resolves
  // false and the visitor sees a plain wall with NOTHING clickable to authenticate and no dead contact.
  test("available=false (the public-edge 401 case) renders the wall with NO auth CTAs and no dead email", async () => {
    fetchPasskeyAvailable.mockResolvedValue(false);
    renderLogin();
    await waitFor(() => expect(fetchPasskeyAvailable).toHaveBeenCalled());
    await screen.findByRole("navigation", { name: "Footer" });
    // The wall shows just the lockup + footer: no wall text, no auth affordance.
    expect(screen.queryByText("Private instance")).toBeNull();
    expect(screen.queryByText("a7t.chat is a private instance.")).toBeNull();
    // No sign-up / sign-in / token affordance: no button at all inside the wall card.
    expect(screen.queryByRole("button", { name: SIGN_UP })).toBeNull();
    expect(screen.queryByRole("button", { name: SIGN_IN })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    // The dead contact must not resurface anywhere on the wall.
    expect(screen.queryByText(/leo@a7t\.ai/)).toBeNull();
  });

  test("available=true renders the passkey sign-up + sign-in UI (the tailnet / private path keeps login)", async () => {
    fetchPasskeyAvailable.mockResolvedValue(true);
    renderLogin();
    expect(await screen.findByRole("button", { name: SIGN_UP })).toBeEnabled();
    expect(screen.getByRole("button", { name: SIGN_IN })).toBeEnabled();
    // The wall copy is NOT shown when passkeys are reachable.
    expect(screen.queryByText("a7t.chat is a private instance.")).toBeNull();
  });
});

describe("LoginView — sign up", () => {
  test("a successful sign-up calls onAuthed", async () => {
    signUpWithPasskey.mockResolvedValue({ ok: true, status: "authed" });
    const u = userEvent.setup();
    renderLogin();
    await u.click(await screen.findByRole("button", { name: SIGN_UP }));
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  });

  test("a cancelled sign-up stays silent; an error shows an inline message", async () => {
    signUpWithPasskey.mockResolvedValueOnce({ ok: false, reason: "cancelled" }).mockResolvedValueOnce({ ok: false, reason: "error" });
    const u = userEvent.setup();
    renderLogin();
    const btn = await screen.findByRole("button", { name: SIGN_UP });
    await u.click(btn); // cancelled → no error
    expect(screen.queryByRole("alert")).toBeNull();
    await u.click(btn); // error → inline
    expect(await screen.findByText(/didn't work/)).toBeInTheDocument();
    expect(onAuthed).not.toHaveBeenCalled();
  });
});

describe("LoginView — sign in", () => {
  test("an authed sign-in calls onAuthed", async () => {
    loginWithPasskey.mockResolvedValue({ ok: true, status: "authed" });
    const u = userEvent.setup();
    renderLogin();
    await u.click(await screen.findByRole("button", { name: SIGN_IN }));
    await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  });

  test("an 'inactive' sign-in shows the inactive message and does NOT enter the app", async () => {
    loginWithPasskey.mockResolvedValue({ ok: true, status: "inactive" });
    const u = userEvent.setup();
    renderLogin();
    await u.click(await screen.findByRole("button", { name: SIGN_IN }));
    expect(await screen.findByText(/isn't active/)).toBeInTheDocument();
    expect(onAuthed).not.toHaveBeenCalled();
  });

  test("a cancelled sign-in stays silent; an error shows an inline message", async () => {
    loginWithPasskey.mockResolvedValueOnce({ ok: false, reason: "cancelled" }).mockResolvedValueOnce({ ok: false, reason: "error" });
    const u = userEvent.setup();
    renderLogin();
    const btn = await screen.findByRole("button", { name: SIGN_IN });
    await u.click(btn); // cancelled → quiet
    expect(screen.queryByRole("alert")).toBeNull();
    await u.click(btn); // error → inline
    expect(await screen.findByText(/didn't work/)).toBeInTheDocument();
  });
});

describe("LoginView — footer", () => {
  test("renders the global footer on the wall (a7t.ai link, Help removed)", () => {
    renderLogin();
    expect(screen.getByRole("navigation", { name: "Footer" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Help" })).toBeNull();
    expect(screen.getByRole("link", { name: "Part of a7t.ai" })).toHaveAttribute("href", "https://a7t.ai");
  });
});

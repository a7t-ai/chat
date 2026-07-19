import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Me } from "../lib/api";

// ProfilePanel shows the caller's identity + plan and hosts the account-handle editor (#189). We
// mock the api's `setHandle` (no network) and cover: display precedence (handle wins, acct_ login
// hidden), local charset/length validation, the save→onUserChange→saved-note flow, and the server
// `taken` collision.
const setHandleMock = vi.fn();
vi.mock("../lib/api", () => ({
  setHandle: (...a: unknown[]) => setHandleMock(...a),
}));

import { ProfilePanel } from "./ProfilePanel";

function makeMe(over: Partial<Me> = {}): Me {
  return {
    role: "account",
    via: "session",
    user: { id: "u1", login: "acct_slug-1", displayName: null, email: "leo@a7t.test", handle: null },
    key: null,
    theme: null,
    lang: null,
    plan: "free",
    ...over,
  };
}

beforeEach(() => {
  setHandleMock.mockReset().mockResolvedValue({ ok: true, handle: "leo_42" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProfilePanel — identity", () => {
  test("shows the display name when present, with the email as a secondary line", () => {
    render(<ProfilePanel me={makeMe({ user: { id: "u", login: "acct_x", displayName: "Leo", email: "leo@a7t.test", handle: null } })} onClose={() => {}} />);
    expect(screen.getByText("Leo", { selector: ".profile-name" })).toBeInTheDocument();
    expect(screen.getByText("leo@a7t.test")).toBeInTheDocument();
    expect(screen.getByText("L", { selector: ".profile-avatar" })).toBeInTheDocument();
  });

  test("the handle wins over the display name + email (#189)", () => {
    render(<ProfilePanel me={makeMe({ user: { id: "u", login: "acct_x", displayName: "Leo C", email: "leo@a7t.test", handle: "leo" } })} onClose={() => {}} />);
    expect(screen.getByText("leo", { selector: ".profile-name" })).toBeInTheDocument();
  });

  test("never shows a synthetic acct_ login — falls back to the friendly name (#189)", () => {
    render(<ProfilePanel me={makeMe({ user: { id: "u", login: "acct_deadbeef", displayName: null, email: null, handle: null } })} onClose={() => {}} />);
    expect(screen.queryByText(/acct_deadbeef/)).not.toBeInTheDocument();
    expect(screen.getByText("Account", { selector: ".profile-name" })).toBeInTheDocument();
  });
});

describe("ProfilePanel — handle editor (#189)", () => {
  test("seeds the input from the stored handle", () => {
    render(<ProfilePanel me={makeMe({ user: { id: "u", login: "acct_x", displayName: null, email: null, handle: "leo" } })} onClose={() => {}} />);
    expect(screen.getByLabelText("Handle")).toHaveValue("leo");
  });

  test("local length validation blocks save with an inline error", async () => {
    render(<ProfilePanel me={makeMe()} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Handle"), "ab");
    expect(screen.getByText("Must be 3–30 characters.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save handle" })).toBeDisabled();
    expect(setHandleMock).not.toHaveBeenCalled();
  });

  test("local charset validation blocks save with an inline error", async () => {
    render(<ProfilePanel me={makeMe()} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Handle"), "no spaces");
    expect(screen.getByText("Use only lowercase letters, numbers, and underscores.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save handle" })).toBeDisabled();
  });

  test("saves a valid handle (lowercased), patches the user, and shows the saved note", async () => {
    const onUserChange = vi.fn();
    render(<ProfilePanel me={makeMe()} onClose={() => {}} onUserChange={onUserChange} />);
    await userEvent.type(screen.getByLabelText("Handle"), "Leo_42");
    await userEvent.click(screen.getByRole("button", { name: "Save handle" }));
    expect(setHandleMock).toHaveBeenCalledWith("leo_42"); // normalized before the call
    expect(await screen.findByText("Handle saved.")).toBeInTheDocument();
    expect(onUserChange).toHaveBeenCalledWith({ handle: "leo_42" });
  });

  test("a server collision surfaces the `taken` message (not knowable locally)", async () => {
    setHandleMock.mockResolvedValue({ ok: false, error: "taken" });
    const onUserChange = vi.fn();
    render(<ProfilePanel me={makeMe()} onClose={() => {}} onUserChange={onUserChange} />);
    await userEvent.type(screen.getByLabelText("Handle"), "taken_one");
    await userEvent.click(screen.getByRole("button", { name: "Save handle" }));
    expect(await screen.findByText("That handle is already taken.")).toBeInTheDocument();
    expect(onUserChange).not.toHaveBeenCalled();
  });

  test("Save is disabled when the handle is unchanged from what's stored", () => {
    render(<ProfilePanel me={makeMe({ user: { id: "u", login: "acct_x", displayName: null, email: null, handle: "leo" } })} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Save handle" })).toBeDisabled();
  });
});

describe("ProfilePanel — plan", () => {
  test("free plan badge + hint", () => {
    render(<ProfilePanel me={makeMe({ plan: "free" })} onClose={() => {}} />);
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("The local console, with a token allowance.")).toBeInTheDocument();
  });

  test("owner plan badge + hint", () => {
    render(<ProfilePanel me={makeMe({ plan: "owner" })} onClose={() => {}} />);
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Full access to every model, no usage cap.")).toBeInTheDocument();
  });

  test("defaults to the free plan when the server sent none (shape stability)", () => {
    render(<ProfilePanel me={makeMe({ plan: undefined })} onClose={() => {}} />);
    expect(screen.getByText("Free")).toBeInTheDocument();
  });

  test("never renders a 'View plans' CTA (no paywall)", () => {
    render(<ProfilePanel me={makeMe({ plan: "free" })} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "View plans" })).not.toBeInTheDocument();
  });
});

describe("ProfilePanel — no usage meter (#186)", () => {
  test("never renders a usage progressbar", () => {
    render(<ProfilePanel me={makeMe({ plan: "ultra" })} onClose={() => {}} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

describe("ProfilePanel — dismissal", () => {
  test("the close button calls onClose", async () => {
    const onClose = vi.fn();
    render(<ProfilePanel me={makeMe()} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking the backdrop closes; clicking inside the panel does not", async () => {
    const onClose = vi.fn();
    const { container } = render(<ProfilePanel me={makeMe()} onClose={onClose} />);
    await userEvent.click(screen.getByRole("heading", { name: "Profile" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape closes and the handler is cleaned up on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(<ProfilePanel me={makeMe()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

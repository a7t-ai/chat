import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "./__tests__/localStorage";
import type { Me } from "./lib/api";

// App is the auth gate: it calls fetchMe() once on mount and routes to LoginView
// (unauthenticated, or a verified-but-ungated account parked at the invite step) or the
// ChatView (authed with access). We mock the API + the two heavy children so the test
// exercises ONLY the routing decision + sign-out wiring, not their internals.

const fetchMe = vi.fn();
const clearToken = vi.fn();
const logout = vi.fn();

vi.mock("./lib/api", () => ({
  fetchMe: (...a: unknown[]) => fetchMe(...a),
  clearToken: (...a: unknown[]) => clearToken(...a),
  logout: (...a: unknown[]) => logout(...a),
}));

vi.mock("./components/ChatView", () => ({
  ChatView: ({ me, onSignOut }: { me: Me; onSignOut: () => void }) => (
    <div data-testid="chatview">
      <span>authed:{me.user.login}</span>
      <button type="button" onClick={onSignOut}>
        sign out
      </button>
    </div>
  ),
}));

// Stand in for LoginView so we can assert which step App parks it at, and trigger its
// onAuthed callback without touching the real flow internals. The stand-in records the props
// it received so a test can assert App no longer wires a legacy `onToken`.
let loginProps: Record<string, unknown> | null = null;
vi.mock("./components/LoginView", () => ({
  LoginView: (props: { onAuthed: () => void }) => {
    loginProps = props;
    return (
      <div data-testid="loginview">
        <button type="button" onClick={props.onAuthed}>
          authed
        </button>
      </div>
    );
  },
}));

// Stand in for the public watch page so the routing test stays about App's decision, not
// WatchView internals (covered by its own test).
// A flag so one test can make WatchView throw during render, exercising the app-level
// ErrorBoundary backstop that wraps the whole tree.
let watchThrows = false;
vi.mock("./components/WatchView", () => ({
  WatchView: ({ slug }: { slug: string }) => {
    if (watchThrows) throw new Error("watch exploded");
    return <div data-testid="watchview">watch:{slug}</div>;
  },
}));

vi.mock("./lib/theme", () => ({ syncTheme: vi.fn() }));

const ME: Me = {
  role: "guest",
  via: "token",
  user: { id: "u1", login: "leo", displayName: "Leo" },
  key: { id: "k1", label: "key" },
  theme: null,
  lang: null,
};

let App: typeof import("./App").default;

beforeEach(async () => {
  installLocalStorage();
  window.history.pushState({}, "", "/");
  loginProps = null;
  watchThrows = false;
  fetchMe.mockReset();
  clearToken.mockReset();
  logout.mockReset();
  ({ default: App } = await import("./App"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App routing", () => {
  test("shows the login screen when fetchMe resolves null", async () => {
    fetchMe.mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByTestId("loginview")).toBeInTheDocument();
    expect(screen.queryByTestId("chatview")).toBeNull();
  });

  test("shows the login screen when fetchMe throws", async () => {
    fetchMe.mockRejectedValue(new Error("boom"));
    render(<App />);
    expect(await screen.findByTestId("loginview")).toBeInTheDocument();
  });

  test("renders the public watch page on /s/{slug} with NO auth probe", async () => {
    window.history.pushState({}, "", "/s/myslug");
    render(<App />);
    expect(await screen.findByTestId("watchview")).toHaveTextContent("watch:myslug");
    expect(screen.queryByTestId("chatview")).toBeNull();
    expect(screen.queryByTestId("loginview")).toBeNull();
    expect(fetchMe).not.toHaveBeenCalled(); // anonymous watcher: no identity round-trip
  });

  test("app-level ErrorBoundary contains an uncaught render throw (no blank screen)", () => {
    watchThrows = true;
    window.history.pushState({}, "", "/s/boom");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {}); // silence React's boundary log
    render(<App />);
    // The full-screen backstop shows instead of the tree unmounting to blank.
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.queryByTestId("watchview")).toBeNull();
    spy.mockRestore();
  });

  test("routes a never-granted / revoked account (accessGranted:false) to the login screen (#169)", async () => {
    fetchMe.mockResolvedValue({
      ...ME,
      role: "account",
      via: "session",
      accessGranted: false,
      user: { id: "u2", login: "acct_x", displayName: null, email: "a@b.co" },
    });
    render(<App />);
    // No self-service grant path anymore — such an account lands on the passkey login screen, not the app.
    expect(await screen.findByTestId("loginview")).toBeInTheDocument();
    expect(screen.queryByTestId("chatview")).toBeNull();
  });

  test("renders ChatView for an account with access granted", async () => {
    fetchMe.mockResolvedValue({
      ...ME,
      role: "account",
      via: "session",
      accessGranted: true,
      user: { id: "u2", login: "acct_x", displayName: null, email: "a@b.co" },
    });
    render(<App />);
    expect(await screen.findByTestId("chatview")).toHaveTextContent("authed:acct_x");
  });

  test("renders ChatView when fetchMe resolves an authed guest", async () => {
    fetchMe.mockResolvedValue(ME);
    render(<App />);
    expect(await screen.findByTestId("chatview")).toHaveTextContent("authed:leo");
  });

  test("onAuthed re-checks /api/me and routes into the app (login -> authed)", async () => {
    fetchMe.mockResolvedValueOnce(null).mockResolvedValueOnce(ME);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "authed" }));
    expect(await screen.findByTestId("chatview")).toBeInTheDocument();
    expect(fetchMe).toHaveBeenCalledTimes(2);
  });

  test("no longer passes a legacy onToken prop to LoginView (invites are the only credential)", async () => {
    fetchMe.mockResolvedValue(null);
    render(<App />);
    await screen.findByTestId("loginview");
    expect(loginProps).not.toBeNull();
    expect("onToken" in (loginProps as Record<string, unknown>)).toBe(false);
  });

  test("signing out a guest clears the token, does NOT call logout, and re-checks", async () => {
    fetchMe.mockResolvedValueOnce(ME).mockResolvedValueOnce(null);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "sign out" }));
    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("loginview")).toBeInTheDocument());
  });

  test("signing out an account calls logout() then clears + re-checks", async () => {
    const acct: Me = {
      ...ME,
      role: "account",
      via: "session",
      accessGranted: true,
      user: { id: "u2", login: "acct_x", displayName: null, email: "a@b.co" },
    };
    fetchMe.mockResolvedValueOnce(acct).mockResolvedValueOnce(null);
    logout.mockResolvedValue(undefined);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "sign out" }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(clearToken).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("loginview")).toBeInTheDocument());
  });

  test("account sign-out AWAITS logout before re-checking (no re-login race)", async () => {
    const acct: Me = {
      ...ME,
      role: "account",
      via: "session",
      accessGranted: true,
      user: { id: "u2", login: "acct_x", displayName: null, email: "a@b.co" },
    };
    // logout resolves on a microtask; record when it's actually done.
    let logoutResolved = false;
    logout.mockImplementation(async () => {
      await Promise.resolve();
      logoutResolved = true;
    });
    // The recheck (2nd fetchMe) must run ONLY after logout resolved — otherwise the still-valid
    // session re-logs the user in (the bug). Capture what the recheck saw.
    let recheckSawLogout: boolean | null = null;
    fetchMe.mockImplementationOnce(async () => acct).mockImplementationOnce(async () => {
      recheckSawLogout = logoutResolved;
      return null;
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "sign out" }));
    await waitFor(() => expect(screen.getByTestId("loginview")).toBeInTheDocument());
    expect(logout).toHaveBeenCalledTimes(1);
    // With `void logout()` this is false (recheck raced ahead); with `await logout()` it's true.
    expect(recheckSawLogout).toBe(true);
  });

  test("syncs theme + lang from the server identity on login", async () => {
    const { syncTheme } = await import("./lib/theme");
    fetchMe.mockResolvedValue({ ...ME, theme: "mocha", lang: "pt-BR" });
    render(<App />);
    await screen.findByTestId("chatview");
    expect(syncTheme).toHaveBeenCalledWith("mocha");
    expect(document.documentElement.lang).toBe("pt-BR");
  });

  test("serves the /help page publicly (no auth)", async () => {
    window.history.pushState({}, "", "/help");
    fetchMe.mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Help & Contact" })).toBeInTheDocument();
    expect(screen.queryByTestId("loginview")).toBeNull();
  });

  test("a removed legal route (/privacy) is not a known route → 404, never the login", async () => {
    window.history.pushState({}, "", "/privacy");
    fetchMe.mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(screen.queryByTestId("loginview")).toBeNull();
  });
});

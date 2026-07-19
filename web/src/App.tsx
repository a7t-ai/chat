import { type ReactNode, useEffect, useState } from "react";
import { ChatView } from "./components/ChatView";
import { DesignSystem } from "./components/DesignSystem";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Help } from "./components/Help";
import { LoginView } from "./components/LoginView";
import { NotFound } from "./components/NotFound";
import { WatchView } from "./components/WatchView";
import { applyEnvFavicon } from "./lib/favicon";
import { clearToken, fetchMe, logout, type Me } from "./lib/api";
import { syncLang } from "./lib/i18n";
import { syncPreferences } from "./lib/preferences";
import { currentShareSlug, isKnownRoute } from "./lib/route";
import { syncTheme } from "./lib/theme";

// "login" shows the passkey sign-up / sign-in screen (unauthenticated, or a legacy account whose
// session is valid but whose access was never granted / was revoked — recovery is owner-only, #169).
type State =
  | { status: "loading" }
  | { status: "login" }
  | { status: "authed"; me: Me };

export default function App() {
  const [state, setState] = useState<State>({ status: "loading" });

  async function check() {
    // The public watch page (`/s/{slug}`) needs no identity — skip the auth probe entirely so
    // an anonymous watcher never triggers a 401 round-trip.
    if (currentShareSlug()) return;
    setState({ status: "loading" });
    try {
      const me = await fetchMe();
      if (!me) {
        // No identity at all → the passkey sign-up / sign-in screen.
        setState({ status: "login" });
        return;
      }
      // On staging, recolor the tab (favicon + theme-color) to orange — a no-op on production.
      applyEnvFavicon(me.env);
      // A legacy/never-granted or owner-revoked account can hold a valid session but no access.
      // There's no self-service grant path anymore (#169), so send them to the login screen (they
      // can sign up a new account or wait for the owner to restore access) rather than into the app.
      if (me.role === "account" && me.accessGranted === false) {
        setState({ status: "login" });
        return;
      }
      syncTheme(me.theme);
      syncLang(me.lang);
      syncPreferences(me.preferences);
      setState({ status: "authed", me });
    } catch {
      setState({ status: "login" });
    }
  }

  useEffect(() => {
    check();
  }, []);

  // Auth check is near-instant; render nothing (blank on the themed bg) rather than a
  // jarring "…" flash before the wall or the app resolves.
  // Public, no-login shareable-live-collab watch page — short-circuits the auth gate.
  const shareSlug = currentShareSlug();
  let content: ReactNode;
  if (shareSlug) content = <WatchView slug={shareSlug} />;
  else if (window.location.pathname === "/help") content = <Help />;
  else if (window.location.pathname === "/design-system") content = <DesignSystem />;
  // Any URL that isn't a real route → 404, ahead of the auth branches (a nonexistent path is
  // nonexistent whether or not you're signed in). Without this the SPA fallback would render the
  // home app for e.g. /dasda.
  else if (!isKnownRoute()) content = <NotFound />;
  else if (state.status === "loading") content = null;
  // Unauthenticated (or a legacy/revoked account) → the passkey sign-up / sign-in screen.
  else if (state.status === "login") content = <LoginView onAuthed={check} />;
  else
    content = (
      <ChatView
        me={state.me}
        // Patch the caller's own user fields in place (e.g. a handle set from Profile, #189) without
        // a full /api/me refetch — keeps the account menu + profile card current, no loading flash.
        onUserChange={(patch) =>
          setState((s) => (s.status === "authed" ? { status: "authed", me: { ...s.me, user: { ...s.me.user, ...patch } } } : s))
        }
        onSignOut={async () => {
          // Account users hold a server session — destroy it AND AWAIT it (the destroy + the
          // Set-Cookie clear) BEFORE re-checking. Otherwise check()'s fetchMe races the
          // still-valid session and instantly re-logs you in (the "sign-out does nothing" bug).
          // Guests/dev-admins carry a local token; Tailscale admins re-auth via the header
          // (ChatView hides sign-out for them).
          if (state.me.role === "account") await logout();
          clearToken();
          check();
        }}
      />
    );

  // App-level backstop: any uncaught throw anywhere in the tree is contained to a recoverable
  // full-screen message instead of unmounting React to a blank/dark screen.
  return (
    <ErrorBoundary
      fallback={(reset) => (
        <div className="app-error" role="alert">
          <h1>Something went wrong</h1>
          <p>The app hit an unexpected error. Reloading usually fixes it.</p>
          <div className="app-error-actions">
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button type="button" className="btn" onClick={reset}>
              Try again
            </button>
          </div>
        </div>
      )}
    >
      {content}
    </ErrorBoundary>
  );
}

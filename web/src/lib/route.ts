// Minimal URL routing for chats — no router library. A conversation lives at
// `/c/{id}`, the new-chat / empty state lives at `/`. The Bun server (and Vite
// dev) fall back to index.html for these paths, so refreshing reopens the chat.

export function currentConversationId(): string | null {
  const m = window.location.pathname.match(/^\/c\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function navigateToConversation(id: string, replace = false): void {
  const url = `/c/${encodeURIComponent(id)}`;
  if (window.location.pathname === url) return;
  if (replace) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}

export function navigateToNew(replace = false): void {
  if (window.location.pathname === "/") return;
  if (replace) window.history.replaceState({}, "", "/");
  else window.history.pushState({}, "", "/");
}

// A shared conversation's public watch page lives at `/s/{slug}` — reachable with no login
// (the share link IS the credential). Returns the slug when the URL is a watch page, else
// null. The SPA fallback serves index.html here too, so the link opens straight into the
// read-only live view.
export function currentShareSlug(): string | null {
  const m = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// The exact static paths the app renders (keep in sync with the pathname checks in App.tsx).
const STATIC_ROUTES = new Set(["/", "/help", "/design-system"]);

// True when the current URL maps to something the app actually renders. The Bun/Vite server
// serves index.html for EVERY non-asset path (the SPA fallback that makes /c/{id} refreshable),
// so without this an unknown URL like /nope would silently boot the home app instead of a
// not-found page. App.tsx renders <NotFound/> when this returns false.
export function isKnownRoute(): boolean {
  if (STATIC_ROUTES.has(window.location.pathname)) return true;
  return currentConversationId() !== null || currentShareSlug() !== null;
}

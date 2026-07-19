// Swap the browser-tab identity to the ORANGE staging mark when the app is running on staging, so a
// staging tab is unmistakable at a glance among a row of production tabs. Production keeps the teal
// mark from index.html — this only ever acts on staging, and is idempotent (safe to call repeatedly).
// The env comes from /api/me (`me.env`), the same signal the staging badge uses.

const STAGING_FAVICON = "/favicon-staging.svg";
// Matches the amber the staging badge already uses (`#f59e0b`), so the tab, the badge, and the mobile
// browser chrome all read as the same "staging = orange" language.
const STAGING_THEME_COLOR = "#F59E0B";

export function applyEnvFavicon(env: string | undefined): void {
  if (typeof document === "undefined") return; // SSR / test guard
  if (env !== "staging") return; // production (or unknown) keeps the default teal mark

  // REPLACE every icon link with a single fresh one pointing at the orange mark. Two reasons this
  // beats mutating the existing <link href>: (1) Chrome caches favicons hard and often won't repaint
  // the tab when an existing link's href merely changes — inserting a NEW <link> element forces a
  // re-fetch; (2) index.html also ships a teal `.ico` fallback, so we must remove it or Chrome can
  // keep showing the cached teal icon. Dropping all icons and adding one orange SVG covers both.
  document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove());
  const icon = document.createElement("link");
  icon.rel = "icon";
  icon.type = "image/svg+xml";
  icon.href = STAGING_FAVICON;
  document.head.appendChild(icon);

  // Tint the theme-color too (mobile status bar / PWA chrome) so staging reads orange there as well.
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = STAGING_THEME_COLOR;
}

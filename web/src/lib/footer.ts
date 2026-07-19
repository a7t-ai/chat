// Single source of truth for the help + a7t.ai links rendered in the public-page footer
// (login wall + doc pages) and the in-app "About" dialog. Keeping the list here — rather
// than inline in each component — means the footer and the About dialog never drift, and
// a new page becomes a one-line flip.
//
// Each entry carries an `enabled` flag: a route that doesn't exist yet stays `enabled: false`
// so it renders NOTHING until its page ships — flip the flag in the same PR that adds the route.
// This is the "render each only when its route exists" guarantee, kept declarative and testable.

import type { MessageKey } from "./i18n";

export interface FooterLink {
  id: string;
  labelKey: MessageKey;
  href: string;
  // External links open in a new tab and get rel="noopener noreferrer" (no reverse
  // tabnabbing, no referrer leak). Internal links navigate in place.
  external?: boolean;
  // false while the target route doesn't exist yet — hidden until it ships.
  enabled: boolean;
}

// Order is the render order. The a7t.ai cross-link always comes last and is the only
// external entry (the brand tie-back, styled subtly).
const LINKS: readonly FooterLink[] = [
  // Help link removed from the footer + About (owner request). The /help route still exists;
  // flip back to `true` to re-surface the link.
  { id: "help", labelKey: "footer.help", href: "/help", enabled: false },
  { id: "a7t", labelKey: "footer.partOf", href: "https://a7t.ai", external: true, enabled: true },
];

// The links to actually render right now (existing routes + the a7t.ai cross-link).
export function footerLinks(): FooterLink[] {
  return LINKS.filter((l) => l.enabled);
}

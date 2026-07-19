import { footerLinks } from "../lib/footer";
import { useT } from "../lib/i18n";

// Muted, theme-aware footer for the standalone/public pages (the login wall + doc pages
// like /privacy). Deliberately NOT rendered inside the chat thread — a chat fills the
// screen, so the in-app path to these links is the "About" dialog instead (see AboutPanel).
// Links come from the shared registry (../lib/footer) so this and About never drift.
export function Footer() {
  const t = useT();
  const links = footerLinks();
  return (
    <footer className="site-footer">
      <nav className="site-footer-links" aria-label={t("footer.aria")}>
        {links.map((l) =>
          l.external ? (
            <a
              key={l.id}
              className="site-footer-link footer-cross"
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t(l.labelKey)}
            </a>
          ) : (
            <a key={l.id} className="site-footer-link" href={l.href}>
              {t(l.labelKey)}
            </a>
          ),
        )}
      </nav>
    </footer>
  );
}

import { footerLinks } from "../lib/footer";
import { useT } from "../lib/i18n";
import { Modal } from "./ui";

// In-app "About" dialog: the path to the legal/help links + the a7t.ai cross-link from
// inside the chat (where there's no persistent footer, so the chat thread stays uncluttered).
// Opened from the account menu and the command palette. Uses the shared ui/ Modal dialog shell
// and shares the link registry with the public Footer.
export function AboutPanel({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const links = footerLinks();

  return (
    <Modal bare={embedded} title={t("about.title")} onClose={onClose} closeLabel={t("common.close")} className="about-panel">
      <p className="muted small">{t("about.intro")}</p>
      <ul className="about-links">
        {links.map((l) => (
          <li key={l.id}>
            <a href={l.href} {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {t(l.labelKey)}
            </a>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

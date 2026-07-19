import { useEffect, useState } from "react";
import { type CollaboratorRole, fetchSharedConversations, type SharedConversationMeta } from "../lib/api";
import { type MessageKey, useT } from "../lib/i18n";
import { InlineMessage, Modal } from "./ui";

// The invitee's side of the Share PRIMITIVE — "shared with me". Lists conversations OTHER people
// invited the caller to collaborate on (identity-bound grants that surface in their own app).
// Opening a row hands the conversation id back to ChatView, which loads it through the normal
// authed read path (now permitted for a collaborator) — read + live-watch of the same object.

const ROLE_LABEL: Record<CollaboratorRole, MessageKey> = {
  view: "collab.role.view",
  suggest: "collab.role.suggest",
  edit: "collab.role.edit",
  prompt: "collab.role.prompt",
};

export function SharedPanel({ onClose, onOpen, embedded }: { onClose: () => void; onOpen: (id: string) => void; embedded?: boolean }) {
  const t = useT();
  const [list, setList] = useState<SharedConversationMeta[]>([]);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchSharedConversations()
      .then(setList)
      .catch(() => setError(true))
      .finally(() => setLoaded(true));
  }, []);

  function open(id: string) {
    onOpen(id);
    onClose();
  }

  return (
    <Modal bare={embedded} title={t("shared.title")} onClose={onClose} closeLabel={t("common.close")}>
      {error && <InlineMessage variant="danger" role="alert">{t("shared.error")}</InlineMessage>}
      {loaded && !error && list.length === 0 && <p className="muted small">{t("shared.none")}</p>}
      {list.length > 0 && (
        <ul className="shared-list">
          {list.map((s) => (
            <li key={s.id} className="shared-row">
              <button className="shared-open" onClick={() => open(s.id)}>
                <span className="shared-title">{s.title || t("watch.untitled")}</span>
                <span className="shared-meta muted small">
                  {t("shared.by", { name: s.ownerName })} · {t(ROLE_LABEL[s.role])}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

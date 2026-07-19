import { Users } from "lucide-react";
import { useEffect, useState } from "react";
import { type DirectoryUser, fetchDirectory } from "../lib/api";
import { useT } from "../lib/i18n";
import { InlineMessage, Input, Modal } from "./ui";

// User directory (#190): the "People" surface. Any signed-in user can search the accounts on this
// instance that opted in with a handle (#189) and see their handle + display name — never any private
// data (the server returns ONLY public identity fields: id + handle + display name). This feeds the
// identity-bound collaboration invite picker (#177). Search is debounced and hits GET /api/users?q=
// server-side, which is bounded + capped; a blank query lists everyone (capped). Mirrors the other
// panels: Modal chrome (bare when embedded in the account modal), Input search, InlineMessage errors.
export function DirectoryPanel({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<DirectoryUser[] | null>(null);
  const [error, setError] = useState(false);

  // Debounce the search so typing doesn't fire a request per keystroke. The empty query loads the
  // (capped) full listing on mount. `alive` guards against a stale response overwriting a newer one.
  useEffect(() => {
    let alive = true;
    const id = setTimeout(() => {
      fetchDirectory(query)
        .then((list) => {
          if (!alive) return;
          setUsers(list);
          setError(false);
        })
        .catch(() => {
          if (alive) setError(true);
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [query]);

  const rows = users ?? [];

  return (
    <Modal bare={embedded} title={t("directory.title")} onClose={onClose} closeLabel={t("common.close")}>
      <p className="muted small">{t("directory.subtitle")}</p>

      <Input
        className="directory-search"
        type="search"
        value={query}
        placeholder={t("directory.searchPlaceholder")}
        aria-label={t("directory.searchPlaceholder")}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && (
        <InlineMessage variant="danger" role="alert">
          {t("directory.loadError")}
        </InlineMessage>
      )}
      {!error && users !== null && rows.length === 0 && (
        <div className="directory-empty">
          <Users size={30} strokeWidth={1.5} className="directory-empty-ico" aria-hidden="true" />
          <p className="muted small">{query.trim() ? t("directory.emptyQuery") : t("directory.empty")}</p>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="directory-list">
          {rows.map((u) => (
            <li key={u.id} className="directory-row">
              <span className="directory-name">{u.name}</span>
              {/* Show the @handle line only when it adds information (the name isn't already the handle). */}
              {u.name !== u.handle && <span className="directory-handle muted small">@{u.handle}</span>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

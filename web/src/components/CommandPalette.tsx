import { Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../lib/i18n";

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

// Bold the matched run of the query within a label.
function highlight(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <strong className="match">{text.slice(idx, idx + q.length)}</strong>
      {text.slice(idx + q.length)}
    </>
  );
}

// Cloudflare-style command palette: fuzzy filter over grouped items, arrow-key
// navigation, Enter to run, Esc to close. Opened with Cmd/Ctrl+K (handled by the parent).
export function CommandPalette({ items, onClose }: { items: CommandItem[]; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const flat = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((it) =>
      `${it.label} ${it.group} ${it.keywords ?? ""}`.toLowerCase().includes(needle),
    );
  }, [q, items]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, { item: CommandItem; idx: number }[]>();
    flat.forEach((item, idx) => {
      if (!map.has(item.group)) {
        map.set(item.group, []);
        order.push(item.group);
      }
      map.get(item.group)!.push({ item, idx });
    });
    return order.map((g) => ({ group: g, rows: map.get(g)! }));
  }, [flat]);

  function choose(i: number) {
    const it = flat[i];
    if (it) {
      it.run();
      onClose();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="overlay palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="palette-search">
          <Search className="palette-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder={t("palette.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd className="palette-esc">esc</kbd>
        </div>

        <div className="palette-list" ref={listRef}>
          {flat.length === 0 && <div className="palette-empty muted">{t("palette.noResults")}</div>}
          {groups.map((g) => (
            <div key={g.group} className="palette-group">
              <div className="palette-group-label">{g.group}</div>
              {g.rows.map(({ item, idx }) => (
                <button
                  key={item.id}
                  data-idx={idx}
                  type="button"
                  className={`palette-item ${idx === active ? "active" : ""}`}
                  onMouseMove={() => setActive(idx)}
                  onClick={() => choose(idx)}
                >
                  <span className="palette-label">{highlight(item.label, q)}</span>
                  {item.hint ? <span className="palette-hint muted">{item.hint}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="palette-footer muted">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("palette.navigate")}
          </span>
          <span>
            <kbd>↵</kbd> {t("palette.select")}
          </span>
          <span>
            <kbd>esc</kbd> {t("common.close")}
          </span>
        </div>
      </div>
    </div>
  );
}

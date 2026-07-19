import { EllipsisVertical, Pencil, Sparkles, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConversationMeta } from "../lib/api";
import { useT } from "../lib/i18n";

// A single sidebar conversation row: opens on click, double-click or the ⋯ menu
// renames inline, and the menu also toggles the star or deletes the chat. It's also a
// drag source (#57): dragging the row onto the Favorites/Recents section (un)stars it.
export function ConvoItem({
  convo,
  active,
  generating = false,
  draggable = false,
  onOpen,
  onRename,
  onGenerateTitle,
  onToggleStar,
  onDelete,
  onDragStart,
  onDragEnd,
}: {
  convo: ConversationMeta;
  active: boolean;
  generating?: boolean;
  draggable?: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onGenerateTitle: () => void;
  onToggleStar: () => void;
  onDelete: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const renamingRef = useRef(false); // guards Enter+blur from committing twice
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const title = convo.title ?? t("chat.untitled");

  // Close the menu when clicking anywhere outside it.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocPointer(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointer);
    return () => document.removeEventListener("pointerdown", onDocPointer);
  }, [menuOpen]);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  function beginRename() {
    setMenuOpen(false);
    setDraft(convo.title ?? "");
    renamingRef.current = true;
    setRenaming(true);
  }
  function commitRename() {
    if (!renamingRef.current) return;
    renamingRef.current = false;
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== (convo.title ?? "")) onRename(next);
  }
  function cancelRename() {
    renamingRef.current = false;
    setRenaming(false);
  }

  if (renaming) {
    return (
      <li className={`convo-item ${active ? "active" : ""}`}>
        <input
          ref={inputRef}
          className="convo-rename-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          }}
          maxLength={200}
          aria-label={t("chat.conversationName")}
        />
      </li>
    );
  }

  return (
    <li
      className={`convo-item ${active ? "active" : ""} ${draggable ? "draggable" : ""}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <button
        className="convo-open"
        onClick={onOpen}
        onDoubleClick={beginRename}
        title={title}
        aria-current={active ? "true" : undefined}
      >
        <span className="convo-title">{title}</span>
      </button>
      {generating && (
        <span className="convo-spinner" aria-label={t("convo.generating")} title={t("convo.generatingTitle")}>
          {/* The a7t mark (three pulsing teal bars) — same animation as the thinking verb. */}
          <svg className="thinking-mark" viewBox="0 0 100 100" width="16" height="16" aria-hidden="true">
            <rect className="tb tb1" x="26" y="30" width="48" height="8" rx="4" />
            <rect className="tb tb2" x="26" y="46" width="40" height="8" rx="4" />
            <rect className="tb tb3" x="34" y="62" width="30" height="8" rx="4" />
          </svg>
        </span>
      )}
      <div className="convo-menu" ref={menuRef}>
        <button
          className="convo-dots"
          aria-label={t("convo.options")}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <EllipsisVertical size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="menu-pop convo-pop">
            <button
              className="menu-item"
              onClick={() => {
                onToggleStar();
                setMenuOpen(false);
              }}
            >
              <Star size={16} strokeWidth={1.75} fill={convo.starred ? "currentColor" : "none"} aria-hidden="true" />
              {convo.starred ? t("convo.unstar") : t("convo.star")}
            </button>
            <button className="menu-item" onClick={beginRename}>
              <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
              {t("convo.rename")}
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setMenuOpen(false);
                onGenerateTitle();
              }}
            >
              {/* Sparkles — the auto/AI "generate" affordance, distinct from the star. */}
              <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
              {t("convo.generateTitle")}
            </button>
            <div className="menu-sep" />
            <button
              className="menu-item danger"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            >
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              {t("common.delete")}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

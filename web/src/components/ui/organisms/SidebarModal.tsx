import type { LucideIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Button } from "../atoms/Button";

export interface SidebarModalItem {
  id: string;
  label: string;
  icon?: LucideIcon;
}

// ORGANISM · SidebarModal — a wide modal with a left nav rail + a content pane (the YouTube /
// ChatGPT settings pattern). Consolidates many small dialogs (Profile, Plans, Settings, Keyboard…)
// into ONE modal with sections, so the account menu stops growing linearly. Controlled: the caller
// owns `activeId` and renders the active section as `children`. Backdrop / Esc close it.
export function SidebarModal({
  title,
  items,
  activeId,
  onSelect,
  onClose,
  closeLabel = "Close",
  children,
}: {
  title: ReactNode;
  items: readonly SidebarModalItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode; // the active section's content
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const label = typeof title === "string" ? title : undefined;
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="panel ui-sidebar-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <header className="panel-head ui-sidebar-head">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {closeLabel}
          </Button>
        </header>
        <div className="ui-sidebar-body">
          <nav className="ui-sidebar-nav" aria-label={label ?? "Sections"}>
            {items.map((it) => {
              const Icon = it.icon;
              return (
                <button
                  key={it.id}
                  type="button"
                  className={`ui-sidebar-nav-item${it.id === activeId ? " active" : ""}`}
                  aria-current={it.id === activeId ? "page" : undefined}
                  onClick={() => onSelect(it.id)}
                >
                  {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden="true" />}
                  <span>{it.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="ui-sidebar-content">{children}</div>
        </div>
      </div>
    </div>
  );
}

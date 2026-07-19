import { useEffect } from "react";
import type { ReactNode } from "react";
import { Button } from "../atoms/Button";

// ORGANISM · Modal — the app's dialog shell: a full-screen backdrop that closes on click, a centered
// panel that stops propagation, and a header (title + optional actions + a Close button). Esc closes
// it too. Every dialog (Settings, Keyboard, Telemetry…) is this shape. Style: `.overlay` / `.panel`.
export function Modal({
  title,
  onClose,
  closeLabel = "Close",
  headerActions,
  className,
  children,
  bare,
}: {
  title: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  headerActions?: ReactNode; // extra header buttons, placed before Close
  className?: string; // extra class on the panel (e.g. a width variant)
  children: ReactNode;
  // Render ONLY the children — no backdrop, panel chrome, header, or Esc handling. For embedding a
  // panel's body inside another dialog (the account SidebarModal), where the host owns the chrome.
  bare?: boolean;
}) {
  useEffect(() => {
    if (bare) return; // the host dialog owns Esc when embedded
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, bare]);

  if (bare) return <>{children}</>;

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className={className ? `panel ${className}` : "panel"}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
      >
        <header className="panel-head">
          <h2>{title}</h2>
          <div className="panel-head-actions">
            {headerActions}
            <Button variant="ghost" size="sm" onClick={onClose}>
              {closeLabel}
            </Button>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

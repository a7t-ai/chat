import type { LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

// ORGANISM · Menu — a dropdown: a trigger button that toggles a popover of MenuItems, closing on
// outside-click or Esc. Compose with <MenuItem> + <MenuSeparator>. Style: `.menu` / `.menu-pop`.
export function Menu({
  trigger,
  triggerLabel,
  align = "right",
  children,
}: {
  trigger: ReactNode; // content of the trigger button (an icon, an avatar…)
  triggerLabel: string; // accessible name for the trigger
  align?: "left" | "right"; // which edge the popover hangs from
  children: ReactNode; // MenuItem / MenuSeparator
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu ui-menu" ref={ref}>
      <button
        type="button"
        className="ui-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div className={`menu-pop ui-menu-pop${align === "left" ? " ui-menu-pop-left" : ""}`} role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

// A single menu row: optional leading icon, a `danger` variant, and `disabled` / `active` states.
export function MenuItem({
  icon: Icon,
  variant = "default",
  disabled = false,
  active = false,
  onClick,
  children,
}: {
  icon?: LucideIcon;
  variant?: "default" | "danger";
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const classes = ["menu-item", "ui-menu-item"];
  if (variant === "danger") classes.push("danger");
  if (active) classes.push("active");
  return (
    <button
      type="button"
      role="menuitem"
      className={classes.join(" ")}
      disabled={disabled}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
    >
      {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}

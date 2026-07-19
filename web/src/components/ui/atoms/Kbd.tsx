import type { ReactNode } from "react";

// ATOM · Kbd — a single keyboard key, rendered as a <kbd> chip. The smallest design-system unit for
// anything key-related: cheat sheets, shortcut rows, inline hints. Compose several via <KeyCombo>.
// Style: `.ui-kbd` (see styles/ui.css).
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={className ? `ui-kbd ${className}` : "ui-kbd"}>{children}</kbd>;
}

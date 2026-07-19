import type { ReactNode } from "react";

// MOLECULE · PanelActions — the standard action row for a panel's footer/body CTAs. Design-system
// rule: call-to-action buttons live on the RIGHT. Right-aligned by default
// (`justify-content: flex-end`); the `align="between"` variant anchors a destructive action on the
// left and the primary on the right (`space-between`). Wrap a panel's action buttons in this instead
// of a hand-rolled flex row so alignment never drifts per panel. Style: `.ui-panel-actions`.
export function PanelActions({
  children,
  align = "end",
  className,
}: {
  children: ReactNode;
  align?: "end" | "between"; // "end" (default) right-aligns; "between" splits destructive ↔ primary
  className?: string;
}) {
  const classes = ["ui-panel-actions"];
  if (align === "between") classes.push("ui-panel-actions-between");
  if (className) classes.push(className);
  return <div className={classes.join(" ")}>{children}</div>;
}

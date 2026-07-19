import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

export type InlineMessageVariant = "danger" | "warning" | "success" | "info";

const ICONS = {
  danger: TriangleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Info,
} as const;

// MOLECULE · InlineMessage — a compact inline status / validation message (icon + text) in a
// semantic color. The one way to show a field error, an inline hint, or a confirmation, so red
// text never looks ad-hoc. Pass `role="alert"` for live validation errors. Style: `.ui-msg`.
export function InlineMessage({
  variant = "info",
  children,
  icon = true,
  role,
  className,
}: {
  variant?: InlineMessageVariant;
  children: ReactNode;
  icon?: boolean; // set false to drop the leading glyph
  role?: string; // e.g. "alert" for validation errors so assistive tech announces it
  className?: string;
}) {
  const Icon = ICONS[variant];
  return (
    <span className={`ui-msg ui-msg-${variant}${className ? ` ${className}` : ""}`} role={role}>
      {icon && <Icon size={13} strokeWidth={2} aria-hidden="true" className="ui-msg-icon" />}
      <span>{children}</span>
    </span>
  );
}

import type { ReactNode } from "react";

export type BadgeVariant = "neutral" | "accent" | "warning" | "success" | "danger";

// ATOM · Badge — a small pill label for status / metadata (env markers, tier tags, counts). Colored
// from the semantic tokens, so "warning" reads the same everywhere. Style: `.ui-badge`.
export function Badge({
  variant = "neutral",
  children,
  className,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}) {
  return <span className={`ui-badge ui-badge-${variant}${className ? ` ${className}` : ""}`}>{children}</span>;
}

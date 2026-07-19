import type { ReactNode } from "react";

// ATOM · SectionHeading — the `.sub` subheading used to title a group inside a panel/dialog
// (Appearance, Accessibility, …). One place to evolve section typography. Renders an <h3>.
export function SectionHeading({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={className ? `sub ${className}` : "sub"}>{children}</h3>;
}

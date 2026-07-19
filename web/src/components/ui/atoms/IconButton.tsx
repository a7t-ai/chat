import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ButtonSize } from "./Button";

// ATOM · IconButton — a square, icon-only button (the `.btn … icon-btn` pattern). `label` is
// REQUIRED and becomes the accessible name (an icon-only control must never ship without one).
// Pass `active` for a toggle/selected state (e.g. the minimap toggle, the share button when a
// conversation is shared) — it accent-tints the button and reflects `aria-pressed`.
export function IconButton({
  label,
  size = "md",
  ghost = true,
  active,
  className,
  children,
  ...rest
}: {
  label: string; // accessible name (aria-label + title)
  size?: ButtonSize;
  ghost?: boolean;
  active?: boolean; // toggle/selected state; also drives aria-pressed
  children: ReactNode; // the icon
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "aria-pressed">) {
  const classes = ["btn", "icon-btn"];
  if (ghost) classes.push("ghost");
  if (size === "sm") classes.push("small");
  if (active) classes.push("active");
  if (className) classes.push(className);
  return (
    <button className={classes.join(" ")} aria-label={label} title={label} {...rest} aria-pressed={active}>
      {children}
    </button>
  );
}

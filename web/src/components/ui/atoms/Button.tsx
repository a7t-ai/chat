import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "default" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

// ATOM · Button — the one button primitive. Wraps the app's existing `.btn` classes so it's a
// drop-in for the ~44 hand-written `<button className="btn …">` call-sites, with a typed variant +
// size instead of remembered class strings. Forwards every native button prop (onClick, disabled…).
export function Button({
  variant = "default",
  size = "md",
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ["btn"];
  if (variant === "primary") classes.push("primary");
  else if (variant === "ghost") classes.push("ghost");
  else if (variant === "danger") classes.push("danger");
  if (size === "sm") classes.push("small");
  if (className) classes.push(className);
  return (
    <button className={classes.join(" ")} {...rest}>
      {children}
    </button>
  );
}

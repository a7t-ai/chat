import type { ReactNode } from "react";
import { InlineMessage } from "./InlineMessage";

// MOLECULE · Field — a labelled form row: a label above a control, with an optional hint and an
// optional validation error (rendered as an InlineMessage). The one wrapper for settings/form
// controls, so label + spacing + error styling are consistent. Pass `htmlFor` to bind the label to
// a native control (renders a real <label>); omit it for a group of buttons (renders a <span>).
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `pref-field ${className}` : "pref-field"}>
      {label !== undefined &&
        (htmlFor ? (
          <label className="pref-label muted small" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="pref-label muted small">{label}</span>
        ))}
      {children}
      {hint !== undefined && <span className="muted small">{hint}</span>}
      {error !== undefined && (
        <InlineMessage variant="danger" role="alert">
          {error}
        </InlineMessage>
      )}
    </div>
  );
}

import type { ReactNode } from "react";

// MOLECULE · Toggle — an on/off switch with a label (and optional hint) on the left, the switch on
// the right. Exposes `role="switch"` + `aria-checked` for assistive tech. Style: `.toggle-row` /
// `.pref-toggle`.
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  className,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  className?: string;
}) {
  return (
    <div className={className ? `toggle-row ${className}` : "toggle-row"}>
      <span className="toggle-text">
        <span>{label}</span>
        {hint !== undefined ? <span className="muted small">{hint}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`pref-toggle ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="pref-toggle-knob" />
      </button>
    </div>
  );
}

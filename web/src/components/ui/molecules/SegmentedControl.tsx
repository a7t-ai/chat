import type { ReactNode } from "react";

// MOLECULE · SegmentedControl — a single-select group of chips (Sans / Serif / System; Comfortable /
// Compact; a language switch). i18n-agnostic: the caller passes `{ value, label }` options. Renders
// the `.chips` group; wrap it in a <Field> for a label. Style: `.chips` / `.chip`.
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={className ? `chips ${className}` : "chips"} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`chip ${value === o.value ? "on" : ""}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

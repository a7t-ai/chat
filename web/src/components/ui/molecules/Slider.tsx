import type { ReactNode } from "react";

// MOLECULE · Slider — a labelled range input with an optional live value readout (e.g. "95%"). The
// whole control is a <label>, so clicking the text focuses the range. Style: `.slider-field`.
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  ariaLabel,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (value: number) => ReactNode; // the readout shown beside the label
  ariaLabel?: string;
}) {
  return (
    <label className="slider-field">
      <span className="slider-label">
        {label}
        {format !== undefined && <span className="slider-val">{format(value)}</span>}
      </span>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={ariaLabel}
      />
    </label>
  );
}

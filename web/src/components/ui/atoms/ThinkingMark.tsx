// ATOM · ThinkingMark — the a7t "working" indicator: three bars that pulse in the accent color.
// Shown wherever the assistant is generating (the thinking verb, the sidebar spinner). Self-contained
// and animated (respects `prefers-reduced-motion` via the app's motion settings). Style: `.thinking-mark`.
export function ThinkingMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`thinking-mark ui-thinking-mark${className ? ` ${className}` : ""}`}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <rect className="tb tb1" x="26" y="30" width="48" height="8" rx="4" />
      <rect className="tb tb2" x="26" y="46" width="40" height="8" rx="4" />
      <rect className="tb tb3" x="34" y="62" width="30" height="8" rx="4" />
    </svg>
  );
}

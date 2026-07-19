import { Check, Copy, Download, Maximize2, Minimize2, WrapText } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

// Shared toolbar primitives for "rich" markdown blocks (fenced code, tables, and
// future block types like diagrams). Streamdown ships its own controls for these,
// but they don't match our visual language — so every block renders inside a
// bordered frame with a header bar of icon buttons, all styled from one place.
//
// To add a new block type: wrap it in <BlockFrame>, give it a <BlockBar>, and use
// <BlockAct> for each control. Don't hand-roll the markup — keep them consistent.

// Block-toolbar glyphs: inline 16px Lucide at the app-wide stroke weight.
export const BLOCK_ICONS = {
  copy: <Copy size={16} strokeWidth={1.75} aria-hidden="true" />,
  check: <Check size={16} strokeWidth={1.75} aria-hidden="true" />,
  download: <Download size={16} strokeWidth={1.75} aria-hidden="true" />,
  wrap: <WrapText size={16} strokeWidth={1.75} aria-hidden="true" />,
  expand: <Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" />,
  collapse: <Minimize2 size={16} strokeWidth={1.75} aria-hidden="true" />,
};

// The bordered container every rich block lives inside. Accepts a ref (React 19
// passes it as a normal prop) so blocks can target it for e.g. fullscreen.
export function BlockFrame({ className = "", ...rest }: ComponentProps<"div">) {
  return <div className={`block-frame ${className}`.trim()} {...rest} />;
}

// The block's header: an optional left-aligned label and a right-aligned row of
// actions. The label slot is always rendered (empty when omitted) so actions stay
// pinned to the right edge across every block type.
export function BlockBar({ label, children }: { label?: ReactNode; children: ReactNode }) {
  return (
    <div className="block-bar">
      <span className="block-label">{label}</span>
      <div className="block-acts">{children}</div>
    </div>
  );
}

// A single toolbar icon button. `on` marks an active toggle (e.g. line-wrap).
export function BlockAct({
  icon,
  title,
  label,
  on = false,
  pressed,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  label?: string;
  on?: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`block-act ${on ? "on" : ""}`.trim()}
      onClick={onClick}
      title={title}
      aria-label={label ?? title}
      aria-pressed={pressed}
    >
      {icon}
    </button>
  );
}

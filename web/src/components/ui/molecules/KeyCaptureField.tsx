import { KeyCombo } from "./KeyCombo";

// MOLECULE · KeyCaptureField — a width-stable control for viewing and re-recording a key chord.
// Shows the current chord (a <KeyCombo>) or, while capturing, a placeholder ("Press keys…"). The
// PARENT owns the recording state + the keydown capture; this is presentational. Its reserved
// min-width is the fix for the row jumping when the chord swaps for the placeholder (they no longer
// have different widths). Style: `.ui-key-capture`.
export function KeyCaptureField({
  keys,
  recording,
  placeholder,
  onStart,
  ariaLabel,
}: {
  keys: string[]; // the current chord, as display tokens (e.g. ["⌘", "⇧", "K"])
  recording: boolean;
  placeholder: string; // shown while capturing (e.g. "Press keys…")
  onStart: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      className="ui-key-capture"
      data-recording={recording ? "true" : undefined}
      onClick={onStart}
      aria-label={ariaLabel}
    >
      {recording ? <span className="ui-key-capture-placeholder">{placeholder}</span> : <KeyCombo keys={keys} />}
    </button>
  );
}

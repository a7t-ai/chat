import { Kbd } from "../atoms/Kbd";

// MOLECULE · KeyCombo — a key chord: a sequence of Kbd atoms (e.g. ⌘ ⇧ K). Purely the visual
// chord; capture/record logic lives in <KeyCaptureField>. Style: `.ui-combo`.
export function KeyCombo({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={className ? `ui-combo ${className}` : "ui-combo"}>
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

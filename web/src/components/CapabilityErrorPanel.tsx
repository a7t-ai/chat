import { X } from "lucide-react";
import { Button } from "./ui";

// Rendered by an ErrorBoundary in place of a capability drawer whose content threw (e.g. the
// map chunk / MapLibre blowing up). Keeps the drawer chrome so the crash reads as a contained
// panel, and its dismiss runs the SAME onClose as the real drawer — so one crashing surface
// never nukes the whole app. Copy is map-specific since maps is the only drawer surface today.
export function CapabilityErrorPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="cap-drawer cap-drawer-error" role="alert" aria-label="Map error">
      <header className="cap-drawer-head">
        <span className="cap-drawer-title">Map</span>
        <button type="button" className="cap-drawer-close" onClick={onClose} aria-label="Close map">
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div className="cap-drawer-error-body">
        <p>The map ran into a problem.</p>
        <Button type="button" onClick={onClose}>
          Dismiss
        </Button>
      </div>
    </aside>
  );
}

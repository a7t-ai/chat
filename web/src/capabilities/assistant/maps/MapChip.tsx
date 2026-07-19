import { MapPin } from "lucide-react";

// Inline pill rendered in place of a [[map:…]] marker. Collapsed by design: clicking is
// the consent to load (nothing external is fetched until then). Shows the short place
// name; the full payload goes to the canvas on click.
export function MapChip({ payload, open }: { payload: string; open: () => void }) {
  const short = payload.split(",")[0].trim() || payload;
  return (
    <button type="button" className="cap-chip map-chip" onClick={open} title={`Show ${payload} on the map`}>
      <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>{short}</span>
    </button>
  );
}

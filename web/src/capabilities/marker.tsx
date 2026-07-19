import { useOpenCapability } from "./context";
import { capabilityById } from "./registry";

// Renders in place of a  [[<id>:<payload>]]  marker (the remark plugin emits a
// <capmarker data-cap data-payload>). Looks up the capability and renders its Chip,
// wired to raise the payload to the canvas drawer. Unknown ids render as plain text so a
// stray marker never breaks the message.
export function CapabilityMarker({ capId, payload }: { capId: string; payload: string }) {
  const open = useOpenCapability();
  const cap = capabilityById(capId);
  if (!cap) return <>{payload}</>;
  const Chip = cap.Chip;
  return <Chip payload={payload} open={() => open(capId, payload)} />;
}

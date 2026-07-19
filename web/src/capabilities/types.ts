import type { FC } from "react";

// The a7t pillars — mirror of the server `Pillar` type (src/capabilities/types.ts). The
// SERVER descriptor is the source of truth; this is mirrored so the client can group
// capabilities by pillar in the UI ("The name is the map").
export type Pillar = "assistant" | "archivist" | "architect" | "autopilot" | "autoagent";

// Client half of a capability. The marker  [[<id>:<payload>]]  emitted by the model
// renders inline as <Chip>; clicking it opens <Surface> in the right-side canvas drawer.
// Register one entry here + one on the server and the capability is fully wired — the
// core renderer and chat view never change.
export interface ClientCapability {
  id: string; // matches the server capability id / marker id, e.g. "map"
  // The pillar this capability belongs to, mirrored from the server descriptor (which is
  // the source of truth) so the UI can group by pillar. Optional: the client entry is
  // matched to the server by id, so this only needs setting where UI grouping uses it.
  pillar?: Pillar;
  // Accessible name for the shared drawer shell (the animated <aside> is generic to any
  // capability, so it can't derive its own label). e.g. "Map".
  surfaceLabel?: string;
  // Inline chip rendered in place of the marker. `open()` raises this payload to the
  // surface drawer (ChatView wires it through CapabilityContext).
  Chip: FC<{ payload: string; open: () => void }>;
  // The drawer surface — the INNER content of the shared drawer shell (header/status + body).
  // Receives every payload whose chip has been opened (newest last), so it can accumulate
  // (e.g. multiple map pins). `width` is the shell's current drawer width (px), threaded in
  // so a surface can react to a resize (the map calls `resize()`). Optional: chip-only caps
  // omit it.
  Surface?: FC<{ requests: string[]; onClose: () => void; width?: number }>;
  // When a single message contains >=2 of this capability's markers, the message shows a
  // bulk action that opens all of them at once (e.g. a whole trip itinerary on the map).
  // Return the button label for `count` items, or omit to disable the bulk action.
  bulkActionLabel?: (count: number) => string;
}

import { lazy } from "react";
import type { ClientCapability } from "../../types";
import { MapChip } from "./MapChip";

// The chip is tiny and renders inline in every message, so it stays in the main bundle.
// The canvas drawer pulls in MapLibre + pmtiles + the Protomaps theme (~800KB+), so it's
// code-split — that chunk only loads when a map is actually opened.
const MapCanvas = lazy(() => import("./MapCanvas").then((m) => ({ default: m.MapCanvas })));

// Maps — client capability #1. Chip renders inline for [[map:…]]; the surface is the
// right-side canvas drawer that pins every opened place.
export const maps: ClientCapability = {
  id: "map",
  pillar: "assistant",
  surfaceLabel: "Map",
  Chip: MapChip,
  Surface: MapCanvas,
  bulkActionLabel: (n) => `Show all ${n} places on the map`,
};

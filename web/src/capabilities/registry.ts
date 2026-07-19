import { maps } from "./assistant/maps/index";
import { timer } from "./assistant/timer/index";
import type { ClientCapability } from "./types";

// Client capability registry — mirror of the server one. Add an entry and its marker
// renders a chip + opens its surface automatically.
export const clientCapabilities: ClientCapability[] = [maps, timer];

const byId = new Map(clientCapabilities.map((c) => [c.id, c]));

export function capabilityById(id: string): ClientCapability | undefined {
  return byId.get(id);
}

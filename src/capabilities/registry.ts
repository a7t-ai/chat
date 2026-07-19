import { maps } from "./assistant/maps/index.ts";
import { timer } from "./assistant/timer/index.ts";
import type { Capability } from "./types.ts";

// The capability registry. Add a capability here and it plugs itself into the system
// prompt (its marker instruction) and the API (its routes) — no core changes needed.
export const capabilities: Capability[] = [maps, timer];

export function enabledCapabilities(): Capability[] {
  return capabilities.filter((c) => c.enabled);
}

// Concatenated instruction fragments of all enabled capabilities, appended to the chat
// system prompt so the model knows which inline markers it may emit. Empty string when
// nothing contributes a fragment.
export function capabilitySystemPrompt(): string {
  const parts = enabledCapabilities()
    .map((c) => c.systemPrompt?.() ?? "")
    .filter((s) => s.trim().length > 0);
  return parts.join("\n");
}

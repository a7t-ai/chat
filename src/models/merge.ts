import type { ModelInfo } from "../jano/types.ts";
import { catalogEntry, defaultMeta } from "./catalog.ts";
import type { MergedModel } from "./types.ts";

// Join the STATIC catalog onto Jano's LIVE model list — the heart of #63. The rules:
//   - a live model WITH a catalog row    -> enriched with its metadata
//   - a live model WITHOUT a catalog row -> shown with conservative defaults (never hidden)
//   - a catalog row for a model Jano does NOT serve -> dropped (no dead options in the picker)
// So the catalog only ever ENRICHES; availability stays Jano's call. Jano's order is preserved
// (deterministic — the picker does its own sorting/filtering downstream), blank ids are skipped, and
// a repeated id is de-duped to the first occurrence. Every returned model came from the live list, so
// `available` is always true. `displayName` resolves catalog override -> Jano label -> id.
export function mergeCatalog(live: ModelInfo[]): MergedModel[] {
  const seen = new Set<string>();
  const out: MergedModel[] = [];
  for (const m of live) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const meta = catalogEntry(m.id) ?? defaultMeta();
    out.push({
      ...meta,
      id: m.id,
      displayName: meta.displayName ?? m.label ?? m.id,
      available: true,
    });
  }
  return out;
}

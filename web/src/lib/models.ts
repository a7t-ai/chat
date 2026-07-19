import type { AccountPlanId, CatalogModel } from "./api";

// The richer model picker (#17): search / filter / favorites / tier ($) badges / BYOK tags. This
// module is the PURE core — normalization, the $ badge map, localStorage-backed favorites, and the
// filter/search/sort — so the logic is unit-tested without a DOM (the picker component in ChatView
// just wires it to state). Nothing here does I/O beyond the favorites helpers.

// Per-device favorites, alongside the other `a7t_chat_*` view-state keys (sidebar width, minimap).
// Favorites are a UI convenience, not account state — kept local so they need no server round-trip.
export const MODEL_FAVORITES_KEY = "a7t_chat_model_favorites";

// The normalized row the picker renders: the model id + its display label + the catalog facets the
// picker surfaces. Derived from the plain allowed-model ids joined onto the enriched catalog map.
export interface PickerModel {
  id: string;
  label: string;
  tier: AccountPlanId;
  byokOnly: boolean;
  provider: string;
  recommendedFor: string[];
}

// The picker's filter modes. `favorites` narrows to starred; `free`/`premium` split on the tier so a
// paywalled model is easy to find (or avoid). `all` is the default resting state.
export type ModelFilter = "all" | "favorites" | "free" | "premium";

export const MODEL_FILTERS: readonly ModelFilter[] = ["all", "favorites", "free", "premium"] as const;

// Build the picker rows from the allowed-model ids + Jano labels + the enriched catalog map. A model
// with NO catalog row (freshly wired into Jano, #63) degrades to conservative defaults — free tier,
// not BYOK-only, local provider, no keywords — so it still shows, just without badges (mirrors the
// backend `defaultMeta`). The label resolves Jano label → catalog displayName → the id itself.
export function toPickerModels(
  ids: string[],
  labels: Record<string, string>,
  catalog: Record<string, CatalogModel>,
): PickerModel[] {
  return ids.map((id) => {
    const meta = catalog[id];
    return {
      id,
      label: labels[id] ?? meta?.displayName ?? id,
      tier: meta?.tier ?? "free",
      byokOnly: meta?.byokOnly ?? false,
      provider: meta?.provider ?? "local",
      recommendedFor: meta?.recommendedFor ?? [],
    };
  });
}

// The "$" tier badge: free shows nothing; each paid rung adds a `$` (plus `$`, pro `$$`, ultra `$$$`).
// A quick at-a-glance signal for how premium a model is, without a price the local catalog can't know.
export function tierBadge(tier: AccountPlanId): string {
  switch (tier) {
    case "plus":
      return "$";
    case "pro":
      return "$$";
    case "ultra":
      return "$$$";
    default:
      return "";
  }
}

// Read the favorites list from localStorage. Robust to a missing / corrupt / non-array / non-string
// blob — anything unexpected degrades to an empty list, never throws (favorites are best-effort UI).
export function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(MODEL_FAVORITES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

// Persist the favorites list. Best-effort — a private-mode / quota failure is swallowed (the in-memory
// picker state still reflects the toggle for this session; it just won't survive a reload).
export function saveFavorites(ids: string[]): void {
  try {
    localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    // ignore — favorites are a convenience, never fatal
  }
}

// Pure toggle: drop the id if present, append it if absent. Returns a NEW array (never mutates).
export function toggleFavorite(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

// Filter + search + sort the picker rows. Pure — the component owns the state, this owns the logic.
// The filter mode narrows first, then the (trimmed, case-insensitive) query matches label / id /
// provider / keywords. Favorites float to the top, preserving the incoming (Jano) order within each
// group — so the current ordering is never scrambled, just re-prioritized.
export function filterModels(
  models: PickerModel[],
  opts: { query: string; filter: ModelFilter; favorites: ReadonlySet<string> },
): PickerModel[] {
  const q = opts.query.trim().toLowerCase();
  const matched = models.filter((m) => {
    if (opts.filter === "favorites" && !opts.favorites.has(m.id)) return false;
    if (opts.filter === "free" && m.tier !== "free") return false;
    if (opts.filter === "premium" && m.tier === "free") return false;
    if (!q) return true;
    const hay = [m.label, m.id, m.provider, ...m.recommendedFor].join(" ").toLowerCase();
    return hay.includes(q);
  });
  // Stable partition: favorites first, each group keeping its relative order.
  const fav: PickerModel[] = [];
  const rest: PickerModel[] = [];
  for (const m of matched) (opts.favorites.has(m.id) ? fav : rest).push(m);
  return [...fav, ...rest];
}

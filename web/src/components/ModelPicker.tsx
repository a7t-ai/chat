import { Check, ChevronDown, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogModel } from "../lib/api";
import { useT } from "../lib/i18n";
import {
  filterModels,
  loadFavorites,
  MODEL_FILTERS,
  type ModelFilter,
  saveFavorites,
  tierBadge,
  toggleFavorite,
  toPickerModels,
} from "../lib/models";

// Inline model selector that lives in the composer toolbar: shows the active model and opens a
// richer panel (upward, since it sits at the foot of the screen) to switch it — search box, tier
// filters, per-model favorite stars, and $-tier / BYOK badges (#17). Mirrors the `/model` slash
// command — both write the same `model` state in ChatView. The heavy lifting (normalize / filter /
// favorites) lives in the pure `../lib/models` module; this component only wires it to state.
// Extracted from ChatView (#142) so the design-system gallery can render the real picker.
export function ModelPicker({
  model,
  models,
  labels,
  catalog,
  onSelect,
  disabled,
  openNonce,
  inline = false,
  initialFavorites,
}: {
  model: string;
  models: string[];
  labels: Record<string, string>;
  catalog: Record<string, CatalogModel>;
  onSelect: (m: string) => void;
  disabled: boolean;
  // Bumped by the global model-picker shortcut to toggle this open. A ref holds the live
  // `disabled` so the effect can depend on the nonce alone (re-enabling mustn't pop it open).
  openNonce: number;
  // Design-system showcase (#142): render the panel open and in normal document flow (no absolute
  // popover, no backdrop, no autofocus-scroll) so the gallery specimen shows the open state without
  // poking through the page, and keep favorites EPHEMERAL (seeded from `initialFavorites`, never
  // persisted to the shared per-device key). Off in the composer — behavior there is unchanged.
  inline?: boolean;
  initialFavorites?: string[];
}) {
  const t = useT();
  const [open, setOpen] = useState(inline);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [favorites, setFavorites] = useState<string[]>(() => (inline ? (initialFavorites ?? []) : loadFavorites()));
  const searchRef = useRef<HTMLInputElement>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    if (openNonce === 0) return; // skip the initial mount
    if (disabledRef.current) return; // no popping open mid-send
    setOpen((o) => !o);
  }, [openNonce]);
  // Each time the panel opens, start clean (empty query) and focus the search box. In the inline
  // showcase we skip the focus so opening the gallery doesn't steal focus / scroll the page.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (!inline) searchRef.current?.focus();
  }, [open]);
  const favSet = useMemo(() => new Set(favorites), [favorites]);
  const rows = useMemo(() => toPickerModels(models, labels, catalog), [models, labels, catalog]);
  const shown = useMemo(() => filterModels(rows, { query, filter, favorites: favSet }), [rows, query, filter, favSet]);
  const filterLabels: Record<ModelFilter, string> = {
    all: t("composer.modelFilterAll"),
    favorites: t("composer.modelFilterFavorites"),
    free: t("composer.modelFilterFree"),
    premium: t("composer.modelFilterPremium"),
  };
  if (models.length === 0) return null;
  const current = model || models[0];
  const label = (id: string) => labels[id] ?? catalog[id]?.displayName ?? id;
  const toggleFav = (id: string) => {
    setFavorites((f) => {
      const next = toggleFavorite(f, id);
      if (!inline) saveFavorites(next); // gallery favorites are ephemeral — never touch the shared key
      return next;
    });
  };
  return (
    <div className="model-picker">
      <button
        type="button"
        className="model-picker-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("composer.modelPicker")}
        aria-label={t("composer.modelPicker")}
      >
        <span className="model-picker-name">{label(current)}</span>
        <ChevronDown className="model-picker-caret" size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <>
          {!inline && <div className="menu-backdrop" onClick={() => setOpen(false)} />}
          <div className={`model-pop model-pop-rich${inline ? " model-pop-inline" : ""}`}>
            <input
              ref={searchRef}
              type="text"
              className="model-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("composer.modelSearchPlaceholder")}
              aria-label={t("composer.modelSearch")}
            />
            <div className="model-filters" role="group" aria-label={t("composer.modelFilter")}>
              {MODEL_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`model-filter ${filter === f ? "active" : ""}`}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {filterLabels[f]}
                </button>
              ))}
            </div>
            <div className="model-list" role="listbox" aria-label={t("composer.modelPicker")}>
              {shown.length === 0 ? (
                <div className="model-empty muted small">{t("composer.modelNoResults")}</div>
              ) : (
                shown.map((m) => {
                  const badge = tierBadge(m.tier);
                  const fav = favSet.has(m.id);
                  return (
                    <div key={m.id} className={`model-option ${m.id === current ? "active" : ""}`}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={m.id === current}
                        className="model-option-main"
                        onClick={() => {
                          onSelect(m.id);
                          if (!inline) setOpen(false); // gallery keeps the panel open after a pick
                        }}
                      >
                        {/* Leading check, beside the NAME (#144). Always in the DOM (a fixed-width
                            reserved slot) so unselected rows' names stay aligned and the right-side
                            badges never shift; only its opacity/scale toggles on `.active`, which lets
                            the selection fade/scale between rows instead of hard-jumping. */}
                        <span className="model-option-lead" aria-hidden="true">
                          <Check className="model-option-check" size={16} strokeWidth={1.75} />
                        </span>
                        <span className="model-option-name">{m.label}</span>
                        <span className="model-option-tags">
                          {badge && (
                            <span className="model-badge" title={t("composer.modelTier", { tier: m.tier })}>
                              {badge}
                            </span>
                          )}
                          {m.byokOnly && (
                            <span className="model-byok" title={t("composer.modelByokHint")}>
                              {t("composer.modelByok")}
                            </span>
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`model-fav ${fav ? "on" : ""}`}
                        aria-pressed={fav}
                        aria-label={fav ? t("composer.modelUnfavorite", { model: m.label }) : t("composer.modelFavorite", { model: m.label })}
                        title={fav ? t("composer.modelUnfavorite", { model: m.label }) : t("composer.modelFavorite", { model: m.label })}
                        onClick={() => toggleFav(m.id)}
                      >
                        <Star size={15} strokeWidth={1.75} fill={fav ? "currentColor" : "none"} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

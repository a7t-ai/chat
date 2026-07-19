import { beforeEach, describe, expect, test } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import type { CatalogModel } from "./api";
import {
  filterModels,
  loadFavorites,
  MODEL_FAVORITES_KEY,
  type PickerModel,
  saveFavorites,
  tierBadge,
  toggleFavorite,
  toPickerModels,
} from "./models";

function cat(over: Partial<CatalogModel> & Pick<CatalogModel, "id">): CatalogModel {
  return {
    displayName: over.id,
    input: ["text"],
    tier: "free",
    byokOnly: false,
    provider: "local",
    recommendedFor: [],
    ...over,
  };
}

function pm(over: Partial<PickerModel> & Pick<PickerModel, "id">): PickerModel {
  return {
    label: over.id,
    tier: "free",
    byokOnly: false,
    provider: "local",
    recommendedFor: [],
    ...over,
  };
}

describe("tierBadge", () => {
  test("free shows nothing, paid rungs escalate", () => {
    expect(tierBadge("free")).toBe("");
    expect(tierBadge("plus")).toBe("$");
    expect(tierBadge("pro")).toBe("$$");
    expect(tierBadge("ultra")).toBe("$$$");
  });
});

describe("toPickerModels", () => {
  const catalog = {
    qwen: cat({ id: "qwen", displayName: "Qwen 3", tier: "free", provider: "qwen", recommendedFor: ["coding"] }),
    gpt: cat({ id: "gpt", displayName: "GPT", tier: "pro", byokOnly: true, provider: "openai" }),
  };

  test("joins ids onto the catalog, Jano label winning over displayName", () => {
    const rows = toPickerModels(["qwen", "gpt"], { qwen: "Qwen (label)" }, catalog);
    expect(rows[0]).toMatchObject({ id: "qwen", label: "Qwen (label)", tier: "free", provider: "qwen" });
    // No Jano label for gpt → falls back to the catalog displayName.
    expect(rows[1]).toMatchObject({ id: "gpt", label: "GPT", tier: "pro", byokOnly: true, provider: "openai" });
  });

  test("a model with no catalog row degrades to conservative defaults", () => {
    const rows = toPickerModels(["mystery"], {}, catalog);
    expect(rows[0]).toEqual({
      id: "mystery",
      label: "mystery",
      tier: "free",
      byokOnly: false,
      provider: "local",
      recommendedFor: [],
    });
  });

  test("preserves the incoming id order", () => {
    const rows = toPickerModels(["gpt", "qwen"], {}, catalog);
    expect(rows.map((r) => r.id)).toEqual(["gpt", "qwen"]);
  });
});

describe("favorites storage", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  test("round-trips through localStorage", () => {
    expect(loadFavorites()).toEqual([]);
    saveFavorites(["a", "b"]);
    expect(loadFavorites()).toEqual(["a", "b"]);
    expect(localStorage.getItem(MODEL_FAVORITES_KEY)).toBe(JSON.stringify(["a", "b"]));
  });

  test("degrades a corrupt / non-array / mixed blob to an empty or filtered list", () => {
    localStorage.setItem(MODEL_FAVORITES_KEY, "not json{");
    expect(loadFavorites()).toEqual([]);
    localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify({ not: "an array" }));
    expect(loadFavorites()).toEqual([]);
    localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(["ok", 42, null, "fine"]));
    expect(loadFavorites()).toEqual(["ok", "fine"]);
  });

  test("toggleFavorite adds when absent and removes when present, without mutating", () => {
    const start = ["a"];
    const added = toggleFavorite(start, "b");
    expect(added).toEqual(["a", "b"]);
    expect(start).toEqual(["a"]); // unchanged
    expect(toggleFavorite(added, "a")).toEqual(["b"]);
  });

  test("saveFavorites never throws when storage rejects", () => {
    const ls = installLocalStorage();
    ls.setItem = () => {
      throw new Error("quota");
    };
    expect(() => saveFavorites(["x"])).not.toThrow();
  });
});

describe("filterModels", () => {
  const models = [
    pm({ id: "qwen", label: "Qwen 3", tier: "free", provider: "qwen", recommendedFor: ["coding"] }),
    pm({ id: "gpt", label: "GPT-5", tier: "pro", provider: "openai" }),
    pm({ id: "claude", label: "Claude", tier: "ultra", provider: "anthropic", recommendedFor: ["vision"] }),
  ];
  const none = new Set<string>();

  test("all + empty query returns every model in order", () => {
    const out = filterModels(models, { query: "", filter: "all", favorites: none });
    expect(out.map((m) => m.id)).toEqual(["qwen", "gpt", "claude"]);
  });

  test("free / premium split on the tier", () => {
    expect(filterModels(models, { query: "", filter: "free", favorites: none }).map((m) => m.id)).toEqual(["qwen"]);
    expect(filterModels(models, { query: "", filter: "premium", favorites: none }).map((m) => m.id)).toEqual([
      "gpt",
      "claude",
    ]);
  });

  test("favorites filter narrows to the starred set and floats them to the top otherwise", () => {
    const fav = new Set(["claude"]);
    expect(filterModels(models, { query: "", filter: "favorites", favorites: fav }).map((m) => m.id)).toEqual([
      "claude",
    ]);
    // Under `all`, the favorite is pinned first while the rest keep their order.
    expect(filterModels(models, { query: "", filter: "all", favorites: fav }).map((m) => m.id)).toEqual([
      "claude",
      "qwen",
      "gpt",
    ]);
  });

  test("query matches label / id / provider / keywords, case-insensitively", () => {
    expect(filterModels(models, { query: "gpt", filter: "all", favorites: none }).map((m) => m.id)).toEqual(["gpt"]);
    expect(filterModels(models, { query: "OPENAI", filter: "all", favorites: none }).map((m) => m.id)).toEqual(["gpt"]);
    expect(filterModels(models, { query: "vision", filter: "all", favorites: none }).map((m) => m.id)).toEqual([
      "claude",
    ]);
    // A stray-whitespace query is trimmed before matching.
    expect(filterModels(models, { query: "  coding  ", filter: "all", favorites: none }).map((m) => m.id)).toEqual([
      "qwen",
    ]);
  });

  test("filter and query compose (premium + query)", () => {
    expect(filterModels(models, { query: "claude", filter: "premium", favorites: none }).map((m) => m.id)).toEqual([
      "claude",
    ]);
    // The free model is excluded by the tier filter even though it would match the query.
    expect(filterModels(models, { query: "qwen", filter: "premium", favorites: none })).toEqual([]);
  });
});

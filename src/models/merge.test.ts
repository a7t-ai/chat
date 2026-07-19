import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../jano/types.ts";
import { mergeCatalog } from "./merge.ts";

describe("mergeCatalog", () => {
  test("ENRICHES a live model that has a catalog row", () => {
    const m = mergeCatalog([{ id: "qwen-chat", label: "Qwen3.6 35B" }])[0]!;
    expect(m.id).toBe("qwen-chat");
    expect(m.provider).toBe("qwen");
    expect(m.available).toBe(true);
    expect(m.input).toContain("text");
    expect(m.cost).toEqual({ local: true });
    // No catalog displayName override -> the Jano label flows through.
    expect(m.displayName).toBe("Qwen3.6 35B");
  });

  test("DEFAULTS a live model with no catalog row (shown, never hidden)", () => {
    const m = mergeCatalog([{ id: "brand-new-model", label: "Brand New" }])[0]!;
    expect(m.id).toBe("brand-new-model");
    expect(m.available).toBe(true);
    expect(m.displayName).toBe("Brand New");
    // Conservative defaults from defaultMeta.
    expect(m.cost).toEqual({ local: true });
    expect(m.input).toEqual(["text"]);
    expect(m.tier).toBe("free");
    expect(m.provider).toBe("local");
  });

  test("HIDES catalog entries for models Jano does not serve (no dead options)", () => {
    // The catalog knows qwen-chat/qwen-code/qwen-omni/whisper, but only qwen-code is live here.
    const out = mergeCatalog([{ id: "qwen-code", label: "Qwen3 Coder 30B" }]);
    expect(out.map((m) => m.id)).toEqual(["qwen-code"]);
    // An empty live list yields nothing (the catalog never adds a model on its own).
    expect(mergeCatalog([])).toEqual([]);
  });

  test("displayName falls back to the id when Jano sends no label", () => {
    const m = mergeCatalog([{ id: "unlabeled" }])[0]!;
    expect(m.displayName).toBe("unlabeled");
  });

  test("preserves Jano's order", () => {
    const live: ModelInfo[] = [{ id: "qwen-omni" }, { id: "qwen-chat" }, { id: "qwen-code" }];
    expect(mergeCatalog(live).map((m) => m.id)).toEqual(["qwen-omni", "qwen-chat", "qwen-code"]);
  });

  test("de-dupes a repeated id (first wins) and skips blank ids", () => {
    const live: ModelInfo[] = [
      { id: "qwen-chat", label: "First" },
      { id: "qwen-chat", label: "Dup" },
      { id: "" },
    ];
    const out = mergeCatalog(live);
    expect(out).toHaveLength(1);
    expect(out[0]!.displayName).toBe("First");
  });

  test("every returned model is available (came from the live list)", () => {
    const out = mergeCatalog([{ id: "qwen-chat" }, { id: "whatever" }]);
    expect(out.every((m) => m.available === true)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { fetchHfCatalog, hfModelToSetup, isTrustedRepo, pickGgufAsset, type HfTreeFile } from "./hf.ts";

describe("setup/hf — isTrustedRepo", () => {
  test("accepts a trusted publisher with a clean tag set", () => {
    expect(isTrustedRepo({ id: "unsloth/Qwen3.5-9B-GGUF", tags: ["gguf", "text-generation"] })).toBe(true);
    expect(isTrustedRepo({ id: "bartowski/Llama-3.3-70B-Instruct-GGUF" })).toBe(true);
  });
  test("rejects an untrusted publisher", () => {
    expect(isTrustedRepo({ id: "DavidAU/Qwen3.6-27B-Fable-Fusion-GGUF" })).toBe(false);
    expect(isTrustedRepo({ id: "HauhauCS/Qwen3.6-35B-A3B-Uncensored" })).toBe(false);
  });
  test("rejects a denied tag even from a trusted org", () => {
    expect(isTrustedRepo({ id: "unsloth/Some-Model-GGUF", tags: ["gguf", "uncensored"] })).toBe(false);
    expect(isTrustedRepo({ id: "unsloth/Some-Model-GGUF", tags: ["gguf", "roleplay"] })).toBe(false);
  });
  test("rejects a non-chat model (embeddings / rerankers / speech)", () => {
    expect(isTrustedRepo({ id: "ggml-org/whisper-large-v3-GGUF" })).toBe(false);
    expect(isTrustedRepo({ id: "bartowski/bge-reranker-v2-GGUF" })).toBe(false);
  });
});

describe("setup/hf — pickGgufAsset", () => {
  const files: HfTreeFile[] = [
    { path: "Qwen3.5-9B-BF16.gguf", size: 17.9e9 },
    { path: "Qwen3.5-9B-Q4_K_M.gguf", size: 5.68e9 },
    { path: "Qwen3.5-9B-Q3_K_M.gguf", size: 4.67e9 },
  ];
  test("prefers Q4_K_M and rounds the size to one decimal GB", () => {
    expect(pickGgufAsset(files)).toEqual({ ggufFile: "Qwen3.5-9B-Q4_K_M.gguf", sizeGB: 5.7, quant: "Q4_K_M" });
  });
  test("walks the ladder when the preferred quant is absent", () => {
    expect(pickGgufAsset([{ path: "M-Q3_K_M.gguf", size: 4e9 }])?.quant).toBe("Q3_K_M");
  });
  test("skips multi-part splits, zero-size files, and non-gguf; returns null when nothing fits", () => {
    expect(pickGgufAsset([{ path: "M-Q4_K_M-00001-of-00002.gguf", size: 20e9 }])).toBeNull();
    expect(pickGgufAsset([{ path: "M-Q4_K_M.gguf", size: 0 }])).toBeNull();
    expect(pickGgufAsset([{ path: "readme.md", size: 10 }])).toBeNull();
  });
});

describe("setup/hf — hfModelToSetup", () => {
  test("maps a listing + asset to a SetupModel with the budget heuristic", () => {
    const m = hfModelToSetup(
      { id: "unsloth/Qwen3.5-9B-GGUF" },
      { ggufFile: "Qwen3.5-9B-Q4_K_M.gguf", sizeGB: 5.7, quant: "Q4_K_M" },
    );
    expect(m).toEqual({
      id: "qwen3.5-9b",
      label: "Qwen3.5 9B",
      hfRepo: "unsloth/Qwen3.5-9B-GGUF",
      ggufFile: "Qwen3.5-9B-Q4_K_M.gguf",
      quant: "Q4_K_M",
      sizeGB: 5.7,
      minBudgetGB: 10, // ceil(5.7 / 0.6)
    });
  });
});

describe("setup/hf — fetchHfCatalog", () => {
  const listing = JSON.stringify([
    { id: "unsloth/Qwen3.5-9B-GGUF", downloads: 1000, tags: ["gguf"] },
    { id: "DavidAU/junk-uncensored-GGUF", downloads: 999, tags: ["gguf", "uncensored"] }, // filtered out
  ]);
  const tree = JSON.stringify([{ path: "Qwen3.5-9B-Q4_K_M.gguf", size: 5.68e9 }]);
  const ok = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

  test("maps trusted listings with resolved assets and drops the rest", async () => {
    const fetchImpl = (async (url: string) => (url.includes("/tree/") ? ok(tree) : ok(listing))) as unknown as typeof fetch;
    const models = await fetchHfCatalog(fetchImpl);
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("qwen3.5-9b");
    expect(models[0]!.ggufFile).toBe("Qwen3.5-9B-Q4_K_M.gguf");
  });

  test("returns [] on a non-ok models response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await fetchHfCatalog(fetchImpl)).toEqual([]);
  });

  test("returns [] when fetch throws (offline)", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchHfCatalog(fetchImpl)).toEqual([]);
  });

  test("drops a candidate whose tree has no usable GGUF", async () => {
    const fetchImpl = (async (url: string) =>
      url.includes("/tree/") ? ok(JSON.stringify([{ path: "readme.md", size: 5 }])) : ok(listing)) as unknown as typeof fetch;
    expect(await fetchHfCatalog(fetchImpl)).toEqual([]);
  });
});

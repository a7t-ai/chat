// The setup wizard's model catalog — DEPLOYMENT facts (where to download a GGUF, how big it is, how
// much memory it needs), deliberately separate from src/models/catalog.ts (which is PRODUCT/UI
// metadata: modalities, cost, tier, trust). The two are decoupled on purpose: the app learns what's
// AVAILABLE from Jano's /v1/models; this table only exists so `bun run setup` can recommend and fetch
// a model that fits the machine. Keep the `id`s aligned with the product catalog keys where they
// overlap (e.g. "qwen-omni") so a downloaded model lines up with an existing UI row and DEFAULT_MODEL.
//
// The wizard starts llama-server with `--alias <id>`, so the id below is exactly what the endpoint
// reports at /v1/models and what DEFAULT_MODEL is set to.

export interface SetupModel {
  /** Stable id; becomes the llama-server alias and DEFAULT_MODEL. Aligned with product-catalog keys where they overlap. */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  /** Hugging Face repo that hosts the GGUF, e.g. "bartowski/Qwen2.5-7B-Instruct-GGUF". */
  hfRepo: string;
  /** The GGUF file within the repo to download. */
  ggufFile: string;
  /** Quantization, for display ("Q4_K_M"). */
  quant: string;
  /** Approximate weights size on disk, in GB (the download). */
  sizeGB: number;
  /** Minimum memory budget (unified RAM, or VRAM on a discrete GPU) this model is sensible on, in GB. */
  minBudgetGB: number;
}

// The OFFLINE FALLBACK catalog: used only when the live Hugging Face query (src/setup/hf.ts) is
// unreachable or returns nothing usable, so the wizard never dead-ends. Kept small, current, and
// Q4_K_M throughout for the best size/quality trade-off; recommend() ranks by best-fit at runtime.
// Refresh this when it drifts — the live query is what keeps recommendations fresh day to day; each
// hfRepo/ggufFile here is verified to resolve (the wizard also checks the HF API before downloading).
export const SETUP_CATALOG: SetupModel[] = [
  {
    id: "qwen3.5-4b",
    label: "Qwen3.5 4B",
    hfRepo: "unsloth/Qwen3.5-4B-GGUF",
    ggufFile: "Qwen3.5-4B-Q4_K_M.gguf",
    quant: "Q4_K_M",
    sizeGB: 2.7,
    minBudgetGB: 8,
  },
  {
    id: "qwen3.5-9b",
    label: "Qwen3.5 9B",
    hfRepo: "unsloth/Qwen3.5-9B-GGUF",
    ggufFile: "Qwen3.5-9B-Q4_K_M.gguf",
    quant: "Q4_K_M",
    sizeGB: 5.7,
    minBudgetGB: 12,
  },
  {
    id: "qwen-omni",
    label: "Qwen3-Omni 30B (text + image + audio + video)",
    hfRepo: "ggml-org/Qwen3-Omni-30B-A3B-Instruct-GGUF",
    ggufFile: "Qwen3-Omni-30B-A3B-Instruct-Q4_K_M.gguf",
    quant: "Q4_K_M",
    sizeGB: 18.6,
    minBudgetGB: 28,
  },
  {
    id: "qwen3-coder-30b",
    label: "Qwen3-Coder 30B (A3B)",
    hfRepo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    ggufFile: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
    quant: "Q4_K_M",
    sizeGB: 18.6,
    minBudgetGB: 28,
  },
  {
    id: "qwen3.6-35b-a3b",
    label: "Qwen3.6 35B (A3B)",
    hfRepo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    ggufFile: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    quant: "Q4_K_M",
    sizeGB: 22.1,
    minBudgetGB: 32,
  },
  {
    id: "llama3.3-70b",
    label: "Llama 3.3 70B Instruct",
    hfRepo: "bartowski/Llama-3.3-70B-Instruct-GGUF",
    ggufFile: "Llama-3.3-70B-Instruct-Q4_K_M.gguf",
    quant: "Q4_K_M",
    sizeGB: 43,
    minBudgetGB: 64,
  },
];

/** Look up a catalog entry by id (used by the `--model <id>` non-interactive path). Searches the
 *  given catalog (the live one when present) then falls back to the offline SETUP_CATALOG. */
export function setupModelById(id: string, catalog: SetupModel[] = SETUP_CATALOG): SetupModel | undefined {
  return catalog.find((m) => m.id === id) ?? SETUP_CATALOG.find((m) => m.id === id);
}

/** The Hugging Face resolve URL for a model's GGUF (the direct download link). */
export function hfResolveUrl(m: SetupModel): string {
  return `https://huggingface.co/${m.hfRepo}/resolve/main/${m.ggufFile}`;
}

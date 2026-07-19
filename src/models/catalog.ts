import type { ModelMeta } from "./types.ts";

// The static, hand-maintained model catalog (#63), keyed by Jano model `id`. This does NOT decide
// what's available — Jano's /v1/models does; this only ENRICHES what Jano serves (see mergeCatalog).
// Seeded for the models Jano serves today (the local MLX/llama.cpp set behind the router). Add a row
// when a new model is wired into Jano. Keep the numbers HONEST — the usage meter (#59) shows cost and
// the attachment picker (#15/#74) reads `input`; a wrong value here misleads the UI. `displayName` is
// deliberately left unset so the name flows from Jano's `label` (CLAUDE.md convention); context/output
// windows are the served-window estimates for our deployment, not the model's theoretical maximum.
export const MODEL_CATALOG: Record<string, ModelMeta> = {
  // General-purpose local chat model — the free-tier default (config.defaultModel).
  "qwen-chat": {
    provider: "qwen",
    input: ["text"],
    output: ["text"],
    hosting: "local",
    openWeights: true,
    trainsOnData: false,
    features: { reasoning: "medium", toolUse: true, webSearch: false, structuredOutput: true },
    cost: { local: true },
    contextTokens: 32768,
    maxOutputTokens: 8192,
    speed: "medium",
    tier: "free",
    status: "stable",
    byokOnly: false,
    recommendedFor: ["general", "long-docs"],
  },
  // Coding-tuned local model.
  "qwen-code": {
    provider: "qwen",
    input: ["text"],
    output: ["text"],
    hosting: "local",
    openWeights: true,
    trainsOnData: false,
    features: { reasoning: "low", toolUse: true, webSearch: false, structuredOutput: true },
    cost: { local: true },
    contextTokens: 32768,
    maxOutputTokens: 8192,
    speed: "medium",
    tier: "free",
    status: "stable",
    byokOnly: false,
    recommendedFor: ["coding"],
  },
  // Multimodal-IN local model: text + image + audio + video in, text out. This is the model that
  // makes the #15/#74 attachment picker light up for images — `input` includes "image".
  "qwen-omni": {
    provider: "qwen",
    input: ["text", "image", "audio", "video"],
    output: ["text"],
    hosting: "local",
    openWeights: true,
    trainsOnData: false,
    features: { reasoning: "low", toolUse: false, webSearch: false, structuredOutput: false },
    cost: { local: true },
    contextTokens: 32768,
    maxOutputTokens: 8192,
    speed: "medium",
    tier: "free",
    status: "beta",
    byokOnly: false,
    recommendedFor: ["vision", "audio", "multimodal"],
  },
  // Speech-to-text. Audio IN, text OUT — NO text input, so a chat picker that filters for a text
  // prompt naturally excludes it (the modality data does the work; no special "isChat" flag needed).
  whisper: {
    provider: "openai",
    input: ["audio"],
    output: ["text"],
    hosting: "local",
    openWeights: true,
    trainsOnData: false,
    features: { reasoning: "none", toolUse: false, webSearch: false, structuredOutput: false },
    cost: { local: true },
    speed: "fast",
    tier: "free",
    status: "stable",
    byokOnly: false,
    recommendedFor: ["transcription"],
  },
};

// The static metadata for a model id, or undefined when the catalog has no row for it.
export function catalogEntry(id: string): ModelMeta | undefined {
  return MODEL_CATALOG[id];
}

// Conservative defaults for a Jano model we don't have a catalog row for yet — so a newly-wired
// model is SHOWN (never hidden) while its metadata is still being filled in. Jano only serves LOCAL
// models, so an uncataloged one is by definition local/free; we stay conservative about everything we
// can't know (text-only modalities, no premium features, no advertised window, not open-weights). A
// FRESH object each call — the caller may keep or serialize it without mutating a shared default.
export function defaultMeta(): ModelMeta {
  return {
    provider: "local",
    input: ["text"],
    output: ["text"],
    hosting: "local",
    openWeights: false,
    trainsOnData: false,
    features: { reasoning: "none", toolUse: false, webSearch: false, structuredOutput: false },
    cost: { local: true },
    speed: "medium",
    tier: "free",
    status: "stable",
    byokOnly: false,
    recommendedFor: [],
  };
}

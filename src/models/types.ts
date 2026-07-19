import type { AccountPlanId } from "../entitlements/plans.ts";

// The model capability catalog (#63) — static, typed metadata joined onto Jano's LIVE model list.
// Jano stays the source of truth for what's AVAILABLE (/v1/models); this only ENRICHES what Jano
// serves (cost, modalities, trust, tier), keyed by the same model `id`. The picker (#17), tier
// gating (#13), the attachment picker (#15/#74) and the usage meter (#59) all read this shape.

// A model's IN and OUT modalities. `input` drives the attachment picker (can I drop an image on
// THIS model?); `output` is what it can produce. Split because a model's IN and OUT differ (a VLM
// takes images but only writes text; Whisper takes audio and writes text).
export type Modality = "text" | "image" | "audio" | "video" | "document";

// Thinking / reasoning effort the model supports (none = no chain-of-thought).
export type ReasoningEffort = "none" | "low" | "medium" | "high";

// Product speed bucket (t3 playbook: surface speed so the picker can sort for it).
export type ModelSpeed = "fast" | "medium" | "slow";

// Curation status — `beta` warns it's newer/less battle-tested; `deprecated` hides-by-default later.
export type ModelStatus = "stable" | "beta" | "deprecated";

// Where the model runs. `local` = on our own box (never leaves), the privacy floor.
export type ModelHosting = "local" | "eu" | "us" | "unknown";

// The plan rung a model is gated behind. Reuses the #13 ladder ids (`entitlements/plans.ts`) so the
// catalog's `tier` and the account plan enum can never drift apart — add a rung there, it flows here.
export type ModelTier = AccountPlanId;

// Add-on capabilities beyond plain text generation (extensible). `webSearch` is whether the MODEL
// itself can search — distinct from the app's Research capability, which augments ANY model.
export interface ModelFeatures {
  reasoning: ReasoningEffort;
  toolUse: boolean;
  webSearch: boolean;
  structuredOutput: boolean;
}

// Per-token price, split IN vs OUT (they differ 3-5x). Local models are free — the `{ local: true }`
// arm carries no numbers, so the usage meter (#59) renders "free" instead of a bogus $0 estimate.
export type ModelCost =
  | { local: true }
  | {
      local?: false;
      inputPer1M: number;
      outputPer1M: number;
      cachedInputPer1M?: number;
      currency: string;
    };

// Static, hand-maintained metadata for ONE model, keyed by its Jano `id` in the catalog (so the id
// lives in exactly one place — the map key — never duplicated in the value). `displayName` is an
// OPTIONAL override; by convention it's left unset so the name flows from Jano's `label` (CLAUDE.md:
// display names come from Jano, not a local map). Unknown numeric limits are OMITTED, not faked to 0.
export interface ModelMeta {
  displayName?: string; // override; defaults to Jano label, then the id
  provider: string; // anthropic | openai | qwen | mistral | local | ...
  input: Modality[];
  output: Modality[];
  hosting: ModelHosting;
  openWeights: boolean; // open (Qwen/Llama/Whisper) vs proprietary
  trainsOnData: boolean; // does the provider retain/train on inputs (local = false)
  features: ModelFeatures;
  cost: ModelCost;
  contextTokens?: number; // max input window (omitted when unknown)
  maxOutputTokens?: number; // omitted when unknown
  knowledgeCutoff?: string; // ISO-ish date, when known
  speed: ModelSpeed;
  tier: ModelTier; // plan rung this model sits behind
  status: ModelStatus;
  byokOnly: boolean; // only reachable via the user's own key (never on the shared box)
  recommendedFor: string[]; // coding | vision | long-docs | cheap-bulk | transcription ...
  icon?: string; // visual identity key for the picker
}

// The runtime-merged shape the endpoint returns: static meta + the resolved `id` and `displayName`
// + `available: true`. Every returned model IS served by Jano — the merge drops catalog-only ids, so
// `available` is always true (kept explicit so the picker never has to special-case its presence).
export interface MergedModel extends ModelMeta {
  id: string;
  displayName: string;
  available: true;
}

// Live model recommendations from Hugging Face for `bun run setup`. The static SETUP_CATALOG is only
// the OFFLINE FALLBACK (see catalog.ts); this is what keeps recommendations current without a code
// edit. The pure functions here (trust filter, GGUF asset picker, listing->SetupModel mapper) are
// unit-tested against fixtures; fetchHfCatalog() is the thin I/O that stitches them together and
// falls back to [] on any failure, so a network hiccup never breaks the wizard.

import type { SetupModel } from "./catalog.ts";

// Only recommend GGUFs from publishers that ship clean, well-quantized instruct weights. A raw GGUF
// search is dominated by uncensored/roleplay/merge repos; this allowlist keeps the wizard tasteful.
export const TRUSTED_HF_ORGS = ["unsloth", "bartowski", "ggml-org", "qwen", "google", "meta-llama", "mistralai", "microsoft"];

// Tags that mark a repo as off-brand for a general assistant — never recommend these.
export const DENY_TAGS = ["uncensored", "abliterated", "heretic", "nsfw", "erotica", "roleplay", "roleplaying"];

// Substrings in a repo id that mark a non-chat model (embeddings, rerankers, speech) — excluded so a
// GGUF-of-everything search never recommends something you can't chat with.
const NON_CHAT_HINTS = ["whisper", "embed", "rerank", "-bge-", "e5-", "gte-", "reranker", "clip", "vae"];

// Prefer this quant, then walk down a small ladder if the repo doesn't ship it.
const QUANT_LADDER = ["Q4_K_M", "Q4_K_S", "Q4_0", "Q5_K_M", "Q3_K_M"];

export interface HfListing {
  id: string;
  downloads?: number;
  tags?: string[];
}

export interface HfTreeFile {
  path: string;
  size?: number;
}

export interface GgufAsset {
  ggufFile: string;
  sizeGB: number;
  quant: string;
}

// A repo is a candidate only if its org is trusted, it carries no denied tag, and its id doesn't look
// like a non-chat model. Pure — takes a parsed listing entry.
export function isTrustedRepo(l: HfListing): boolean {
  const id = l.id.toLowerCase();
  const org = id.split("/")[0] ?? "";
  if (!TRUSTED_HF_ORGS.includes(org)) return false;
  if (NON_CHAT_HINTS.some((h) => id.includes(h))) return false;
  const tags = (l.tags ?? []).map((t) => t.toLowerCase());
  return !DENY_TAGS.some((d) => tags.includes(d));
}

// From a repo's file tree, pick the single-file GGUF matching the preferred quant (default Q4_K_M),
// walking a small fallback ladder. Skips multi-part splits (…-00001-of-0000N.gguf — the wizard's
// single-file download can't handle those) and any file with no known size. Pure.
export function pickGgufAsset(files: HfTreeFile[], prefer = "Q4_K_M"): GgufAsset | null {
  const ggufs = files.filter((f) => /\.gguf$/i.test(f.path) && !/-\d{5}-of-\d{5}/i.test(f.path) && (f.size ?? 0) > 0);
  const ladder = prefer === QUANT_LADDER[0] ? QUANT_LADDER : [prefer, ...QUANT_LADDER];
  for (const q of ladder) {
    const hit = ggufs.find((f) => f.path.toLowerCase().includes(q.toLowerCase()));
    if (hit) return { ggufFile: hit.path, sizeGB: Math.round((hit.size! / 1e9) * 10) / 10, quant: q };
  }
  return null;
}

// Build a SetupModel from a listing + its picked asset. The id is the repo name lowercased with the
// GGUF suffix stripped (it becomes the llama-server --alias and DEFAULT_MODEL); minBudgetGB is a
// heuristic — the weights should sit at ~60% of the memory budget, so budget >= size / 0.6. Pure.
export function hfModelToSetup(l: HfListing, asset: GgufAsset): SetupModel {
  const repoName = l.id.split("/")[1] ?? l.id;
  const base = repoName.replace(/-GGUF$/i, "");
  return {
    id: base.toLowerCase(),
    label: base.replace(/-/g, " "),
    hfRepo: l.id,
    ggufFile: asset.ggufFile,
    quant: asset.quant,
    sizeGB: asset.sizeGB,
    minBudgetGB: Math.max(8, Math.ceil(asset.sizeGB / 0.6)),
  };
}

const HF_MODELS_URL = "https://huggingface.co/api/models?filter=gguf&sort=downloads&limit=60";
const hfTreeUrl = (repo: string) => `https://huggingface.co/api/models/${repo}/tree/main`;

// Query Hugging Face for current, trusted GGUF chat models and map them to SetupModel candidates. The
// top trusted repos by downloads are resolved to a concrete Q4_K_M asset (one tree fetch each, run in
// parallel). Returns [] on ANY failure (offline, rate-limited, bad JSON) so the caller falls back to
// the offline catalog — the wizard never dead-ends on the network. `fetchImpl` is injectable for tests.
export async function fetchHfCatalog(fetchImpl: typeof fetch = fetch, take = 8): Promise<SetupModel[]> {
  try {
    const res = await fetchImpl(HF_MODELS_URL);
    if (!res.ok) return [];
    const listings = (await res.json()) as HfListing[];
    if (!Array.isArray(listings)) return [];
    const candidates = listings.filter(isTrustedRepo).slice(0, take);
    const resolved = await Promise.all(
      candidates.map(async (l): Promise<SetupModel | null> => {
        try {
          const tree = await fetchImpl(hfTreeUrl(l.id));
          if (!tree.ok) return null;
          const files = (await tree.json()) as HfTreeFile[];
          if (!Array.isArray(files)) return null;
          const asset = pickGgufAsset(files);
          return asset ? hfModelToSetup(l, asset) : null;
        } catch {
          return null;
        }
      }),
    );
    return resolved.filter((m): m is SetupModel => m !== null);
  } catch {
    return [];
  }
}

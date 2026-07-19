import type { AuthContext } from "../auth/middleware.ts";
import { can } from "../entitlements/index.ts";
import { defaultMeta } from "../models/catalog.ts";
import type { MergedModel, ModelMeta } from "../models/types.ts";
import { frontierBackendFor } from "./backend.ts";
import { providerInfo } from "./providers.ts";
import { configuredProviders, getDecryptedProviderKey } from "./service.ts";

// BYOK models in the picker (#185). Once a caller stores a frontier key (#14/#178), that provider's
// models must SHOW in the picker so the key is usable via the UI — otherwise there's no way to pick
// e.g. `openai/gpt-4o`. This is the ONE seam both model endpoints (GET /api/models and GET
// /api/models/catalog) call to fold the caller's OWN configured-provider models into the response,
// alongside Jano's local list. It reuses the byok backend (`frontierBackendFor(...).listModels()`)
// to fetch each provider's `/models` on the caller's own key, prefixes every id with `provider/`
// (the same shape resolveTurnBackend routes on), and marks each `byokOnly` so the ModelPicker
// renders its BYOK badge. Strictly per-caller: only the caller's stored providers, only model
// ids/labels in the result — never key material.

// A provider's `/models` round-trip costs real latency (one per configured key), so cache the
// enriched result per-caller for a short window. Scoped by userId; a fresh key or a rotation is
// picked up within the TTL. Small enough that a stale entry is never a correctness problem — a
// dropped-away key still fails closed at spend time (resolveTurnBackend re-checks).
const CACHE_TTL_MS = 60_000;
interface CacheEntry {
  at: number;
  models: MergedModel[];
}
const cache = new Map<string, CacheEntry>();

// Cap the wait on a single provider's `/models` — a hung provider must never stall the picker.
const FETCH_TIMEOUT_MS = 4_000;

// Test seam: drop the per-caller cache so a test can re-fetch with a changed stub / key set.
export function clearByokModelsCache(): void {
  cache.clear();
}

// The caller's BYOK models, enriched to the same `MergedModel` shape the catalog endpoint returns.
// Fail-closed: BYOK must be entitled at read time (mirrors resolveTurnBackend's spend-time re-check),
// so a non-entitled caller — or one who has stored no keys — gets an empty list and pays no round
// trips. Every provider is fetched in parallel; a provider whose `/models` errors or times out is
// SKIPPED (see `providerModels`), never allowed to fail the whole list.
export async function byokModelsFor(auth: AuthContext): Promise<MergedModel[]> {
  if (!can(auth, "byok")) return [];
  const userId = auth.user.id;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.models;

  const providers = configuredProviders(userId);
  const lists = await Promise.all(providers.map((p) => providerModels(userId, p)));
  const models = lists.flat();
  cache.set(userId, { at: Date.now(), models });
  return models;
}

// One provider's models, enriched — or an EMPTY list if anything goes wrong. This is the graceful
// boundary: a missing/rotated key, an unknown provider, or a `/models` error/timeout all degrade to
// `[]` so the caller (both endpoints) never loses its local models over one flaky provider.
async function providerModels(userId: string, provider: string): Promise<MergedModel[]> {
  const info = providerInfo(provider);
  if (!info) return []; // not in the fixed catalog (shouldn't happen — storing a key validates it)
  const apiKey = getDecryptedProviderKey(userId, provider);
  if (!apiKey) return []; // corrupt / rotated-away key → treat as absent, skip
  try {
    const live = await withTimeout(frontierBackendFor(provider, apiKey).listModels(), FETCH_TIMEOUT_MS);
    const seen = new Set<string>();
    const out: MergedModel[] = [];
    for (const m of live) {
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(byokMergedModel(provider, m.id, m.label));
    }
    return out;
  } catch {
    return []; // graceful: a provider's /models error/timeout is swallowed — local models still show
  }
}

// A single BYOK model as a `MergedModel`. The id carries the `provider/` prefix resolveTurnBackend
// routes on; `displayName` prefers the provider's label, else the bare upstream id.
function byokMergedModel(provider: string, upstreamId: string, label?: string): MergedModel {
  return {
    ...byokMeta(provider),
    id: `${provider}/${upstreamId}`,
    displayName: label ?? upstreamId,
    available: true,
  };
}

// Conservative metadata for a BYOK model — the catalog can't know a frontier model's real modalities
// or pricing from a bare `/models` list, so we start from `defaultMeta()` and flip only what we DO
// know: it's the named frontier provider, reachable ONLY on the caller's own key (`byokOnly`, which
// the ModelPicker reads to render the badge), and NOT on our local box (`hosting: "unknown"`). `cost`
// stays `{ local: true }` from the defaults — honest from OUR side (we never bill for a BYOK turn;
// the user's provider does), and it keeps the usage meter from inventing a bogus price. Input stays
// text-only, so the attachment gate (#136) stays conservatively off for BYOK models.
function byokMeta(provider: string): ModelMeta {
  return {
    ...defaultMeta(),
    provider,
    hosting: "unknown",
    byokOnly: true,
  };
}

// Bound the wait on a promise; the loser rejects and is swallowed by `providerModels`. The underlying
// fetch isn't aborted (listModels takes no signal), just abandoned — harmless, it's GC'd. The timer
// is cleared as soon as the race settles so it never keeps the event loop (or a test) alive.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("byok /models timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

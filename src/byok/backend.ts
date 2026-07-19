import type { AuthContext } from "../auth/middleware.ts";
import { can } from "../entitlements/index.ts";
import { backend } from "../jano/client.ts";
import type { ChatChunk, ChatRequest, LLMBackend, ModelInfo } from "../jano/types.ts";
import { parseChatCompletionStream } from "../llm/stream.ts";
import { parseModelRef, providerInfo } from "./providers.ts";
import { getDecryptedProviderKey } from "./service.ts";

// The BYOK frontier backend (#14): an OpenAI-compatible client pointed at a FIXED provider base
// (from the catalog, never user input → no SSRF) and authenticated with the user's own key. It
// reuses the exact same streaming parser as the local Jano client, so a BYOK turn behaves
// identically to a local one. The key lives only in the Authorization header for the life of the
// request; it is never logged and never placed in an error message.
export function frontierBackendFor(provider: string, apiKey: string): LLMBackend {
  const info = providerInfo(provider);
  if (!info) throw new Error(`unknown BYOK provider: ${provider}`);
  const base = info.baseUrl;
  const authHeaders = (): Record<string, string> => ({
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  });

  return {
    async listModels(): Promise<ModelInfo[]> {
      const res = await fetch(`${base}/models`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`${provider} /models -> ${res.status}`);
      const data = (await res.json()) as { data?: { id: string; label?: string }[] };
      return (data.data ?? []).map((m) => ({ id: m.id, label: m.label }));
    },

    async complete(req: ChatRequest): Promise<string> {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature ?? 0.7,
          stream: false,
        }),
      });
      if (!res.ok) throw new Error(`${provider} complete -> ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? "";
    },

    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature ?? 0.7,
          stream: true,
          stream_options: { include_usage: true },
          ...(req.noTrain ? { store: false } : {}),
        }),
        signal: req.signal,
      });
      yield* parseChatCompletionStream(res, `${provider} chat`);
    },
  };
}

// What backend a single turn runs on, plus the model id to send upstream (a BYOK id has its
// `provider/` prefix stripped for the provider; a local id passes through unchanged).
export interface ResolvedTurn {
  backend: LLMBackend;
  upstreamModel: string;
}

// Whether `model` is a BYOK id THIS caller can actually spend: a `provider/model` ref + the `byok`
// entitlement + a stored key for that provider. The exact fail-closed predicate resolveTurnBackend
// routes on — factored out so the model allowlist can admit a picked BYOK model (assertModelAllowed)
// on the same rule the runner enforces at spend time, without duplicating the logic.
export function canSpendByokModel(auth: AuthContext, model: string): boolean {
  const ref = parseModelRef(model);
  return !!ref && can(auth, "byok") && getDecryptedProviderKey(auth.user.id, ref.provider) !== null;
}

// The ONE seam the chat runner consults to choose a backend for a turn. Default: the shared local
// Jano client. When the caller is BYOK-entitled AND has stored a key for the provider named by a
// `provider/model` id, this turn is routed to that frontier provider on the user's own key/cost.
// Fail-closed at every step — a plain (non-`provider/`) model, an unentitled caller, or a missing
// key all fall straight through to the local router, so BYOK can never be reached without both the
// paywall entitlement and a stored key. The persisted/attributed model keeps the full original id
// (so a re-run re-resolves the same way); only the upstream request uses the stripped id.
export function resolveTurnBackend(auth: AuthContext, model: string): ResolvedTurn {
  const ref = parseModelRef(model);
  if (ref && can(auth, "byok")) {
    const apiKey = getDecryptedProviderKey(auth.user.id, ref.provider);
    if (apiKey) {
      return { backend: frontierBackendFor(ref.provider, apiKey), upstreamModel: ref.upstreamModel };
    }
  }
  return { backend, upstreamModel: model };
}

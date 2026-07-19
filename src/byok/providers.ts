// The BYOK frontier-provider catalog (#14). A user brings a KEY, never a URL — every endpoint
// here is a FIXED, hardcoded provider base, so there is no user-controlled outbound target and
// therefore no SSRF surface (that's what distinguishes BYOK from the later bring-your-own-endpoint
// feature, which does accept an arbitrary URL behind an explicit external-only guard). Every
// provider listed speaks the OpenAI-compatible `/chat/completions` streaming wire format, so the
// shared parser (src/llm/stream.ts) handles them all; adding a provider is a one-line entry here.
export interface ProviderInfo {
  id: string; // stable catalog id — also the prefix in a `provider/model` id
  label: string; // human display name
  baseUrl: string; // fixed OpenAI-compatible base (no trailing slash); `${baseUrl}/chat/completions`
  keyHint: string; // placeholder shown in the key input (not a real key)
}

// OpenAI-compatible endpoints only. Anthropic and Google are reached via their documented
// OpenAI-compatible bases so the one shared parser covers every provider; OpenRouter additionally
// fronts the whole frontier through a single key.
const CATALOG: readonly ProviderInfo[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyHint: "sk-…" },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", keyHint: "sk-ant-…" },
  { id: "google", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyHint: "AIza…" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyHint: "sk-or-…" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyHint: "gsk_…" },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", keyHint: "xai-…" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyHint: "sk-…" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyHint: "…" },
] as const;

const BY_ID = new Map(CATALOG.map((p) => [p.id, p]));

// The public catalog (id + label + key hint) for the settings UI. `baseUrl` is intentionally
// omitted — it's an internal routing detail, not something the client needs.
export function providerCatalog(): { id: string; label: string; keyHint: string }[] {
  return CATALOG.map((p) => ({ id: p.id, label: p.label, keyHint: p.keyHint }));
}

export function isProvider(id: string): boolean {
  return BY_ID.has(id);
}

export function providerInfo(id: string): ProviderInfo | null {
  return BY_ID.get(id) ?? null;
}

// A conversation model id can name a BYOK provider via a `provider/upstreamModel` prefix, e.g.
// `openai/gpt-4o` (provider "openai", upstream "gpt-4o") or `openrouter/anthropic/claude-3.5`
// (provider "openrouter", upstream "anthropic/claude-3.5" — only the FIRST segment is the
// provider). Returns null when the first segment isn't a known provider (a plain local/Jano model)
// or the upstream part is empty — so a non-BYOK model falls straight through to the local router.
export interface ModelRef {
  provider: string;
  upstreamModel: string; // the id to send upstream (the prefix stripped)
}

export function parseModelRef(model: string): ModelRef | null {
  const i = model.indexOf("/");
  if (i <= 0) return null; // no slash, or a leading slash (empty provider)
  const provider = model.slice(0, i);
  const upstreamModel = model.slice(i + 1);
  if (!upstreamModel || !isProvider(provider)) return null;
  return { provider, upstreamModel };
}

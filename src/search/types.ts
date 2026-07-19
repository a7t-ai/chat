// Web search ("Research") — the search seam, mirroring `jano/` and `embed/`: one
// interface with swappable providers (Tavily, Brave, self-hosted SearXNG). The chat turn
// calls `runWebSearch()` to retrieve current web context BEFORE generation, then injects
// it into the prompt so ANY model (qwen-chat / qwen-coder) answers from fresh, cited
// sources — with no dependency on the model's own tool-calling. This is the premium
// "search the web" capability. See `src/search/service.ts`.

// One ranked result from a provider. `content` is the extracted page text when the
// provider returns it (Tavily); otherwise the orchestrator fetches + extracts it.
export interface SearchHit {
  title: string;
  url: string;
  snippet: string; // provider-supplied summary (may be empty)
  content?: string; // full extracted page text when available
  score?: number; // provider relevance score when available (0..1)
}

// A source as shown to the user (numbered, deduped) and streamed to the client so the
// answer's citations [n] map to clickable references.
export interface Source {
  n: number; // citation number [n]
  title: string;
  url: string;
  domain: string; // host without a leading www., for a compact label
}

export interface ProviderSearchOpts {
  maxResults: number;
  // Ask the provider to also return page content in one call (Tavily). Providers that
  // can't ignore it; the orchestrator fetches the pages itself instead.
  withContent?: boolean;
  signal?: AbortSignal;
}

// One web-search backend. `search` returns ranked hits for a single query.
export interface SearchProvider {
  readonly name: string;
  // Whether `search` returns usable page content (so the orchestrator can skip the
  // separate fetch+extract step). True for Tavily; false for Brave / SearXNG.
  readonly providesContent: boolean;
  search(query: string, opts: ProviderSearchOpts): Promise<SearchHit[]>;
}

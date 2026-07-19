import { config } from "../config.ts";
import type { ProviderSearchOpts, SearchHit, SearchProvider } from "./types.ts";

// The three web-search backends behind the SearchProvider seam. Add another by
// implementing the interface and slotting it into `selectProvider`.
//
//   - Tavily  : purpose-built for LLM retrieval — returns ranked, LLM-ready content in one
//               call (we ask for raw page text), so no separate fetch step. Needs a key.
//   - Brave   : the only large INDEPENDENT western web index after Bing's API shut down.
//               Returns titles + snippets; the orchestrator fetches pages for content.
//   - SearXNG : self-hosted metasearch (no key, no third-party data leakage — fits the
//               app's privacy posture). JSON results; the orchestrator fetches pages.

class TavilyProvider implements SearchProvider {
  readonly name = "tavily";
  readonly providesContent = true;
  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: ProviderSearchOpts): Promise<SearchHit[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: opts.maxResults,
        include_raw_content: opts.withContent ? "text" : false,
        include_answer: false,
        topic: "general",
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`tavily -> ${res.status}`);
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string; raw_content?: string; score?: number }[];
    };
    return (data.results ?? [])
      .filter((r): r is { url: string } & typeof r => typeof r.url === "string" && r.url.length > 0)
      .map((r) => ({
        title: r.title ?? "",
        url: r.url,
        snippet: r.content ?? "",
        content: r.raw_content || r.content || undefined,
        score: typeof r.score === "number" ? r.score : undefined,
      }));
  }
}

class BraveProvider implements SearchProvider {
  readonly name = "brave";
  readonly providesContent = false;
  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: ProviderSearchOpts): Promise<SearchHit[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(opts.maxResults, 20)));
    const res = await fetch(url, {
      headers: { accept: "application/json", "x-subscription-token": this.apiKey },
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`brave -> ${res.status}`);
    const data = (await res.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string }[] };
    };
    return (data.web?.results ?? [])
      .filter((r): r is { url: string } & typeof r => typeof r.url === "string" && r.url.length > 0)
      .map((r) => ({ title: r.title ?? "", url: r.url, snippet: r.description ?? "" }));
  }
}

class SearxngProvider implements SearchProvider {
  readonly name = "searxng";
  readonly providesContent = false;
  constructor(private readonly baseUrl: string) {}

  async search(query: string, opts: ProviderSearchOpts): Promise<SearchHit[]> {
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: opts.signal });
    if (!res.ok) throw new Error(`searxng -> ${res.status}`);
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string; score?: number }[];
    };
    return (data.results ?? [])
      .filter((r): r is { url: string } & typeof r => typeof r.url === "string" && r.url.length > 0)
      .slice(0, opts.maxResults)
      .map((r) => ({
        title: r.title ?? "",
        url: r.url,
        snippet: r.content ?? "",
        score: typeof r.score === "number" ? r.score : undefined,
      }));
  }
}

// Resolve the active provider from config, or null when none is configured. "auto"
// prefers Tavily (LLM-ready) → Brave (independent index) → SearXNG (self-hosted).
export function selectProvider(): SearchProvider | null {
  const s = config.search;
  const tavily = s.tavilyApiKey ? new TavilyProvider(s.tavilyApiKey) : null;
  const brave = s.braveApiKey ? new BraveProvider(s.braveApiKey) : null;
  const searxng = s.searxngUrl ? new SearxngProvider(s.searxngUrl) : null;
  switch (s.provider) {
    case "tavily":
      return tavily;
    case "brave":
      return brave;
    case "searxng":
      return searxng;
    default:
      return tavily ?? brave ?? searxng;
  }
}

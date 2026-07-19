import { config } from "../config.ts";
import { backend } from "../jano/client.ts";
import type { ChatMessage } from "../jano/types.ts";
import { track, trackError } from "../telemetry/index.ts";
import { fetchReadable } from "./fetch.ts";
import { selectProvider } from "./providers.ts";
import type { SearchHit, Source } from "./types.ts";

// The web-search orchestrator. One turn:
//   1. derive 1-3 focused queries from the (often conversational) user message
//   2. search each via the configured provider, merge + dedupe by URL, rank, cap
//   3. ensure each kept hit has page content (provider-supplied, or fetched + extracted)
//   4. assemble a numbered context block + the matching source list
// The block is injected as a system message before generation so the model answers from
// fresh evidence and cites [n]. Progress is reported via `onStage` so the UI can show
// "Searching… / Reading N sources…".

// Progress signal streamed to the client during the search phase.
export type SearchStage =
  | { stage: "searching"; queries: string[] }
  | { stage: "reading"; count: number }
  | { stage: "error"; message: string };

export interface SearchOutcome {
  system: ChatMessage; // numbered web context, injected before generation
  sources: Source[]; // numbered references for the UI (citations [n] map to these)
  queries: string[]; // the queries actually searched
}

const MAX_QUERIES = 3;
const PER_QUERY = 5; // results requested per query (before dedupe + cap)
const CONTENT_CHARS = 1800; // page text per source fed to the model
const TOTAL_BUDGET = 9000; // total page-text chars injected across all sources

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Turn the user's message into up to 3 concise web queries. Best-effort: any failure or
// empty output falls back to the raw message, so search always runs.
async function deriveQueries(content: string): Promise<string[]> {
  const raw = content.trim();
  const fallback = [raw.slice(0, 300)];
  if (raw.length < 12) return fallback;
  const prompt = [
    "Turn the user's message into 1 to 3 concise web search queries that would surface the information needed to answer it well.",
    "Respond with ONLY the queries, one per line — no numbering, no quotes, no commentary. Fewer is better; use one when one suffices.",
    "",
    `User message: ${raw.slice(0, 800)}`,
  ].join("\n");
  try {
    const out = await backend.complete({
      model: config.defaultModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });
    const qs = out
      .split("\n")
      .map((l) => l.replace(/^[-*\d.)\s]+/, "").replace(/^["']|["']$/g, "").trim())
      .filter((l) => l.length > 1)
      .slice(0, MAX_QUERIES);
    return qs.length > 0 ? qs : fallback;
  } catch {
    return fallback;
  }
}

export async function runWebSearch(
  content: string,
  opts: { onStage?: (s: SearchStage) => void; signal?: AbortSignal } = {},
): Promise<SearchOutcome | null> {
  const provider = selectProvider();
  if (!provider) return null;
  track({ type: "capability.research" });
  const onStage = opts.onStage ?? (() => {});
  const maxResults = config.search.maxResults;
  const maxFetch = config.search.maxFetch;

  const queries = await deriveQueries(content);
  onStage({ stage: "searching", queries });

  // Search each query; merge + dedupe by URL (first occurrence wins its score).
  const byUrl = new Map<string, SearchHit>();
  for (const q of queries) {
    if (opts.signal?.aborted) break;
    let hits: SearchHit[] = [];
    try {
      hits = await provider.search(q, { maxResults: PER_QUERY, withContent: provider.providesContent, signal: opts.signal });
    } catch (e) {
      trackError("search.provider", e);
      hits = [];
    }
    for (const h of hits) {
      if (!h.url || byUrl.has(h.url)) continue;
      byUrl.set(h.url, h);
    }
  }

  let hits = [...byUrl.values()];
  if (hits.length === 0) {
    onStage({ stage: "error", message: "no results" });
    return null;
  }
  // Rank by provider score when present; otherwise keep insertion (provider) order.
  if (hits.some((h) => typeof h.score === "number")) {
    hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  hits = hits.slice(0, maxResults);

  // Ensure each kept hit has real content. Providers that don't return it (Brave,
  // SearXNG) get their top pages fetched + extracted, in parallel and bounded.
  const needFetch = hits.filter((h) => !h.content || h.content.trim().length < 200).slice(0, maxFetch);
  if (needFetch.length > 0) {
    onStage({ stage: "reading", count: needFetch.length });
    await Promise.all(
      needFetch.map(async (h) => {
        const text = await fetchReadable(h.url, { signal: opts.signal });
        if (text) h.content = text;
      }),
    );
  }

  // Assemble numbered sources + the context block, within a total char budget so a few
  // long pages can't blow up the prompt.
  const sources: Source[] = [];
  const blocks: string[] = [];
  let budget = TOTAL_BUDGET;
  let n = 0;
  for (const h of hits) {
    n += 1;
    const title = h.title.trim() || domainOf(h.url);
    sources.push({ n, title, url: h.url, domain: domainOf(h.url) });
    const body = (h.content || h.snippet || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Math.max(0, Math.min(CONTENT_CHARS, budget)));
    budget -= body.length;
    blocks.push(`[${n}] ${title} — ${h.url}\n${body || "(no extract available)"}`);
    if (budget <= 200) break;
  }

  const system: ChatMessage = {
    role: "system",
    content: [
      `The user enabled web search. The numbered results below were retrieved from the live web just now for: ${queries
        .map((q) => `"${q}"`)
        .join(", ")}.`,
      "Use them as your primary evidence. Cite sources inline as [n] (matching the numbers below) immediately after the claims they support. Prefer recent, specific facts from these sources over your prior knowledge; if the sources conflict or don't cover something, say so plainly. Never invent citations, sources, or URLs.",
      "",
      ...blocks,
    ].join("\n"),
  };
  return { system, sources, queries };
}

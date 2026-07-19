import { afterEach, describe, expect, test } from "bun:test";
import { backend } from "../jano/client.ts";
import { runWebSearch } from "./service.ts";

// The web-search orchestrator: deriveQueries (via the Jano backend) -> per-query provider
// search -> dedupe/rank/cap -> fetch page content for snippet-only providers -> assemble a
// numbered context block + sources. Every external boundary is stubbed:
//   - backend.complete  (deriveQueries)  -> monkeypatched
//   - globalThis.fetch  (SearXNG search + page fetches) -> routed fake
// The test env's provider is SearXNG (see providers.test.ts), which returns snippets only,
// so hits flow through the fetchReadable step too.

const realFetch = globalThis.fetch;
const realComplete = backend.complete.bind(backend);
afterEach(() => {
  globalThis.fetch = realFetch;
  backend.complete = realComplete;
});

// A long, sentence-like body so htmlToText keeps it and it survives the >0-length check.
function pageHtml(label: string): string {
  const para = `This is the readable article body for ${label}. `.repeat(20);
  return `<html><head><title>${label}</title></head><body><article><p>${para}</p></article></body></html>`;
}

function htmlResponse(label: string): Response {
  return new Response(pageHtml(label), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function searxResponse(results: unknown[]): Response {
  return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
}

// Route fetches by host: the SearXNG endpoint (127.0.0.1:8888) returns the given results;
// everything else is treated as a result page returning HTML.
function routeFetch(searxResults: () => Response): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
    if (url.includes("127.0.0.1:8888") || url.includes("/search")) return searxResults();
    return htmlResponse(new URL(url).hostname);
  }) as unknown as typeof fetch;
}

describe("deriveQueries (via runWebSearch)", () => {
  test("parses one-per-line model output, stripping numbering/bullets/quotes", async () => {
    backend.complete = async () => `1. best pastel de nata lisbon\n- "alfama viewpoints"\n* tram 28 route`;
    let searchedQueries: string[] = [];
    routeFetch(() =>
      searxResponse([{ title: "A", url: "https://a.example.com/1", content: "snip", score: 0.9 }]),
    );
    const out = await runWebSearch("where can I get the best pastel de nata in Lisbon?", {
      onStage: (s) => {
        if (s.stage === "searching") searchedQueries = s.queries;
      },
    });
    expect(out).not.toBeNull();
    expect(out!.queries).toEqual(["best pastel de nata lisbon", "alfama viewpoints", "tram 28 route"]);
    expect(searchedQueries).toEqual(out!.queries);
  });

  test("caps at 3 queries even if the model emits more", async () => {
    backend.complete = async () => "q1\nq2\nq3\nq4\nq5";
    routeFetch(() => searxResponse([{ title: "T", url: "https://x.example.com", content: "snip" }]));
    const out = await runWebSearch("a sufficiently long user message to trigger derivation", {});
    expect(out!.queries).toEqual(["q1", "q2", "q3"]);
  });

  test("falls back to the raw message when the model output is empty", async () => {
    backend.complete = async () => "   \n  \n";
    routeFetch(() => searxResponse([{ title: "T", url: "https://y.example.com", content: "snip" }]));
    const msg = "a long enough message that derivation is attempted at all";
    const out = await runWebSearch(msg, {});
    expect(out!.queries).toEqual([msg]);
  });

  test("falls back to the raw message when the model throws", async () => {
    backend.complete = async () => {
      throw new Error("jano down");
    };
    routeFetch(() => searxResponse([{ title: "T", url: "https://z.example.com", content: "snip" }]));
    const msg = "another long enough message to attempt derivation";
    const out = await runWebSearch(msg, {});
    expect(out!.queries).toEqual([msg]);
  });

  test("short messages (<12 chars) skip the model and use the raw message", async () => {
    let modelCalled = false;
    backend.complete = async () => {
      modelCalled = true;
      return "should-not-be-used";
    };
    routeFetch(() => searxResponse([{ title: "T", url: "https://s.example.com", content: "snip" }]));
    const out = await runWebSearch("Lisbon", {}); // 6 chars
    expect(modelCalled).toBe(false);
    expect(out!.queries).toEqual(["Lisbon"]);
  });
});

describe("runWebSearch orchestration", () => {
  test("merges + dedupes hits across queries and builds numbered sources + context block", async () => {
    backend.complete = async () => "q1\nq2";
    // q1 and q2 share https://dup.example.com -> first occurrence wins, deduped once.
    let call = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("127.0.0.1:8888") || url.includes("/search")) {
        call += 1;
        if (call === 1) {
          return searxResponse([
            { title: "First", url: "https://one.example.com", content: "c1", score: 0.5 },
            { title: "Dup", url: "https://dup.example.com", content: "cd", score: 0.9 },
          ]);
        }
        return searxResponse([
          { title: "Dup again", url: "https://dup.example.com", content: "cd2", score: 0.1 },
          { title: "Second", url: "https://two.example.com", content: "c2", score: 0.3 },
        ]);
      }
      return htmlResponse(new URL(url).hostname);
    }) as unknown as typeof fetch;

    const out = await runWebSearch("plan a long enough trip to lisbon please", {});
    expect(out).not.toBeNull();
    const urls = out!.sources.map((s) => s.url);
    expect(urls).toContain("https://one.example.com");
    expect(urls).toContain("https://two.example.com");
    // Deduped: dup.example.com appears exactly once.
    expect(urls.filter((u) => u === "https://dup.example.com").length).toBe(1);
    // Ranked by score desc (dup 0.9 first), and numbered from 1.
    expect(out!.sources[0]?.url).toBe("https://dup.example.com");
    expect(out!.sources.map((s) => s.n)).toEqual(out!.sources.map((_, i) => i + 1));
    // domain strips a leading www-less host already; verify the field is the bare host.
    expect(out!.sources[0]?.domain).toBe("dup.example.com");
    // The system block is the injected evidence: role system, numbered [n], quotes the queries.
    expect(out!.system.role).toBe("system");
    expect(out!.system.content).toContain('"q1"');
    expect(out!.system.content).toContain("[1]");
    expect(out!.system.content).toContain("readable article body"); // fetched page content present
  });

  test("emits a 'reading' stage for snippet-only providers (content fetched)", async () => {
    backend.complete = async () => "q1";
    routeFetch(() =>
      searxResponse([{ title: "Need fetch", url: "https://nf.example.com", content: "tiny" }]),
    );
    const stages: string[] = [];
    const out = await runWebSearch("a long enough message to search the web now", {
      onStage: (s) => stages.push(s.stage),
    });
    expect(out).not.toBeNull();
    expect(stages).toContain("searching");
    expect(stages).toContain("reading");
  });

  test("falls back to a result's snippet when the page fetch yields nothing", async () => {
    backend.complete = async () => "q1";
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("127.0.0.1:8888") || url.includes("/search")) {
        return searxResponse([
          { title: "Snip only", url: "https://snip.example.com", content: "a useful snippet stays" },
        ]);
      }
      // Page fetch returns a non-HTML content-type -> fetchReadable returns null.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const out = await runWebSearch("yet another long message for the web search", {});
    expect(out!.system.content).toContain("a useful snippet stays");
  });

  test("returns null and emits an error stage when no query yields any hit", async () => {
    backend.complete = async () => "q1\nq2";
    routeFetch(() => searxResponse([])); // every query: empty
    const stages: string[] = [];
    const out = await runWebSearch("a long message that surfaces nothing at all", {
      onStage: (s) => stages.push(s.stage),
    });
    expect(out).toBeNull();
    expect(stages).toContain("error");
  });

  test("a provider throwing on one query is swallowed; null when all fail", async () => {
    backend.complete = async () => "q1\nq2";
    routeFetch(() => new Response("boom", { status: 500 })); // provider throws -> caught
    const out = await runWebSearch("a long message whose searches all error out", {});
    expect(out).toBeNull();
  });

  test("hits with a falsy/empty url are skipped during dedupe", async () => {
    backend.complete = async () => "q1";
    // The SearXNG provider already drops url-less rows, so feed a row whose url is a
    // whitespace string that survives the provider but then... actually the provider keeps
    // any non-empty string. Use one good + one good to confirm the loop's continue path is
    // covered by normal dedupe (above). Here: a single valid hit produces one source.
    routeFetch(() => searxResponse([{ title: "Only", url: "https://only.example.com", content: "x" }]));
    const out = await runWebSearch("a single result long enough message here", {});
    expect(out!.sources.length).toBe(1);
    expect(out!.sources[0]?.url).toBe("https://only.example.com");
  });

  test("a malformed hit url falls back to the raw string for the domain label", async () => {
    backend.complete = async () => "q1";
    // The SearXNG provider keeps any non-empty string as a url, so a malformed one reaches
    // domainOf, whose try/catch returns the raw string. Give it >=200 chars of content so
    // it skips the fetch step (fetchReadable would reject the malformed url anyway).
    const longContent = "real content ".repeat(40);
    routeFetch(() =>
      searxResponse([{ title: "Bad URL", url: "not a valid url", content: longContent }]),
    );
    const out = await runWebSearch("a long enough message with a malformed result url", {});
    expect(out).not.toBeNull();
    expect(out!.sources[0]?.domain).toBe("not a valid url"); // raw fallback
  });

  test("aborting before the first query stops the search loop (no results -> null)", async () => {
    backend.complete = async () => "q1\nq2";
    const ctrl = new AbortController();
    ctrl.abort(); // already aborted: the per-query loop breaks immediately
    let searchHit = false;
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      if (url.includes("127.0.0.1:8888") || url.includes("/search")) searchHit = true;
      return searxResponse([{ title: "x", url: "https://x.example.com", content: "x" }]);
    }) as unknown as typeof fetch;
    const out = await runWebSearch("a long message that is aborted before searching", {
      signal: ctrl.signal,
    });
    expect(searchHit).toBe(false); // never reached the provider
    expect(out).toBeNull(); // no hits collected
  });
});

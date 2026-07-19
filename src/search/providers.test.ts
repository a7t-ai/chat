import { afterEach, describe, expect, test } from "bun:test";
import { selectProvider } from "./providers.ts";

// Stub global fetch so provider parsing is tested without hitting the network.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function stubJson(body: unknown, ok = true): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("selectProvider", () => {
  test("returns the configured provider (searxng in the test env)", () => {
    const p = selectProvider();
    expect(p?.name).toBe("searxng");
    expect(p?.providesContent).toBe(false);
  });
});

describe("SearxngProvider.search", () => {
  test("maps results, drops entries without a url, respects maxResults", async () => {
    stubJson({
      results: [
        { title: "A", url: "https://a.com", content: "snip a", score: 0.9 },
        { title: "no url" },
        { title: "B", url: "https://b.com", content: "snip b" },
        { title: "C", url: "https://c.com" },
      ],
    });
    const hits = await selectProvider()!.search("lisbon", {
      maxResults: 2,
      withContent: false,
      signal: new AbortController().signal,
    });
    expect(hits.length).toBe(2); // sliced to maxResults
    expect(hits[0]).toMatchObject({ title: "A", url: "https://a.com", snippet: "snip a", score: 0.9 });
    expect(hits.every((h) => h.url.length > 0)).toBe(true); // url-less entry dropped
  });

  test("throws on a non-2xx response", async () => {
    stubJson({}, false);
    let threw = false;
    try {
      await selectProvider()!.search("x", { maxResults: 5, withContent: false, signal: new AbortController().signal });
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("searxng");
    }
    expect(threw).toBe(true);
  });
});

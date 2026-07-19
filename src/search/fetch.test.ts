import { afterEach, describe, expect, test } from "bun:test";
import { fetchReadable, htmlToText, isSafeUrl } from "./fetch.ts";

// Security: isSafeUrl is the SSRF guard for the Research capability, which fetches
// arbitrary URLs returned by a search provider. It must reject anything that could reach
// internal/loopback/link-local/cloud-metadata addresses or non-HTTP schemes.
describe("isSafeUrl (SSRF guard)", () => {
  test("allows public http(s) URLs", () => {
    expect(isSafeUrl("https://en.wikipedia.org/wiki/Lisbon")).toBe(true);
    expect(isSafeUrl("http://example.com/path?q=1")).toBe(true);
  });

  test("blocks loopback + localhost", () => {
    expect(isSafeUrl("http://localhost/")).toBe(false);
    expect(isSafeUrl("http://127.0.0.1/")).toBe(false);
    expect(isSafeUrl("http://[::1]/")).toBe(false);
  });

  test("blocks private + CGNAT ranges", () => {
    expect(isSafeUrl("http://10.0.0.5/")).toBe(false);
    expect(isSafeUrl("http://192.168.1.1/")).toBe(false);
    expect(isSafeUrl("http://172.16.0.1/")).toBe(false);
    expect(isSafeUrl("http://172.31.255.255/")).toBe(false);
    expect(isSafeUrl("http://100.64.0.0/")).toBe(false);
  });

  test("blocks cloud metadata (169.254.169.254) + link-local", () => {
    expect(isSafeUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isSafeUrl("http://[fe80::1]/")).toBe(false);
    expect(isSafeUrl("http://[fc00::1]/")).toBe(false);
  });

  test("blocks internal-looking hostnames", () => {
    expect(isSafeUrl("http://db.internal/")).toBe(false);
    expect(isSafeUrl("http://printer.local/")).toBe(false);
  });

  test("blocks non-HTTP schemes + garbage", () => {
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("ftp://example.com/")).toBe(false);
    expect(isSafeUrl("not a url")).toBe(false);
  });

  // SSRF regression (security review C1): the IPv6 spelling of internal addresses.
  test("blocks IPv4-mapped IPv6, unspecified, and non-global-unicast IPv6", () => {
    expect(isSafeUrl("http://[::ffff:127.0.0.1]/")).toBe(false); // mapped loopback
    expect(isSafeUrl("http://[::ffff:169.254.169.254]/")).toBe(false); // mapped metadata
    expect(isSafeUrl("http://[::]/")).toBe(false); // unspecified → loopback
    expect(isSafeUrl("http://[64:ff9b::7f00:1]/")).toBe(false); // not 2000::/3 → fail closed
  });
  test("still allows public global-unicast IPv6 (2000::/3)", () => {
    expect(isSafeUrl("http://[2606:4700:4700::1111]/")).toBe(true);
  });
});

describe("fetchReadable redirect re-validation (SSRF C2)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("refuses a redirect that points at a private host", async () => {
    globalThis.fetch = (async (u: string | URL) => {
      if (String(u).includes("evil.example")) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8082/" } });
      }
      return new Response("INTERNAL", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    expect(await fetchReadable("http://evil.example/")).toBeNull(); // loopback redirect rejected
  });

  test("follows a redirect to another public host", async () => {
    globalThis.fetch = (async (u: string | URL) => {
      if (String(u).includes("start.example")) {
        return new Response(null, { status: 302, headers: { location: "https://end.example/page" } });
      }
      return new Response("<main><p>real content</p></main>", { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    expect(await fetchReadable("http://start.example/")).toContain("real content");
  });
});

describe("htmlToText", () => {
  test("strips scripts/styles, decodes entities, keeps text", () => {
    const out = htmlToText("<style>x{}</style><p>Hello&nbsp;&amp; world</p><script>bad()</script>");
    expect(out).toContain("Hello & world");
    expect(out).not.toContain("bad()");
    expect(out).not.toContain("x{}");
  });

  test("prefers <main>/<article> content and drops chrome (nav/footer)", () => {
    const out = htmlToText("<nav>menu</nav><main><p>Body text</p></main><footer>foot</footer>");
    expect(out).toContain("Body text");
    expect(out).not.toContain("menu");
    expect(out).not.toContain("foot");
  });

  test("block elements become line breaks", () => {
    expect(htmlToText("<p>one</p><p>two</p>").split("\n").filter(Boolean)).toEqual(["one", "two"]);
  });
});

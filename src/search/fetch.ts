// Fetch a URL and extract readable plain text. Used when the search provider returns
// only snippets (Brave, SearXNG) so the model still gets real page content to ground its
// answer. Deliberately dependency-free: a lightweight tag-strip + entity-decode, bounded
// in size and time. Heavy / JS-rendered pages are out of scope for v1 — a Playwright- or
// Readability-backed fetcher can slot in behind this same function later.

const UA =
  "Mozilla/5.0 (compatible; a7t.chat/1.0; +https://a7t.chat) web-search-fetcher";

// SSRF guard. We only ever fetch URLs a search provider returned (not user-supplied),
// but the app sits on a private network next to internal services, so refuse anything
// that resolves to a private / loopback / link-local host or a non-http(s) scheme.
function isPrivateHost(host: string): boolean {
  // Strip a trailing dot and any IPv6 brackets — `new URL("http://[::1]/").hostname` is
  // "[::1]" (with brackets), which would otherwise dodge the loopback/ULA/link-local checks.
  let h = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;

  // IPv4-mapped/-compatible IPv6 (e.g. ::ffff:127.0.0.1, which `new URL` normalizes to the
  // hex form ::ffff:7f00:1): unwrap the embedded IPv4 and fall through to the v4 checks so
  // loopback / cloud-metadata can't be smuggled in through the IPv6 spelling.
  const hexMapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  const dotMapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    h = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  } else if (dotMapped) {
    h = dotMapped[1]!;
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true; // this-host / private / loopback
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata (169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  // Any remaining IPv6 literal: allow ONLY global-unicast (2000::/3, first nibble 2 or 3).
  // Everything else — ::1, :: (unspecified), fc/fd (ULA), fe80 (link-local), unrecognized
  // forms — is blocked. Fail closed: the app sits next to internal services.
  if (h.includes(":")) return !/^[23][0-9a-f]{0,3}:/.test(h);
  return false;
}

export function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !isPrivateHost(u.hostname);
  } catch {
    return false;
  }
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  middot: "·",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, ent: string) => {
    const e = ent.toLowerCase();
    if (e[0] === "#") {
      const code = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

// Strip an HTML document down to readable text. Drops non-content regions, prefers the
// <main>/<article> body when present, turns block boundaries into newlines, removes the
// remaining tags, then decodes entities and collapses whitespace.
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|head|nav|footer|form|aside|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(s);
  if (main?.[2]) s = main[2];
  s = s.replace(/<(p|div|br|li|h[1-6]|tr|section|article|header|blockquote)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|blockquote)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

// Fetch `url` and return its readable text, or null on any failure (timeout, non-HTML,
// blocked host, network error). Bounded by `timeoutMs` and `maxBytes` so one slow or huge
// page can't stall or balloon a turn.
export async function fetchReadable(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (!isSafeUrl(url)) return null;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // Follow redirects MANUALLY so each hop is re-checked by the SSRF guard — otherwise a
    // public-looking URL could 302 to a loopback/metadata host (the guard runs once on the
    // initial URL only).
    let target = url;
    let res: Response;
    for (let hops = 0; ; hops++) {
      res = await fetch(target, {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain" },
      });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      if (!loc || hops >= 5) return null; // no location, or too many hops
      target = new URL(loc, target).toString(); // resolve relative redirects
      if (!isSafeUrl(target)) return null; // re-validate the redirect target
    }
    if (!res.ok || !res.body) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) {
        void reader.cancel().catch(() => {});
        break;
      }
    }
    const text = htmlToText(html);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

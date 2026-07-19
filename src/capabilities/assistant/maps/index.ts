import { join } from "node:path";
import { Hono } from "hono";
import { trustedClientIp } from "../../../auth/client-ip.ts";
import { allowRequest } from "../../../chat/ratelimit.ts";
import { config } from "../../../config.ts";
import { track } from "../../../telemetry/index.ts";
import type { Capability } from "../../types.ts";
import { geocode } from "./geocode.ts";

// Maps — capability #1. The model marks a geocodable place with  [[map:Place, City]]
// and the client turns that into a chip that opens an interactive map. Geocoding is
// resolved here (cached); tiles come from a self-hosted Protomaps PMTiles basemap when
// present (private/offline), else the client falls back to a free hosted basemap.

const BASEMAP_PATH = join(config.dataDir, "basemap.pmtiles");

const routes = new Hono();

// Per-caller rate limit for the PUBLIC (no-login) geocode proxy. Keyed by the trusted client IP
// (edge-aware; never trusts x-forwarded-for). A null/unknown peer shares one `geo:unknown` bucket
// and is still limited — never a bypass. Reuses the sliding-window limiter the chat endpoint uses;
// `now` is injectable for deterministic tests.
export function geoRateOk(ip: string | null, now: number = Date.now()): boolean {
  return allowRequest(`geo:${ip ?? "unknown"}`, config.geoRateLimitPerMin, now);
}

// GET /api/cap/map/geo?q=<place>  ->  { lat, lng, bbox, displayName } | 404
routes.get("/geo", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q.trim()) return c.json({ error: "missing q" }, 400);
  // Public carve-out: cap each caller BEFORE any geocode/Nominatim work so a flood can't back up
  // the serialized outbound chain or turn us into an open Nominatim relay. Cache hits go through
  // the limiter too (simplest, and still cheap).
  if (!geoRateOk(trustedClientIp(c))) return c.json({ error: "rate limited" }, 429);
  const result = await geocode(q);
  track({ type: "capability.maps", meta: { found: Boolean(result) } });
  if (!result) return c.json({ error: "not found" }, 404);
  return c.json(result);
});

// Whether the self-hosted PMTiles basemap is available (client picks Protomaps vs the
// hosted fallback). The file may be mid-download, so also require a sane minimum size.
routes.get("/basemap-status", async (c) => {
  const f = Bun.file(BASEMAP_PATH);
  const ready = (await f.exists()) && f.size > 1_000_000;
  return c.json({ ready });
});

// Serve the PMTiles archive with HTTP Range support (pmtiles.js fetches tile byte
// ranges). The slice is streamed, never read into memory.
routes.get("/basemap.pmtiles", async (c) => {
  const f = Bun.file(BASEMAP_PATH);
  if (!(await f.exists())) return c.json({ error: "basemap not ready" }, 503);
  const size = f.size;
  const range = c.req.header("range");
  const baseHeaders: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=86400",
  };
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start <= end) {
        return new Response(f.slice(start, end + 1), {
          status: 206,
          headers: { ...baseHeaders, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
        });
      }
    }
  }
  return new Response(f, { headers: { ...baseHeaders, "Content-Length": String(size) } });
});

// Taught to the model via the system prompt. Mark each concrete, geocodable place so a
// trip's stops all land on the map (the point of the map for planning) while staying
// conservative in ordinary chat.
function systemPrompt(): string {
  return [
    "",
    "Maps: mark specific, geocodable real-world places with an inline marker right after you name it:",
    "  [[map:Place name, City, Country]]",
    "When the user is planning a trip or you list several places to visit (an itinerary, 'things to see', a route), mark EACH stop — its neighborhoods and landmarks — so they all appear on the map together; that geography (what's clustered vs. far apart) is exactly what the map adds, so don't mark only the city. Mark the stops inside tables too. Prefer neighborhoods and well-known landmarks (which map services reliably find) over tiny venues like a specific café or shop (often not findable, and too many pins clutter the map).",
    "Example of marking an itinerary's stops (note: every stop carries its own marker, not just the city):",
    "  Morning: explore [[map:Alfama, Lisbon, Portugal]] and climb to [[map:São Jorge Castle, Lisbon, Portugal]]. Afternoon: head west to [[map:Belém Tower, Lisbon, Portugal]] and [[map:Jerónimos Monastery, Lisbon, Portugal]]. Evening: wander [[map:Chiado, Lisbon, Portugal]].",
    "Otherwise (ordinary chat, a one-off 'where is X'), use markers sparingly — a place or two, only when a map genuinely helps.",
    "Rules: only concrete places a map service could find — never vague regions, fictional, or abstract locations. Inside a marker put ONE clean, geocodable name plus its city and country, and nothing else — no parentheses, alternate names, slashes, or notes (write [[map:Time Out Market, Lisbon, Portugal]], not [[map:Time Out Market (Mercado da Ribeira)]]; split 'A / B' into two markers). Keep your prose natural; the marker renders as a small 'show on map' button, so don't describe the marker itself.",
  ].join("\n");
}

export const maps: Capability = {
  id: "map",
  title: "Maps",
  pillar: "assistant",
  enabled: true,
  systemPrompt,
  routes,
  // Contextual nudge (#22): when the user is clearly talking about going places but the reply
  // didn't already drop a map marker, gently point them at the map. The client suppresses this
  // whenever the reply already carries a `[[map:` marker, so this only fires for the adjacent
  // "where/what to see" intents where the map wasn't auto-used — exactly the discoverability win.
  suggestion: {
    title: "See it on a map",
    body: "Ask about a place, route, or trip and I'll drop each spot on an interactive map.",
    triggers: [
      "itinerary",
      "things to do",
      "things to see",
      "places to visit",
      "what to see in",
      "where to eat",
      "day trip",
      "road trip",
      "sightseeing",
      "walking tour",
      "directions to",
      "how do i get to",
    ],
  },
};

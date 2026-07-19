import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../auth/middleware.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import sttRoutes from "./routes.ts";

// Mount the real router behind a tiny app that injects a fake `auth` context (mirroring what the
// /api/* auth middleware sets), then drive it with app.request(...). The upstream STT service is
// STUBBED via globalThis.fetch — these tests never touch the network.
function appFor(auth: AuthContext): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    return next();
  });
  app.route("/", sttRoutes);
  return app;
}

function makeAdmin(): AuthContext {
  const u = db.insert(users).values({ login: `admin-${Math.random()}`, role: "admin", displayName: "Leo" }).returning().get();
  return { role: "admin", via: "owner", user: u, key: null };
}

function makeAccount(): AuthContext {
  const u = db
    .insert(users)
    .values({ login: `acct-${Math.random()}`, role: "account", accessGrantedAt: new Date() })
    .returning()
    .get();
  return { role: "account", via: "session", user: u, key: null, accessGranted: true };
}

function setStreamingUrl(url: string): void {
  (config.dictation as unknown as { streamingUrl: string }).streamingUrl = url;
}

function upstreamResponse(text: string, init: { status?: number } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: init.status ?? 200 });
}

// Parse an SSE response body into ordered { event, data } frames.
async function readFrames(res: Response): Promise<{ event: string; data: unknown }[]> {
  const text = await res.text();
  const frames: { event: string; data: unknown }[] = [];
  for (const block of text.split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    let data: unknown = dataLines.join("\n");
    try {
      data = JSON.parse(data as string);
    } catch {
      /* leave raw */
    }
    frames.push({ event, data });
  }
  return frames;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setStreamingUrl("");
});

describe("POST /api/dictate", () => {
  test("dark by default: 503 when STREAMING_STT_URL unset, even for the owner", async () => {
    setStreamingUrl("");
    const res = await appFor(makeAdmin()).request("/", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: "audio-bytes",
    });
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unavailable" });
  });

  test("no audio body -> 400 when configured", async () => {
    setStreamingUrl("http://up/dictate");
    const res = await appFor(makeAdmin()).request("/", { method: "POST", headers: { "content-type": "audio/webm" } });
    expect(res.status).toBe(400);
  });

  test("streams partial frames then a committed final (authed owner)", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () =>
      upstreamResponse('{"type":"partial","text":"ice"}\n{"type":"partial","text":"ice cream"}\n')) as unknown as typeof fetch;
    const res = await appFor(makeAdmin()).request("/?final=1", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: "audio-bytes",
    });
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    expect(frames).toEqual([
      { event: "partial", data: { text: "ice" } },
      { event: "partial", data: { text: "ice cream" } },
      // synthesized on stop because the upstream sent only partials
      { event: "final", data: { text: "ice cream" } },
    ]);
  });

  test("caller-scoped: a plain (non-owner) account can dictate too", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () => upstreamResponse('{"type":"final","text":"done"}')) as unknown as typeof fetch;
    const res = await appFor(makeAccount()).request("/", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: "audio-bytes",
    });
    expect(res.status).toBe(200);
    expect(await readFrames(res)).toEqual([{ event: "final", data: { text: "done" } }]);
  });

  test("an upstream error degrades to an SSE error frame (client falls back to batch)", async () => {
    setStreamingUrl("http://up/dictate");
    globalThis.fetch = (async () => upstreamResponse("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await appFor(makeAdmin()).request("/", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: "audio-bytes",
    });
    // The SSE stream itself is a 200; the failure rides an `error` frame.
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("error");
    expect((frames[0]?.data as { status: number }).status).toBe(502);
  });
});

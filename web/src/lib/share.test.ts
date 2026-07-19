import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatEvents } from "./chat";
import { attachShareStream } from "./share";

// The public, no-login watch stream. It rides the shared SSE parser (lib/chat), so these
// tests focus on share.ts's own behavior: the URL it hits (no auth headers), 204 → false,
// 404/transport → false, and a live stream dispatching deltas → true.

const enc = new TextEncoder();

function streamRes(chunks: string[], init: { status?: number } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200, headers: { "content-type": "text/event-stream" } });
}
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attachShareStream", () => {
  test("hits /api/share/:slug/stream with NO auth header and encodes the slug", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await attachShareStream("a/b", {});
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/share/a%2Fb/stream");
    // only the abort signal may be passed — never an Authorization header
    expect(init.headers).toBeUndefined();
  });

  test("returns false on 204 (nothing generating right now)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await attachShareStream("s", {})).toBe(false);
  });

  test("returns false on 404 (revoked/unknown link)", async () => {
    fetchMock.mockResolvedValue(new Response("x", { status: 404 }));
    expect(await attachShareStream("s", {})).toBe(false);
  });

  test("streams a live turn's deltas and resolves true", async () => {
    fetchMock.mockResolvedValue(
      streamRes([
        frame("meta", { conversationId: "c", model: "m" }),
        frame("delta", { text: "hel" }),
        frame("delta", { text: "lo" }),
        frame("done", { conversationId: "c", model: "m", usage: {} }),
      ]),
    );
    const seen: string[] = [];
    const events: ChatEvents = {
      onMeta: () => seen.push("meta"),
      onDelta: (t) => seen.push(`d:${t}`),
      onDone: () => seen.push("done"),
    };
    const streamed = await attachShareStream("s", events);
    expect(streamed).toBe(true);
    expect(seen).toEqual(["meta", "d:hel", "d:lo", "done"]);
  });

  test("passes the abort signal through to fetch", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const ctrl = new AbortController();
    await attachShareStream("s", {}, ctrl.signal);
    expect(fetchMock.mock.calls[0][1].signal).toBe(ctrl.signal);
  });
});

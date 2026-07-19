import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import { authHeaders, type Source } from "./api";
import { attachChat, type ChatEvents, regenerateChat, sendChat } from "./chat";

// chat.ts is the SSE protocol parser: it buffers a ReadableStream, splits on the blank-line
// frame boundary, pulls `event:`/`data:` lines, and dispatches to the right callback. These
// drive a fake fetch Response whose body is a stream of SSE frames and assert the dispatch
// order/payloads — plus the JSON-command short-circuit, the error/no-body branches, and that
// a frame split ACROSS chunks is reassembled (the load-bearing part of the buffering).

const enc = new TextEncoder();

// A Response whose body streams the given string chunks (so we can split frames mid-chunk).
function streamRes(chunks: string[], init: { status?: number; contentType?: string } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "text/event-stream" },
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// A recorder that captures dispatch order across all callbacks.
function recorder() {
  const order: string[] = [];
  const calls: Record<string, unknown[]> = {};
  const mk = (name: string) =>
    vi.fn((...args: unknown[]) => {
      order.push(name);
      calls[name] = args;
    });
  const events: ChatEvents = {
    onMeta: mk("meta"),
    onQueue: mk("queue"),
    onSearch: mk("search"),
    onSources: mk("sources"),
    onReasoning: mk("reasoning"),
    onDelta: mk("delta"),
    onDone: mk("done"),
    onError: mk("error"),
    onNotFound: mk("notFound"),
  };
  return { events, order, calls };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installLocalStorage();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendChat — request shape", () => {
  test("POSTs /api/chat with json content-type, auth, body, and signal", async () => {
    localStorage.setItem("a7t_chat_token", "tk");
    fetchMock.mockResolvedValue(streamRes([frame("done", { conversationId: "c1", model: "m", usage: {} })]));
    const ac = new AbortController();
    await sendChat({ content: "hi", model: "m" }, {}, ac.signal);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/chat");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", ...authHeaders() });
    expect(JSON.parse(init.body)).toEqual({ content: "hi", model: "m" });
    expect(init.signal).toBe(ac.signal);
  });

  test("carries attached fileIds in the body (files-to-prompt)", async () => {
    fetchMock.mockResolvedValue(streamRes([frame("done", { conversationId: "c1", model: "m", usage: {} })]));
    await sendChat({ content: "summarize", fileIds: ["f1", "f2"] }, {});
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ content: "summarize", fileIds: ["f1", "f2"] });
  });
});

describe("sendChat — JSON command short-circuit", () => {
  test("returns the CommandResult and never reads a stream for a JSON response", async () => {
    const cmd = { type: "command", command: "model.set", model: "x" };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(cmd), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { events, order } = recorder();
    const result = await sendChat({ content: "/model x" }, events);
    expect(result).toEqual(cmd);
    expect(order).toEqual([]); // no SSE dispatch
  });
});

describe("sendChat — SSE dispatch", () => {
  test("dispatches meta → queue → search → sources → delta → done in order", async () => {
    const sources: Source[] = [{ n: 1, title: "T", url: "https://x", domain: "x" }];
    const body = [
      frame("meta", { conversationId: "c1", model: "m" }),
      frame("queue", { position: 2 }),
      frame("search", { stage: "searching", queries: ["a"] }),
      frame("sources", { sources }),
      frame("delta", { text: "Hel" }),
      frame("delta", { text: "lo" }),
      frame("done", { conversationId: "c1", model: "m", usage: { in: 1 } }),
    ].join("");
    fetchMock.mockResolvedValue(streamRes([body]));
    const { events, order, calls } = recorder();
    const result = await sendChat({ content: "hi" }, events);
    expect(result).toBeNull(); // streamed, not a command
    expect(order).toEqual(["meta", "queue", "search", "sources", "delta", "delta", "done"]);
    expect(calls.meta[0]).toEqual({ conversationId: "c1", model: "m" });
    expect(calls.queue[0]).toBe(2);
    expect(calls.search[0]).toEqual({ stage: "searching", queries: ["a"] });
    expect(calls.sources[0]).toEqual(sources);
    expect(calls.done[0]).toEqual({ conversationId: "c1", model: "m", usage: { in: 1 } });
  });

  test("dispatches a reasoning frame to onReasoning, apart from the answer deltas (#68)", async () => {
    const body = [
      frame("reasoning", { text: "weigh it" }),
      frame("delta", { text: "answer" }),
      frame("done", { conversationId: "c1", model: "m", usage: {} }),
    ].join("");
    fetchMock.mockResolvedValue(streamRes([body]));
    const { events, order, calls } = recorder();
    await sendChat({ content: "hi" }, events);
    expect(order).toEqual(["reasoning", "delta", "done"]);
    expect(calls.reasoning[0]).toBe("weigh it");
    expect(calls.delta[0]).toBe("answer");
  });

  test("reassembles a frame split across two stream chunks", async () => {
    // The "done" frame is broken mid-JSON between chunks; the buffer must stitch it.
    const full = frame("delta", { text: "abc" }) + frame("done", { conversationId: "c1", model: "m", usage: {} });
    const mid = Math.floor(full.length / 2);
    fetchMock.mockResolvedValue(streamRes([full.slice(0, mid), full.slice(mid)]));
    const { events, order, calls } = recorder();
    await sendChat({ content: "hi" }, events);
    expect(order).toEqual(["delta", "done"]);
    expect(calls.delta[0]).toBe("abc");
  });

  test("dispatches an error frame to onError as a classified stream error", async () => {
    fetchMock.mockResolvedValue(streamRes([frame("error", { message: "boom" })]));
    const { events, calls } = recorder();
    await sendChat({ content: "hi" }, events);
    expect(calls.error[0]).toEqual({ kind: "stream", serverMessage: "boom" });
  });

  test("skips empty/dataless frames", async () => {
    // A frame with only an event line (no data) is ignored; the comment-only frame too.
    const body = "event: meta\n\n" + ": keepalive comment\n\n" + frame("delta", { text: "x" });
    fetchMock.mockResolvedValue(streamRes([body]));
    const { events, order } = recorder();
    await sendChat({ content: "hi" }, events);
    expect(order).toEqual(["delta"]);
  });

  test("treats a bare data frame (no event line) as the default 'message' event", async () => {
    // event defaults to "message" which matches no branch → nothing dispatched, no throw.
    fetchMock.mockResolvedValue(streamRes([`data: ${JSON.stringify({ x: 1 })}\n\n`]));
    const { events, order } = recorder();
    await expect(sendChat({ content: "hi" }, events)).resolves.toBeNull();
    expect(order).toEqual([]);
  });
});

describe("sendChat — error / no-body branches", () => {
  test("calls onError with the status when not ok", async () => {
    fetchMock.mockResolvedValue(streamRes([], { status: 503 }));
    const { events, calls } = recorder();
    const out = await sendChat({ content: "hi" }, events);
    expect(out).toBeNull();
    expect(calls.error[0]).toEqual({ status: 503 });
  });

  test("calls onError when the response has no body", async () => {
    // A 200 with a null body still has no stream to consume.
    fetchMock.mockResolvedValue(new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const { events, calls } = recorder();
    await sendChat({ content: "hi" }, events);
    expect(calls.error[0]).toEqual({ status: 200 });
  });

  test("a JSON body on a FAILED response is an error envelope, not a CommandResult", async () => {
    // The server returns `c.json({error}, status)` for 429/402/403/500 — a JSON body on a
    // non-ok response must classify to onError (status + serverMessage), NOT return as a command.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "rate limit exceeded -- slow down" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const { events, calls } = recorder();
    const out = await sendChat({ content: "hi" }, events);
    expect(out).toBeNull(); // not returned as a CommandResult
    expect(calls.error[0]).toEqual({ status: 429, serverMessage: "rate limit exceeded -- slow down" });
  });

  test("a JSON 404 error envelope still routes to onNotFound (not onError)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "conversation not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const { events, order } = recorder();
    const out = await sendChat({ content: "hi", conversationId: "gone" }, events);
    expect(out).toBeNull();
    expect(order).toEqual(["notFound"]);
    expect(events.onError).not.toHaveBeenCalled();
  });

  test("a transport 404 fires onNotFound (NOT onError) — the conversation is gone for the caller", async () => {
    fetchMock.mockResolvedValue(streamRes([], { status: 404 }));
    const { events, order, calls } = recorder();
    const out = await sendChat({ content: "hi", conversationId: "gone" }, events);
    expect(out).toBeNull();
    expect(calls.notFound).toEqual([]); // called with no args
    expect(order).toEqual(["notFound"]);
    expect(events.onError).not.toHaveBeenCalled();
  });
});

describe("sendChat — SSE 'conversation not found' error", () => {
  test("the exact 'conversation not found' error frame fires onNotFound, not onError", async () => {
    fetchMock.mockResolvedValue(streamRes([frame("error", { message: "conversation not found" })]));
    const { events, order } = recorder();
    await sendChat({ content: "hi" }, events);
    expect(order).toEqual(["notFound"]);
    expect(events.onError).not.toHaveBeenCalled();
  });

  test("any other error message still goes to onError", async () => {
    fetchMock.mockResolvedValue(streamRes([frame("error", { message: "model exploded" })]));
    const { events, order, calls } = recorder();
    await sendChat({ content: "hi" }, events);
    expect(order).toEqual(["error"]);
    expect(calls.error[0]).toEqual({ kind: "stream", serverMessage: "model exploded" });
    expect(events.onNotFound).not.toHaveBeenCalled();
  });
});

describe("regenerateChat", () => {
  test("POSTs the regenerate endpoint with auth + streams done", async () => {
    localStorage.setItem("a7t_chat_token", "tk");
    fetchMock.mockResolvedValue(
      streamRes([frame("done", { conversationId: "c1", model: "m", usage: {}, variants: [], activeIndex: 0 })]),
    );
    const { events, order } = recorder();
    await regenerateChat("m1", events);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/messages/m1/regenerate");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(authHeaders());
    expect(order).toEqual(["done"]);
  });

  test("surfaces the server error message from a JSON error body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "no slot" }), { status: 409, headers: { "content-type": "application/json" } }),
    );
    const { events, calls } = recorder();
    await regenerateChat("m1", events);
    expect(calls.error[0]).toEqual({ status: 409, serverMessage: "no slot" });
  });

  test("passes status with no serverMessage when the error body is non-JSON", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const { events, calls } = recorder();
    await regenerateChat("m1", events);
    expect(calls.error[0]).toEqual({ status: 500, serverMessage: undefined });
  });

  test("passes status with no serverMessage when the JSON error body has no error field", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ other: 1 }), { status: 500, headers: { "content-type": "application/json" } }),
    );
    const { events, calls } = recorder();
    await regenerateChat("m1", events);
    expect(calls.error[0]).toEqual({ status: 500, serverMessage: undefined });
  });

  test("a 404 fires onNotFound (NOT onError) — the answer's conversation is gone", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const { events, order } = recorder();
    await regenerateChat("m1", events);
    expect(order).toEqual(["notFound"]);
    expect(events.onError).not.toHaveBeenCalled();
  });
});

describe("attachChat", () => {
  test("returns false on 204 (nothing streaming) without dispatching", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { events, order } = recorder();
    const out = await attachChat("c1", events);
    expect(out).toBe(false);
    expect(order).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c1/stream");
  });

  test("returns true and streams when a turn is live", async () => {
    fetchMock.mockResolvedValue(
      streamRes([frame("delta", { text: "resumed" }), frame("done", { conversationId: "c1", model: "m", usage: {} })]),
    );
    const { events, order, calls } = recorder();
    const out = await attachChat("c1", events);
    expect(out).toBe(true);
    expect(order).toEqual(["delta", "done"]);
    expect(calls.delta[0]).toBe("resumed");
  });

  test("returns false + onError when not ok", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const { events, calls } = recorder();
    const out = await attachChat("c1", events);
    expect(out).toBe(false);
    expect(calls.error[0]).toEqual({ status: 500 });
  });

  test("a 404 returns false + fires onNotFound (NOT onError) — the conversation is gone", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const { events, order } = recorder();
    const out = await attachChat("c1", events);
    expect(out).toBe(false);
    expect(order).toEqual(["notFound"]);
    expect(events.onError).not.toHaveBeenCalled();
  });
});

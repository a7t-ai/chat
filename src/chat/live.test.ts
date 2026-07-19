import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  beginLive,
  getLive,
  liveIdsFor,
  type LiveGen,
  stopLive,
  streamLive,
} from "./live.ts";

// The live-generation registry. A turn runs decoupled from the HTTP request that started
// it, streaming into this registry; a (re)connecting client subscribes via streamLive and
// replays whatever has been produced so far. These tests exercise the registry directly
// plus the SSE replay/subscribe path through an in-process Hono app — no network, no Jano.

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
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // leave as the raw string
    }
    frames.push({ event, data });
  }
  return frames;
}

// Mount streamLive behind a tiny app so we can drive it with app.request and read the
// SSE body. The gen is looked up from the registry by conversation id passed in the path.
function streamApp(): Hono {
  const app = new Hono();
  app.get("/stream/:id", (c: Context) => {
    const gen = getLive(c.req.param("id") ?? "");
    if (!gen) return c.body(null, 204);
    return streamLive(c, gen);
  });
  return app;
}

const cid = () => `conv-${Math.random().toString(36).slice(2)}`;
const uid = () => `user-${Math.random().toString(36).slice(2)}`;

// Abort any leftover running generations so a stray setTimeout (GRACE cleanup) can't leak
// across tests.
const created: LiveGen[] = [];
afterEach(() => {
  for (const g of created) {
    if (g.status === "running") g.markAborted();
  }
  created.length = 0;
});
function track(g: LiveGen): LiveGen {
  created.push(g);
  return g;
}

describe("registry: beginLive / getLive / liveIdsFor / stopLive", () => {
  test("beginLive registers a running gen that getLive returns", () => {
    const id = cid();
    const gen = track(beginLive(id, "u1", "qwen-chat"));
    expect(gen.status).toBe("running");
    expect(gen.text).toBe("");
    expect(getLive(id)).toBe(gen);
  });

  test("liveIdsFor returns only this user's running conversations", () => {
    const u = uid();
    const a = track(beginLive(cid(), u, "qwen-chat"));
    const b = track(beginLive(cid(), u, "qwen-chat"));
    track(beginLive(cid(), uid(), "qwen-chat")); // a different user
    const finished = track(beginLive(cid(), u, "qwen-chat"));
    finished.finish({ conversationId: finished.conversationId, model: "qwen-chat" });

    const ids = liveIdsFor(u);
    expect(ids.has(a.conversationId)).toBe(true);
    expect(ids.has(b.conversationId)).toBe(true);
    expect(ids.has(finished.conversationId)).toBe(false); // not running
    expect(ids.size).toBe(2); // other user excluded
  });

  test("stopLive aborts the controller and returns true; wrong user/state returns false", () => {
    const id = cid();
    const gen = track(beginLive(id, "owner", "qwen-chat"));
    expect(stopLive(id, "intruder")).toBe(false); // not the owner
    expect(gen.controller.signal.aborted).toBe(false);
    expect(stopLive(id, "owner")).toBe(true);
    expect(gen.controller.signal.aborted).toBe(true);
    // already aborted (status flips to aborted via markAborted in the runner; here it's
    // still "running" because no runner is attached, so a 2nd stop still "succeeds")
    expect(stopLive("does-not-exist", "owner")).toBe(false);
  });

  test("stopLive on a finished gen returns false", () => {
    const id = cid();
    const gen = track(beginLive(id, "owner", "qwen-chat"));
    gen.finish({ conversationId: id, model: "qwen-chat" });
    expect(stopLive(id, "owner")).toBe(false);
  });
});

describe("gen push* helpers track state + notify listeners", () => {
  test("pushDelta accumulates text and zeroes the queue position", () => {
    const gen = track(beginLive(cid(), "u", "qwen-chat"));
    const seen: string[] = [];
    gen.listeners.add((ev) => {
      if (ev.type === "delta") seen.push(ev.text);
    });
    gen.pushQueue(3);
    expect(gen.queuePosition).toBe(3);
    gen.pushDelta("hel");
    gen.pushDelta("lo");
    expect(gen.text).toBe("hello");
    expect(gen.queuePosition).toBe(0);
    expect(seen).toEqual(["hel", "lo"]);
  });

  test("pushReasoning accumulates thinking apart from the answer text", () => {
    const gen = track(beginLive(cid(), "u", "qwen-chat"));
    const seen: string[] = [];
    gen.listeners.add((ev) => {
      if (ev.type === "reasoning") seen.push(ev.text);
    });
    gen.pushQueue(2);
    gen.pushReasoning("mull ");
    gen.pushReasoning("it over");
    gen.pushDelta("final answer");
    expect(gen.reasoning).toBe("mull it over"); // reasoning buffer
    expect(gen.text).toBe("final answer"); // answer stays clean
    expect(gen.queuePosition).toBe(0);
    expect(seen).toEqual(["mull ", "it over"]);
  });

  test("pushSearch / pushSources buffer the latest stage + sources", () => {
    const gen = track(beginLive(cid(), "u", "qwen-chat"));
    gen.pushSearch({ stage: "searching", queries: ["lisbon"] });
    gen.pushSources([{ n: 1, title: "T", url: "https://x.test", domain: "x.test" }]);
    expect(gen.searchStage).toEqual({ stage: "searching", queries: ["lisbon"] });
    expect(gen.sources).toEqual([{ n: 1, title: "T", url: "https://x.test", domain: "x.test" }]);
  });

  test("finish / fail / markAborted set terminal status + payload", () => {
    const done = track(beginLive(cid(), "u", "qwen-chat"));
    done.finish({ conversationId: done.conversationId, model: "m", messageId: "x" });
    expect(done.status).toBe("done");
    expect(done.donePayload?.messageId).toBe("x");

    const failed = track(beginLive(cid(), "u", "qwen-chat"));
    failed.fail("boom");
    expect(failed.status).toBe("error");
    expect(failed.errorMessage).toBe("boom");

    const aborted = track(beginLive(cid(), "u", "qwen-chat"));
    aborted.markAborted();
    expect(aborted.status).toBe("aborted");
  });
});

describe("streamLive replay + live subscribe (SSE)", () => {
  test("a finished gen replays buffered text + the terminal done frame", async () => {
    const id = cid();
    const gen = track(beginLive(id, "u", "qwen-chat"));
    gen.pushDelta("hello world");
    gen.finish({ conversationId: id, model: "qwen-chat", messageId: "m1", usage: { promptTokens: 5, completionTokens: 2 } });

    const res = await streamApp().request(`/stream/${id}`);
    expect(res.status).toBe(200);
    const frames = await readFrames(res);
    const events = frames.map((f) => f.event);
    expect(events).toEqual(["meta", "delta", "done"]);
    expect(frames[0]?.data).toMatchObject({ conversationId: id, model: "qwen-chat" });
    expect(frames[1]?.data).toMatchObject({ text: "hello world" });
    expect(frames[2]?.data).toMatchObject({ messageId: "m1" });
  });

  test("replays buffered reasoning before the answer delta", async () => {
    const id = cid();
    const gen = track(beginLive(id, "u", "qwen-chat"));
    gen.pushReasoning("thinking hard");
    gen.pushDelta("the answer");
    gen.finish({ conversationId: id, model: "qwen-chat" });

    const frames = await readFrames(await streamApp().request(`/stream/${id}`));
    const events = frames.map((f) => f.event);
    expect(events).toEqual(["meta", "reasoning", "delta", "done"]);
    expect(frames[1]?.data).toMatchObject({ text: "thinking hard" });
    expect(frames[2]?.data).toMatchObject({ text: "the answer" });
  });

  test("replays buffered search stage + sources before the delta", async () => {
    const id = cid();
    const gen = track(beginLive(id, "u", "qwen-chat"));
    gen.pushSearch({ stage: "searching", queries: ["lisbon"] });
    gen.pushSources([{ n: 1, title: "Src", url: "https://s.test", domain: "s.test" }]);
    gen.pushDelta("answer");
    gen.finish({ conversationId: id, model: "qwen-chat" });

    const frames = await readFrames(await streamApp().request(`/stream/${id}`));
    const events = frames.map((f) => f.event);
    expect(events).toEqual(["meta", "search", "sources", "delta", "done"]);
    expect(frames[2]?.data).toMatchObject({ sources: [{ n: 1, title: "Src", url: "https://s.test" }] });
  });

  test("a still-running queued gen (no tokens yet) replays its queue position on subscribe", async () => {
    const id = cid();
    const gen = track(beginLive(id, "u", "qwen-chat"));
    gen.pushQueue(2); // waiting, no delta yet — and still running
    // The queue-position replay only fires for a RUNNING gen with no buffered text, so we
    // subscribe while it's still queued, then finish to terminate the stream.
    const resP = streamApp().request(`/stream/${id}`);
    while (gen.listeners.size === 0) await new Promise((r) => setTimeout(r, 1));
    gen.finish({ conversationId: id, model: "qwen-chat" });

    const frames = await readFrames(await resP);
    const events = frames.map((f) => f.event);
    expect(events[0]).toBe("meta");
    expect(events).toContain("queue");
    expect(frames.find((f) => f.event === "queue")?.data).toMatchObject({ position: 2 });
    expect(events.at(-1)).toBe("done");
  });

  test("a still-running gen streams live deltas pushed after subscribe", async () => {
    const id = cid();
    const gen = track(beginLive(id, "u", "qwen-chat"));
    // Subscribe first: while running, streamLive registers a listener and blocks awaiting
    // new events. Spin until the listener is attached, then push live deltas + finish so the
    // ordering (each delta as its own frame, not a single buffered replay) is observable.
    const resP = streamApp().request(`/stream/${id}`);
    while (gen.listeners.size === 0) await new Promise((r) => setTimeout(r, 1));
    gen.pushDelta("live-1");
    await new Promise((r) => setTimeout(r, 1));
    gen.pushDelta("live-2");
    await new Promise((r) => setTimeout(r, 1));
    gen.finish({ conversationId: id, model: "qwen-chat" });

    const frames = await readFrames(await resP);
    const deltas = frames.filter((f) => f.event === "delta").map((f) => (f.data as { text: string }).text);
    expect(deltas).toEqual(["live-1", "live-2"]);
    expect(frames.at(-1)?.event).toBe("done");
  });

  test("an errored gen replays the error frame", async () => {
    const id = cid();
    const gen = track(beginLive(id, "u", "qwen-chat"));
    gen.fail("upstream exploded");
    const frames = await readFrames(await streamApp().request(`/stream/${id}`));
    expect(frames.at(-1)).toMatchObject({ event: "error", data: { message: "upstream exploded" } });
  });

  test("an aborted gen ends with meta only (no terminal frame)", async () => {
    const id = cid();
    const gen = track(beginLive(id, "u", "qwen-chat"));
    gen.pushDelta("partial");
    gen.markAborted();
    const frames = await readFrames(await streamApp().request(`/stream/${id}`));
    const events = frames.map((f) => f.event);
    expect(events).toEqual(["meta", "delta"]); // replayed text, then the stream just ends
  });
});

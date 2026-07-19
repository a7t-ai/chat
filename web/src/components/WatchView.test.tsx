import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatEvents } from "../lib/chat";
import type { SharedConversation } from "../lib/api";

// WatchView is the public, no-login live watch page. We mock the api snapshot + the share
// stream (no network) and stub the heavy Message/Footer children so the test exercises only
// WatchView's own logic: load → render, not-found, error, and the live stream → reconcile.
const fetchSharedConversation = vi.fn();
const attachShareStream = vi.fn();
const toggleSharedTodo = vi.fn();
vi.mock("../lib/api", () => ({
  fetchSharedConversation: (...a: unknown[]) => fetchSharedConversation(...a),
  toggleSharedTodo: (...a: unknown[]) => toggleSharedTodo(...a),
}));
vi.mock("../lib/share", () => ({
  attachShareStream: (...a: unknown[]) => attachShareStream(...a),
}));
// The Message stub exposes a per-message toggle button so the test can drive WatchView's
// onToggleTodo (index 0, next=true), and an "open map" button that raises a capability payload
// through the REAL CapabilityProvider context (async factory pulls in the actual context hook),
// so the test can prove the shared page's chip→drawer wiring — all without the real
// markdown/checkbox/maplibre pipeline. No button carries text children so other tests can keep
// asserting exact message textContent.
vi.mock("./Message", async () => {
  const { useOpenCapability } = await import("../capabilities/context");
  return {
    Message: ({
      role,
      content,
      onToggleTodo,
    }: {
      role: string;
      content: string;
      onToggleTodo?: (index: number, done: boolean) => void;
    }) => {
      const openCap = useOpenCapability();
      return (
        <div data-testid="msg" data-role={role}>
          {content}
          {onToggleTodo && (
            <button
              type="button"
              aria-label="toggle"
              data-testid={`toggle-${role}`}
              onClick={() => onToggleTodo(0, true)}
            />
          )}
          {role === "assistant" && (
            <button
              type="button"
              aria-label="open map"
              data-testid="open-map"
              onClick={() => openCap("map", "Alfama, Lisbon")}
            />
          )}
        </div>
      );
    },
  };
});
// The capability drawer surface is stubbed to a marker so the wiring test can assert it mounts
// (with the opened cap id + payloads) without loading MapLibre / the real MapCanvas chunk.
vi.mock("../capabilities/surface", () => ({
  CapabilitySurface: ({ capId, requests }: { capId: string; requests: string[] }) => (
    <div data-testid="cap-surface" data-capid={capId}>
      {requests.join("|")}
    </div>
  ),
}));
vi.mock("./Footer", () => ({ Footer: () => <footer data-testid="footer" /> }));

import { WatchView } from "./WatchView";

function snap(over: Partial<SharedConversation> = {}): SharedConversation {
  return {
    conversation: { id: "c1", title: "Trip to Japan" },
    messages: [
      { id: "m1", role: "user", content: "plan a trip", model: null, createdAt: 1 },
      { id: "m2", role: "assistant", content: "here is a plan", model: "qwen", createdAt: 2 },
    ],
    ...over,
  };
}

beforeEach(() => {
  fetchSharedConversation.mockReset().mockResolvedValue(snap());
  attachShareStream.mockReset().mockResolvedValue(false); // nothing generating by default
  toggleSharedTodo.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers(); // some tests below opt into fake timers; always restore
});

describe("WatchView", () => {
  test("loads and renders the shared conversation title + messages", async () => {
    render(<WatchView slug="abc" />);
    expect(await screen.findByText("Trip to Japan")).toBeInTheDocument();
    const msgs = await screen.findAllByTestId("msg");
    expect(msgs.map((m) => m.textContent)).toEqual(["plan a trip", "here is a plan"]);
    expect(fetchSharedConversation).toHaveBeenCalledWith("abc");
    expect(screen.getByText("Shared live via a7t.chat")).toBeInTheDocument();
  });

  test("shows a friendly not-found page for a revoked/unknown link", async () => {
    fetchSharedConversation.mockResolvedValue(null);
    render(<WatchView slug="gone" />);
    expect(await screen.findByText("This share isn't available")).toBeInTheDocument();
    expect(screen.getByTestId("footer")).toBeInTheDocument();
  });

  test("shows an error page when the first load throws", async () => {
    fetchSharedConversation.mockRejectedValue(new Error("network"));
    render(<WatchView slug="x" />);
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
  });

  test("falls back to a default title when the conversation is untitled", async () => {
    fetchSharedConversation.mockResolvedValue(snap({ conversation: { id: "c1", title: null } }));
    render(<WatchView slug="x" />);
    expect(await screen.findByText("Shared chat")).toBeInTheDocument();
  });

  test("streams a live turn, shows the Live badge, then reconciles to the persisted answer", async () => {
    // First snapshot: only the user's question is persisted. The stream delivers the answer.
    const before = snap({
      messages: [{ id: "m1", role: "user", content: "hi", model: null, createdAt: 1 }],
    });
    const after = snap({
      messages: [
        { id: "m1", role: "user", content: "hi", model: null, createdAt: 1 },
        { id: "m2", role: "assistant", content: "hello there", model: "qwen", createdAt: 2 },
      ],
    });
    fetchSharedConversation.mockResolvedValueOnce(before).mockResolvedValue(after);

    let resolveStream: (v: boolean) => void = () => {};
    attachShareStream.mockImplementation((_slug: string, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "qwen" });
      events.onDelta?.("hello ");
      events.onDelta?.("there");
      return new Promise<boolean>((resolve) => {
        resolveStream = resolve;
      });
    });

    render(<WatchView slug="x" />);
    // While streaming: the Live badge is up and the live bubble shows the streamed text.
    expect(await screen.findByText("Live")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByTestId("msg").some((m) => m.textContent === "hello there")).toBe(true);
    });

    // The turn finishes → reconcile to the persisted thread; the Live badge clears.
    resolveStream(true);
    await waitFor(() => expect(screen.queryByText("Live")).not.toBeInTheDocument());
    const msgs = screen.getAllByTestId("msg");
    expect(msgs.map((m) => m.textContent)).toEqual(["hi", "hello there"]);
  });

  test("an onError mid-stream clears the live bubble", async () => {
    attachShareStream.mockImplementation((_slug: string, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "m" });
      events.onError?.({ kind: "stream" });
      return Promise.resolve(true);
    });
    render(<WatchView slug="x" />);
    expect(await screen.findByText("Trip to Japan")).toBeInTheDocument();
    // After the errored stream reconciles, no Live badge lingers.
    await waitFor(() => expect(screen.queryByText("Live")).not.toBeInTheDocument());
  });
});

describe("WatchView — capability drawer wiring (maps)", () => {
  test("opening an inline map chip raises the payload and mounts the capability surface", async () => {
    render(<WatchView slug="x" />);
    // The assistant message's stubbed "open map" button raises [[map:…]] through the provider.
    const opener = await screen.findByTestId("open-map");
    expect(screen.queryByTestId("cap-surface")).not.toBeInTheDocument(); // closed until opened
    fireEvent.click(opener);
    const surface = await screen.findByTestId("cap-surface");
    expect(surface).toHaveAttribute("data-capid", "map");
    expect(surface.textContent).toContain("Alfama, Lisbon"); // the opened payload flows through
  });
});

describe("WatchView — Thinking… watchdog on a read-only page", () => {
  const THINKING_TIMEOUT_MS = 45000;

  test("clears a stuck Thinking bubble when no delta arrives within the window", async () => {
    vi.useFakeTimers();
    // A stale replay: the turn attaches (onMeta → Thinking…) but no delta ever streams and the
    // stream never ends — exactly the hang the watchdog defends against.
    attachShareStream.mockImplementation((_slug: string, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "m" });
      return new Promise<boolean>(() => {});
    });
    render(<WatchView slug="x" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // let the initial tick + onMeta settle
    });
    expect(screen.getByText("Live")).toBeInTheDocument();
    // Just short of the window: the bubble is still up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THINKING_TIMEOUT_MS - 1);
    });
    expect(screen.getByText("Live")).toBeInTheDocument();
    // Cross the window with no delta → the watchdog clears the bubble.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  test("a delta before the window cancels the watchdog and keeps the bubble", async () => {
    vi.useFakeTimers();
    let captured: ChatEvents | null = null;
    attachShareStream.mockImplementation((_slug: string, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "m" });
      captured = events;
      return new Promise<boolean>(() => {});
    });
    render(<WatchView slug="x" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // A real delta lands well within the window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      captured?.onDelta?.("partial answer");
    });
    // Advance past the ORIGINAL window: the watchdog was cancelled, so the bubble persists.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THINKING_TIMEOUT_MS);
    });
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getAllByTestId("msg").some((m) => m.textContent?.includes("partial answer"))).toBe(true);
  });
});

describe("WatchView — persistent TODO completions (#45)", () => {
  function todoSnap(over: Partial<SharedConversation> = {}): SharedConversation {
    return snap({
      writeToken: "wt1",
      messages: [{ id: "m2", role: "assistant", content: "- [ ] eggs", model: "q", createdAt: 2 }],
      ...over,
    });
  }

  test("ticking a TODO posts with the write token and adopts the server's content", async () => {
    fetchSharedConversation.mockResolvedValue(todoSnap());
    toggleSharedTodo.mockResolvedValue("- [x] eggs");
    render(<WatchView slug="x" />);
    const btn = await screen.findByTestId("toggle-assistant");
    fireEvent.click(btn);
    expect(toggleSharedTodo).toHaveBeenCalledWith("x", "wt1", "m2", 0, true);
    await waitFor(() => expect(screen.getByTestId("msg").textContent).toContain("- [x] eggs"));
  });

  test("does not attempt a write when the snapshot carries no token", async () => {
    fetchSharedConversation.mockResolvedValue(todoSnap({ writeToken: null }));
    render(<WatchView slug="x" />);
    const btn = await screen.findByTestId("toggle-assistant");
    fireEvent.click(btn);
    expect(toggleSharedTodo).not.toHaveBeenCalled();
  });

  test("reverts the optimistic tick when the server rejects the write", async () => {
    fetchSharedConversation.mockResolvedValue(todoSnap());
    toggleSharedTodo.mockResolvedValue(null); // rejected (expired token / rate limited / revoked)
    render(<WatchView slug="x" />);
    const btn = await screen.findByTestId("toggle-assistant");
    fireEvent.click(btn);
    // After the rejection resolves, the checkbox is back to its persisted (unticked) state.
    await waitFor(() => expect(screen.getByTestId("msg").textContent).toContain("- [ ] eggs"));
    expect(screen.getByTestId("msg").textContent).not.toContain("- [x] eggs");
  });
});

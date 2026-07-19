import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Stats } from "../lib/admin";

// StatsPanel fetches telemetry on mount via fetchStats(). We mock the admin lib so no
// network is touched, and assert: the loading→loaded transition, the totals/jano/24h/byModel
// sections, the empty-table fallback, the jano-unreachable branch, the error branch,
// and that Refresh re-fetches.
const fetchStats = vi.fn();
vi.mock("../lib/admin", () => ({
  fetchStats: (...a: unknown[]) => fetchStats(...a),
}));

import { StatsPanel } from "./StatsPanel";

function fullStats(over: Partial<Stats> = {}): Stats {
  return {
    totals: { users: 3, conversations: 12, messages: 40, activeKeys: 2, requests: 99, tokensIn: 1000, tokensOut: 2000 },
    last24h: { requests: 7, tokensIn: 100, tokensOut: 200 },
    byModel: [{ model: "qwen", requests: 5, tokensIn: 50, tokensOut: 60 }],
    recent: [],
    backend: {
      models: ["qwen", "mistral"],
      jano: {
        currentModel: "qwen",
        queueDepth: 1,
        inFlight: 0,
        swapsLast15m: 2,
        swapsLastHour: 5,
        recentGenTokS: 42.6,
        errorsLast15m: 0,
        backendHealth: { coder: "ok", chat: "down" },
      },
    },
    ...over,
  };
}

// NB: a block body — `beforeEach(() => fetchStats.mockClear())` would RETURN the mock fn,
// which vitest mis-handles and turns a later rejected-mock test into a false failure. Each
// test sets its own resolve/reject value, so clearing history between tests is enough.
beforeEach(() => {
  fetchStats.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("StatsPanel", () => {
  test("shows loading, then the totals and jano sections", async () => {
    fetchStats.mockResolvedValue(fullStats());
    render(<StatsPanel onClose={() => {}} />);
    expect(screen.getByText("loading…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Users")).toBeInTheDocument());
    expect(screen.getByText("3")).toBeInTheDocument(); // users total
    expect(screen.getByText("Jano (router)")).toBeInTheDocument();
    // "qwen" appears as the jano currentModel stat AND the byModel row.
    expect(screen.getAllByText("qwen").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("43")).toBeInTheDocument(); // rounded recentGenTokS
    // backendHealth line is joined.
    expect(screen.getByText(/coder=ok/)).toBeInTheDocument();
    // backend models joined.
    expect(screen.getByText("qwen, mistral")).toBeInTheDocument();
  });

  test("shows the jano-unreachable note when jano is null", async () => {
    fetchStats.mockResolvedValue(fullStats({ backend: { models: [], jano: null } }));
    render(<StatsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Jano stats not reachable.")).toBeInTheDocument());
    // No backend models → dash (backendModels line).
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  test("renders the empty-table fallback when there is no usage", async () => {
    fetchStats.mockResolvedValue(fullStats({ byModel: [] }));
    render(<StatsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByText("no usage yet").length).toBe(1));
  });

  test("a failed load shows in-voice copy, never the raw thrown string (#42)", async () => {
    fetchStats.mockRejectedValue(new Error("/api/admin/stats -> 500"));
    render(<StatsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Could not load telemetry. Try refreshing.")).toBeInTheDocument());
    // The raw thrown message never reaches the UI.
    expect(screen.queryByText(/api\/admin\/stats/)).not.toBeInTheDocument();
    // Still in loading state for the body (stats never set).
    expect(screen.getByText("loading…")).toBeInTheDocument();
  });

  test("an offline load shows the network message, not a generic one (#42)", async () => {
    fetchStats.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<StatsPanel onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText("Could not reach the server. Check your connection and try again.")).toBeInTheDocument(),
    );
  });

  test("Refresh re-invokes fetchStats", async () => {
    fetchStats.mockResolvedValue(fullStats());
    render(<StatsPanel onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Users")).toBeInTheDocument());
    expect(fetchStats).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetchStats).toHaveBeenCalledTimes(2));
  });

  test("the close button fires onClose", async () => {
    fetchStats.mockResolvedValue(fullStats());
    const onClose = vi.fn();
    render(<StatsPanel onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Users")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, test } from "bun:test";
import {
  CHARS_PER_TOKEN,
  COMPACT_PROMPT_RATIO,
  CONTEXT_METER_MIN_RATIO,
  type CompactTurn,
  compactionState,
  contextUsage,
  estimateTokens,
  estimateTurnsTokens,
  FALLBACK_CONTEXT_WINDOW,
  KEEP_RECENT_TURNS,
  MIN_FOLD_TURNS,
  MODEL_CONTEXT_FALLBACKS,
  PER_MESSAGE_TOKEN_OVERHEAD,
  planCompaction,
  resolveContextWindow,
} from "./compaction.ts";

describe("estimateTokens", () => {
  test("chars/4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1); // ceil(1/4)
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4)
    expect(estimateTokens("x".repeat(4 * CHARS_PER_TOKEN))).toBe(CHARS_PER_TOKEN);
  });

  test("non-string input degrades to 0 (never throws)", () => {
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
    expect(estimateTokens(null as unknown as string)).toBe(0);
  });
});

describe("estimateTurnsTokens", () => {
  test("sums content estimates plus per-message overhead", () => {
    const turns = [{ content: "abcd" }, { content: "abcd" }]; // 1 token each + overhead
    expect(estimateTurnsTokens(turns)).toBe(2 * (1 + PER_MESSAGE_TOKEN_OVERHEAD));
  });

  test("empty set is 0", () => {
    expect(estimateTurnsTokens([])).toBe(0);
  });
});

describe("resolveContextWindow", () => {
  test("prefers the catalog's positive contextTokens", () => {
    expect(resolveContextWindow("qwen-chat", 40000)).toBe(40000);
    expect(resolveContextWindow("anything", 12345.9)).toBe(12345); // floored
  });

  test("falls back to the per-model map when the catalog omits it", () => {
    expect(resolveContextWindow("qwen-chat")).toBe(32768);
    expect(resolveContextWindow("qwen-omni", null)).toBe(32768);
    expect(MODEL_CONTEXT_FALLBACKS["qwen-chat"]).toBe(32768);
  });

  test("unknown model with no catalog value degrades to the conservative fallback", () => {
    expect(resolveContextWindow("mystery/model")).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolveContextWindow("mystery/model", 0)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolveContextWindow("mystery/model", -5)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolveContextWindow("mystery/model", Number.NaN)).toBe(FALLBACK_CONTEXT_WINDOW);
  });
});

describe("compactionState", () => {
  test("ratio + shouldPrompt below/at/above the threshold", () => {
    expect(compactionState(0, 1000)).toEqual({ ratio: 0, shouldPrompt: false });
    expect(compactionState(500, 1000).shouldPrompt).toBe(false); // 0.5 < 0.75
    // exactly at the threshold prompts
    expect(compactionState(750, 1000)).toEqual({ ratio: 0.75, shouldPrompt: true });
    expect(compactionState(900, 1000).shouldPrompt).toBe(true);
  });

  test("ratio clamps to [0,1] for display while shouldPrompt uses the raw overflow", () => {
    const s = compactionState(2000, 1000);
    expect(s.ratio).toBe(1);
    expect(s.shouldPrompt).toBe(true);
  });

  test("honors a custom threshold", () => {
    expect(compactionState(600, 1000, 0.5).shouldPrompt).toBe(true);
    expect(compactionState(600, 1000, 0.9).shouldPrompt).toBe(false);
  });

  test("fail-safe on a non-positive window or negative usage (no NaN, no nag)", () => {
    expect(compactionState(100, 0)).toEqual({ ratio: 0, shouldPrompt: false });
    expect(compactionState(100, -1)).toEqual({ ratio: 0, shouldPrompt: false });
    expect(compactionState(-5, 1000)).toEqual({ ratio: 0, shouldPrompt: false });
  });

  test("the default threshold constant is 0.75", () => {
    expect(COMPACT_PROMPT_RATIO).toBe(0.75);
  });
});

describe("contextUsage", () => {
  test("rolls the decision + raw numbers + meter visibility into one snapshot", () => {
    const u = contextUsage(800, 1000);
    expect(u).toEqual({ usedTokens: 800, windowTokens: 1000, ratio: 0.8, shouldPrompt: true, showMeter: true });
  });

  test("hides the meter below the meter floor", () => {
    const u = contextUsage(100, 1000); // 0.1 < 0.5
    expect(u.showMeter).toBe(false);
    expect(u.shouldPrompt).toBe(false);
  });

  test("shows the meter at the floor but only prompts higher up", () => {
    const u = contextUsage(CONTEXT_METER_MIN_RATIO * 1000, 1000);
    expect(u.showMeter).toBe(true);
    expect(u.shouldPrompt).toBe(false);
  });

  test("rounds used tokens and never reports negative", () => {
    expect(contextUsage(12.4, 1000).usedTokens).toBe(12);
    expect(contextUsage(-3, 1000).usedTokens).toBe(0);
  });
});

describe("planCompaction", () => {
  const turns = (n: number): CompactTurn[] =>
    Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `t${i}` }));

  test("keeps the last KEEP_RECENT_TURNS verbatim and folds the rest", () => {
    const plan = planCompaction(turns(10)); // fold 4, keep 6
    expect(plan).not.toBeNull();
    expect(plan!.foldedCount).toBe(10 - KEEP_RECENT_TURNS);
    // boundary is the id of the LAST folded turn (index foldedCount-1)
    expect(plan!.boundaryId).toBe(`m${10 - KEEP_RECENT_TURNS - 1}`);
  });

  test("returns null when fewer than MIN_FOLD_TURNS would fold", () => {
    // keep 6, so 7 turns folds only 1 (< MIN_FOLD_TURNS) → nothing worth compacting
    expect(planCompaction(turns(KEEP_RECENT_TURNS + MIN_FOLD_TURNS - 1))).toBeNull();
    expect(planCompaction(turns(KEEP_RECENT_TURNS))).toBeNull();
    expect(planCompaction([])).toBeNull();
  });

  test("folds exactly at the MIN_FOLD_TURNS boundary", () => {
    const plan = planCompaction(turns(KEEP_RECENT_TURNS + MIN_FOLD_TURNS));
    expect(plan).not.toBeNull();
    expect(plan!.foldedCount).toBe(MIN_FOLD_TURNS);
  });

  test("honors a custom keepRecent", () => {
    const plan = planCompaction(turns(10), 2); // fold 8, keep 2
    expect(plan!.foldedCount).toBe(8);
    expect(plan!.boundaryId).toBe("m7");
  });

  test("a keepRecent that keeps everything yields null", () => {
    expect(planCompaction(turns(5), 10)).toBeNull();
  });
});

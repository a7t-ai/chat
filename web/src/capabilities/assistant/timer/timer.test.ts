import { describe, expect, test } from "vitest";
import { formatClock, parseDuration, parseTimer } from "./timer";

// The pure timer parser is the load-bearing, regression-prone logic (the UI is a thin shell over
// it), so it's exercised exhaustively — unit forms, compound forms, clock forms, the bare-integer
// shorthand, the clamp, and every reject path.

describe("parseDuration", () => {
  test("single unit tokens", () => {
    expect(parseDuration("20m")).toBe(1200);
    expect(parseDuration("1h")).toBe(3600);
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("45min")).toBe(2700);
    expect(parseDuration("2 hours")).toBe(7200);
    expect(parseDuration("30 seconds")).toBe(30);
  });

  test("compound units sum (1h30m)", () => {
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("1h 30m 15s")).toBe(5415);
    expect(parseDuration("2m30s")).toBe(150);
  });

  test("decimals are supported and rounded to whole seconds", () => {
    expect(parseDuration("1.5h")).toBe(5400);
    expect(parseDuration("0.5m")).toBe(30);
  });

  test("clock form mm:ss and hh:mm:ss", () => {
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("20:00")).toBe(1200);
    expect(parseDuration("1:30:00")).toBe(5400);
    expect(parseDuration("0:05")).toBe(5);
  });

  test("bare integer is taken as minutes", () => {
    expect(parseDuration("20")).toBe(1200);
    expect(parseDuration("5")).toBe(300);
  });

  test("is case- and whitespace-insensitive", () => {
    expect(parseDuration("  1H 30M  ")).toBe(5400);
    expect(parseDuration("2 HOURS")).toBe(7200);
  });

  test("clamps absurd durations to 24h", () => {
    expect(parseDuration("1000h")).toBe(24 * 60 * 60);
    expect(parseDuration("100000")).toBe(24 * 60 * 60); // minutes → way over a day
    expect(parseDuration("99:00:00")).toBe(24 * 60 * 60);
  });

  test("rejects non-durations and zero", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("   ")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("0:00")).toBeNull();
    // Partly-a-duration is rejected — a clean duration has no trailing prose.
    expect(parseDuration("20m of rice")).toBeNull();
  });

  test("clock form rejects out-of-range seconds/minutes fields", () => {
    // "90:00" — the minutes field 90 isn't 0–59, so the clock form fails; it's not a bare
    // integer or a unit run either, so the whole thing is rejected (not silently 90 minutes).
    expect(parseDuration("90:99")).toBeNull();
  });
});

describe("parseTimer", () => {
  test("splits DURATION|LABEL, trimming both sides", () => {
    expect(parseTimer("20m|Simmer")).toEqual({ seconds: 1200, label: "Simmer" });
    expect(parseTimer("  1h30m  |  Bake the cake  ")).toEqual({ seconds: 5400, label: "Bake the cake" });
  });

  test("a pipe with an empty label yields an empty label", () => {
    expect(parseTimer("10m|")).toEqual({ seconds: 600, label: "" });
  });

  test("peels a leading duration when there's no pipe", () => {
    expect(parseTimer("20m Simmer the sauce")).toEqual({ seconds: 1200, label: "Simmer the sauce" });
    expect(parseTimer("1:30 rest")).toEqual({ seconds: 90, label: "rest" });
  });

  test("a bare duration with no label", () => {
    expect(parseTimer("25m")).toEqual({ seconds: 1500, label: "" });
    expect(parseTimer("20")).toEqual({ seconds: 1200, label: "" });
  });

  test("does not mistake a leading number that isn't a duration for one", () => {
    // "20 potatoes" has no unit/colon, so the leading-duration peel declines; the whole payload
    // is then tried as a duration ("20 potatoes" → not clean) → null.
    expect(parseTimer("20 potatoes")).toBeNull();
  });

  test("returns null for an unusable payload (chip then falls back to plain text)", () => {
    expect(parseTimer("")).toBeNull();
    expect(parseTimer("   ")).toBeNull();
    expect(parseTimer("later|Stir")).toBeNull();
  });
});

describe("formatClock", () => {
  test("under an hour → M:SS", () => {
    expect(formatClock(1200)).toBe("20:00");
    expect(formatClock(90)).toBe("1:30");
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(0)).toBe("0:00");
  });

  test("at/over an hour → H:MM:SS with zero-padded minutes", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(5400)).toBe("1:30:00");
    expect(formatClock(3661)).toBe("1:01:01");
  });

  test("negative input floors at zero", () => {
    expect(formatClock(-5)).toBe("0:00");
  });
});

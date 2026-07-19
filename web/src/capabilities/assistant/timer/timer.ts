// Pure parsing + formatting for the cooking-timer capability. Kept dependency-free and
// side-effect-free so it's exhaustively unit-testable — the countdown UI (TimerChip) is a thin
// shell over these. A  [[timer:DURATION|LABEL]]  marker's payload is what parseTimer receives.

export interface ParsedTimer {
  seconds: number; // total duration, clamped to a sane range (>=1, <=24h)
  label: string; // short action shown on the chip ("" when the marker gave none)
}

// A cooking timer beyond a day is a typo (or an attempt to make the tab spin forever) — clamp
// rather than reject, so a slightly-off model output still yields a usable timer.
const MAX_SECONDS = 24 * 60 * 60;

// One unit token: a number (optionally decimal) + a time unit. Global so parseDuration can sum a
// compound like "1h30m". The unit's FIRST letter picks the multiplier (h→3600, m→60, s→1), which
// covers h/hr/hour(s), m/min(s)/minute(s), s/sec(s)/second(s) without listing each separately.
const UNIT_TOKEN = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi;

// mm:ss or hh:mm:ss (digital-timer convention — the smallest field is always seconds). The
// minutes/seconds fields are bounded 0–59 so "90:00" is rejected here and falls to the unit path.
const CLOCK_FORM = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/;

// A leading duration (unit-run or clock form) used to peel a bare "20m simmer" payload that has no
// explicit "|" separator. Requires a unit or a colon — never a lone integer — so a label like
// "20 potatoes" isn't misread as a duration.
const LEADING_DURATION =
  /^((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+|\d+:[0-5]?\d(?::[0-5]?\d)?)/i;

function multiplierFor(unit: string): number {
  const c = unit[0]!.toLowerCase();
  return c === "h" ? 3600 : c === "s" ? 1 : 60;
}

// Parse a duration string ("20m", "1h30m", "90s", "1:30", "1:30:00", or a bare "20" = minutes)
// into whole seconds, or null when it isn't a duration at all. Exported for direct testing.
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const clock = CLOCK_FORM.exec(s);
  if (clock) {
    const a = Number(clock[1]);
    const b = Number(clock[2]);
    const c = clock[3] !== undefined ? Number(clock[3]) : null;
    // Two fields = mm:ss; three = hh:mm:ss.
    const total = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
    return total > 0 ? Math.min(Math.round(total), MAX_SECONDS) : null;
  }

  let total = 0;
  let matched = false;
  UNIT_TOKEN.lastIndex = 0;
  for (let m = UNIT_TOKEN.exec(s); m !== null; m = UNIT_TOKEN.exec(s)) {
    matched = true;
    total += Number(m[1]) * multiplierFor(m[2]!);
  }
  if (matched) {
    // Reject strings that are only PARTLY a duration (e.g. "20m of rice") — the non-duration
    // remainder means this wasn't a clean duration token. Whitespace between units is fine.
    const leftover = s.replace(UNIT_TOKEN, "").replace(/\s+/g, "");
    if (leftover.length > 0) return null;
    return total > 0 ? Math.min(Math.round(total), MAX_SECONDS) : null;
  }

  // A bare integer is taken as minutes — the model sometimes writes "[[timer:20|Bake]]".
  if (/^\d+$/.test(s)) {
    const mins = Number(s);
    return mins > 0 ? Math.min(mins * 60, MAX_SECONDS) : null;
  }
  return null;
}

// Parse a  [[timer:…]]  payload into a duration + label, or null when there's no usable duration
// (the chip then renders the raw payload as plain text, so a malformed marker never breaks the
// message). Primary form is "DURATION|LABEL"; a "|"-less payload is peeled best-effort.
export function parseTimer(payload: string): ParsedTimer | null {
  const raw = payload.trim();
  if (!raw) return null;

  const pipe = raw.indexOf("|");
  let durStr: string;
  let label: string;
  if (pipe >= 0) {
    durStr = raw.slice(0, pipe).trim();
    label = raw.slice(pipe + 1).trim();
  } else {
    const lead = LEADING_DURATION.exec(raw);
    if (lead) {
      durStr = lead[1]!.trim();
      label = raw.slice(lead[0].length).trim();
    } else {
      // No separator and no leading duration — try the whole thing as a duration (e.g. "20").
      durStr = raw;
      label = "";
    }
  }

  const seconds = parseDuration(durStr);
  if (seconds === null) return null;
  return { seconds, label };
}

// Format whole seconds as a countdown clock: "M:SS" under an hour, "H:MM:SS" at/over one hour.
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

// Per-key sliding-window request rate limit — compute-abuse mitigation for the
// publicly-reachable generation endpoint. In-memory; pairs with the per-key
// concurrency cap (1 for guests) and the token budget. A leaked token can burn at
// most maxPerMin requests/minute, not the whole Mac Studio.

const windows = new Map<string, number[]>();

export function allowRequest(id: string, maxPerMin: number, now: number = Date.now()): boolean {
  if (maxPerMin <= 0) return true; // 0 = unlimited
  const cutoff = now - 60_000;
  const recent = (windows.get(id) ?? []).filter((t) => t > cutoff);
  if (recent.length >= maxPerMin) {
    windows.set(id, recent);
    return false;
  }
  recent.push(now);
  windows.set(id, recent);
  return true;
}

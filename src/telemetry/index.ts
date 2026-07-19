import { desc, eq, gte, sql } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { events } from "../db/schema.ts";

// First-party telemetry. LOCAL only (the `events` table) — the autonomous discovery + bug
// finder read it directly. Privacy rule: NEVER pass message content — only event types and
// small safe metadata (capability id, counts, booleans, durations, model ids).

export type TrackInput = {
  type: string;
  userId?: string | null;
  conversationId?: string | null;
  meta?: Record<string, unknown>;
};

// Fire-and-forget. MUST NOT throw into the caller — a telemetry failure can never break a
// request. No-op when telemetry is disabled.
export function track(input: TrackInput): void {
  if (!config.telemetry.enabled) return;
  try {
    db.insert(events)
      .values({
        type: input.type,
        userId: input.userId ?? null,
        conversationId: input.conversationId ?? null,
        meta: input.meta ? JSON.stringify(input.meta) : null,
      })
      .run();
  } catch {
    // swallow — telemetry is best-effort
  }
}

// Convenience for the observability path (bug-finder fuel). `where` is a stable call-site
// tag; the error message is metadata, never user content.
export function trackError(where: string, err: unknown, extra?: Record<string, unknown>): void {
  const message = err instanceof Error ? err.message : String(err);
  track({ type: "error", meta: { where, message, ...extra } });
}

// --- read helpers (for the discovery + bug-finder agents) ---

export type EventRow = typeof events.$inferSelect;

export function recentEvents(opts: { type?: string; limit?: number } = {}): EventRow[] {
  const base = db.select().from(events);
  const filtered = opts.type ? base.where(eq(events.type, opts.type)) : base;
  return filtered.orderBy(desc(events.createdAt)).limit(opts.limit ?? 100).all();
}

// Count events per type since a timestamp (ms) — a cheap usage summary for discovery.
export function eventCounts(sinceMs: number): { type: string; count: number }[] {
  return db
    .select({ type: events.type, count: sql<number>`count(*)` })
    .from(events)
    .where(gte(events.createdAt, new Date(sinceMs)))
    .groupBy(events.type)
    .all();
}

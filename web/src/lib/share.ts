import { type ChatEvents, consumeSSE } from "./chat";

// Public, no-login live watch stream. Subscribes an anonymous watcher to the in-flight
// generation for a shared conversation, replaying buffered text then forwarding deltas to
// completion — the exact meta/delta/done/error protocol the owner's own stream uses (so it
// rides the shared SSE parser in lib/chat). Resolves to false when nothing is generating
// right now (HTTP 204), so the watcher reconciles from the snapshot and polls for the next
// turn. No auth headers: the slug is the capability.
export async function attachShareStream(
  slug: string,
  events: ChatEvents,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await fetch(`/api/share/${encodeURIComponent(slug)}/stream`, { signal });
  if (res.status === 204) return false; // nothing live — caller polls the snapshot
  if (!res.ok || !res.body) return false; // 404 (revoked) or transport hiccup — caller retries
  await consumeSSE(res, events);
  return true;
}

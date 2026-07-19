import { useEffect, useRef, useState } from "react";
import { CapabilityProvider } from "../capabilities/context";
import { CapabilitySurface } from "../capabilities/surface";
import { fetchSharedConversation, type SharedMessage, toggleSharedTodo } from "../lib/api";
import { useT } from "../lib/i18n";
import { attachShareStream } from "../lib/share";
import { setTaskItem } from "../lib/todos";
import { CapabilityErrorPanel } from "./CapabilityErrorPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { Footer } from "./Footer";
import { Message } from "./Message";

// The PUBLIC, no-login live watch page (`/s/{slug}`) — the shareable-live-collab wedge. It
// loads the shared conversation's snapshot, then watches it build in real time: it attaches
// to any in-flight generation (replaying buffered text, then streaming deltas) and re-polls
// the snapshot so a brand-new turn the owner starts appears here without a manual refresh.
// Read-only throughout — there is no composer, no actions, nothing that writes back.

type Status = "loading" | "ready" | "notfound" | "error";

const POLL_MS = 3000;

// Watchdog for the live "Thinking…" bubble. When a turn is attached the bubble shows
// "Thinking…" (live === "") until the first delta lands. On a stale/incomplete replay — the
// snapshot said "generating" but the stream is already dead — no delta ever arrives, so a
// read-only page would sit on "Thinking…" forever. If no delta lands within this window we
// clear the bubble. Generous on purpose: generations run on a single global FIFO GPU queue, so a
// watched turn queued behind others can legitimately exceed a short time-to-first-token — the
// watchdog only exists to clear a truly-dead replay, not to race a slow (but real) queue.
const LIVE_THINKING_TIMEOUT_MS = 45000;

export function WatchView({ slug }: { slug: string }) {
  const t = useT();
  const [status, setStatus] = useState<Status>("loading");
  const [title, setTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  // The in-flight assistant answer, streamed live (null when no turn is generating). Kept
  // separate from the persisted `messages`; once the turn lands, the snapshot refetch folds
  // the real answer into `messages` and this clears.
  const [live, setLive] = useState<string | null>(null);
  // The temporary, write-scoped token that authorizes ticking a TODO (#45), refreshed on every
  // snapshot poll. Held in a ref so the toggle handler always sends the latest without being
  // re-created; null until the first snapshot lands (no token → checkboxes stay read-only).
  const writeTokenRef = useRef<string | null>(null);

  // One watch cycle at a time (a long stream must not overlap the next poll), and a teardown
  // flag so late async resolutions don't write into an unmounted view.
  const busyRef = useRef(false);
  const doneRef = useRef(false);

  // Capability canvas drawer (maps, …), mirrored from ChatView so the shared page's inline map
  // chips and the "Show all N places on the map" bulk button actually open the MapCanvas drawer.
  // Maps is a free, untiered capability, and the drawer only READS (geocode + tiles), so it's
  // fully usable by a no-login watcher. State only: which surface is open + the payloads its
  // chips raised this session (newest last, deduped). No persistence — a public watch page is
  // ephemeral, and the client geocode cache re-pins on its own.
  const [activeCap, setActiveCap] = useState<string | null>(null);
  const [capRequests, setCapRequests] = useState<Record<string, string[]>>({});
  function openCapability(id: string, payload: string) {
    setCapRequests((prev) => {
      const list = prev[id] ?? [];
      if (list.includes(payload)) return prev;
      return { ...prev, [id]: [...list, payload] };
    });
    setActiveCap(id);
  }

  // "Thinking…" watchdog: while a turn is attached but no delta has arrived (live === ""), arm a
  // timer that clears the bubble if it never streams. A real delta makes `live` non-empty and
  // onDone/onError makes it null — either way this effect re-runs and the cleanup cancels the
  // pending timer, so a genuinely-live turn is never cut short. Unmount cleans it up too.
  useEffect(() => {
    if (live !== "") return;
    const id = setTimeout(() => setLive((cur) => (cur === "" ? null : cur)), LIVE_THINKING_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [live]);

  // Tick/untick a TODO on a shared message. Optimistic: flip the checkbox locally at once, then
  // confirm with the server and adopt its authoritative content (or revert on any rejection —
  // expired token, rate limit, revoked link). The 3s poll reconciles remote viewers' ticks.
  async function handleToggle(messageId: string, index: number, done: boolean) {
    const token = writeTokenRef.current;
    if (!token) return;
    let previous: string | undefined;
    setMessages((cur) =>
      cur.map((m) => {
        if (m.id !== messageId) return m;
        previous = m.content;
        const next = setTaskItem(m.content, index, done);
        return next === null ? m : { ...m, content: next };
      }),
    );
    const serverContent = await toggleSharedTodo(slug, token, messageId, index, done);
    if (doneRef.current) return;
    setMessages((cur) =>
      cur.map((m) => (m.id === messageId ? { ...m, content: serverContent ?? previous ?? m.content } : m)),
    );
  }

  useEffect(() => {
    doneRef.current = false;
    const controller = new AbortController();

    async function tick() {
      if (busyRef.current || doneRef.current) return;
      busyRef.current = true;
      try {
        const snap = await fetchSharedConversation(slug);
        if (doneRef.current) return;
        if (snap === null) {
          setStatus("notfound");
          doneRef.current = true; // a revoked/unknown slug is terminal — stop polling it
          return;
        }
        setTitle(snap.conversation.title);
        setMessages(snap.messages);
        writeTokenRef.current = snap.writeToken ?? null;
        setStatus("ready");

        // Attach to any live turn. Deltas grow the `live` bubble; when it ends we reconcile
        // the snapshot so the persisted answer replaces the streamed text.
        const streamed = await attachShareStream(
          slug,
          {
            onMeta: () => setLive(""),
            onDelta: (text) => setLive((cur) => (cur ?? "") + text),
            onDone: () => setLive(null),
            onError: () => setLive(null),
          },
          controller.signal,
        );
        if (streamed && !doneRef.current) {
          const after = await fetchSharedConversation(slug).catch(() => undefined);
          if (after && !doneRef.current) {
            setTitle(after.conversation.title);
            setMessages(after.messages);
            writeTokenRef.current = after.writeToken ?? null;
          }
          if (!doneRef.current) setLive(null);
        }
      } catch {
        // Only the very first load surfaces an error screen; a transient poll failure leaves
        // the already-rendered conversation in place and retries on the next tick.
        if (!doneRef.current) setStatus((s) => (s === "loading" ? "error" : s));
      } finally {
        busyRef.current = false;
      }
    }

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      doneRef.current = true;
      clearInterval(id);
      controller.abort();
    };
  }, [slug]);

  if (status === "loading") {
    return (
      <main className="watch-page">
        <p className="muted" role="status">{t("watch.loading")}</p>
      </main>
    );
  }

  if (status === "notfound" || status === "error") {
    const isNotFound = status === "notfound";
    return (
      <main className="watch-page doc-page">
        <article className="doc">
          <h1>{t(isNotFound ? "watch.notFoundTitle" : "watch.errorTitle")}</h1>
          <p>{t(isNotFound ? "watch.notFoundBody" : "watch.errorBody")}</p>
          <p>
            <a href="/">← {t("watch.cta")}</a>
          </p>
        </article>
        <Footer />
      </main>
    );
  }

  return (
    <CapabilityProvider value={openCapability}>
    <main className="watch-page">
      <header className="watch-header">
        <a className="brand" href="/" aria-label={t("watch.cta")} title={t("watch.cta")}>
          <img src="/icon-mark-light.svg" alt="a7t.chat" className="brand-icon brand-icon-dark" />
          <img src="/icon-mark.svg" alt="a7t.chat" className="brand-icon brand-icon-light" />
        </a>
        <div className="watch-meta">
          <span className="watch-title">{title || t("watch.untitled")}</span>
          <span className="watch-tagline muted">{t("watch.tagline")}</span>
        </div>
        {live !== null && (
          <span className="watch-live" role="status" aria-live="polite">
            <span className="watch-live-dot" aria-hidden="true" />
            {t("watch.live")}
          </span>
        )}
        <a className="btn primary small watch-cta" href="/">
          {t("watch.cta")}
        </a>
      </header>
      <div className="messages watch-messages">
        {messages.map((m) => (
          <Message
            key={m.id}
            role={m.role}
            content={m.content}
            onToggleTodo={(index, done) => handleToggle(m.id, index, done)}
          />
        ))}
        {live !== null && <Message role="assistant" content={live} inFlight />}
      </div>
      {/* The capability canvas drawer (map pins) — opened by an inline chip or the bulk button,
          rendered read-only for the public watcher. */}
      {activeCap && (
        // Contain a drawer throw to a compact panel instead of blanking the public page.
        <ErrorBoundary fallback={<CapabilityErrorPanel onClose={() => setActiveCap(null)} />}>
          <CapabilitySurface capId={activeCap} requests={capRequests[activeCap] ?? []} onClose={() => setActiveCap(null)} />
        </ErrorBoundary>
      )}
    </main>
    </CapabilityProvider>
  );
}

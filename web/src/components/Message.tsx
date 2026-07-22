import {
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  GitBranch,
  Globe,
  MapPin,
  Paperclip,
  Pencil,
  Play,
  RefreshCw,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
} from "lucide-react";
import { createContext, isValidElement, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import remarkGfm from "remark-gfm";
import { Streamdown } from "streamdown";
import { useOpenCapability } from "../capabilities/context";
import { CapabilityMarker } from "../capabilities/marker";
import { capabilityById } from "../capabilities/registry";
import { decodeCapability, extractMarkers, remarkCapabilities } from "../capabilities/remark";
import type { MessageAttachment, Source } from "../lib/api";
import type { SearchStage } from "../lib/chat";
import { localeTag, useLang, useT } from "../lib/i18n";
import { stripIncompleteMarkdownTail } from "../lib/markdown";
import { cancelSpeech, speak } from "../lib/speech";
import { taskItemStates } from "../lib/todos";
import { CodeBlock } from "./CodeBlock";
import { formatBytes } from "./FilesPanel";
import { TableBlock } from "./TableBlock";

// Flatten React children of a <code> element back into the raw source string.
function childrenToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childrenToText).join("");
  if (isValidElement(node)) return childrenToText((node.props as { children?: ReactNode }).children);
  return "";
}

// Bare URLs (http/https or a leading www.) typed inside a user message.
const URL_RE = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

// Turn bare URLs in a plain-text user message into clickable <a> links, leaving
// the surrounding text (and its whitespace) untouched so pre-wrap still applies.
function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  URL_RE.lastIndex = 0;
  for (let match = URL_RE.exec(text); match !== null; match = URL_RE.exec(text)) {
    const raw = match[0];
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    // Don't swallow trailing punctuation (e.g. a period ending the sentence) into the link.
    const url = raw.replace(/[.,;:!?)\]}'"]+$/, "");
    const href = url.startsWith("http") ? url : `https://${url}`;
    nodes.push(
      <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    if (url.length < raw.length) nodes.push(raw.slice(url.length));
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

// Render fenced code blocks and tables with our own toolbar (see ./blocks) instead
// of streamdown's default controls, which are disabled via `controls` below.
const MD_COMPONENTS = {
  pre: ({ children }: { children?: ReactNode }) => {
    const codeEl = Array.isArray(children) ? children[0] : children;
    if (!isValidElement(codeEl)) return <pre>{children}</pre>;
    const props = codeEl.props as { className?: string; children?: ReactNode };
    const language = /language-([\w-]+)/.exec(props.className ?? "")?.[1] ?? "";
    const code = childrenToText(props.children).replace(/\n$/, "");
    return <CodeBlock code={code} language={language} />;
  },
  table: ({ children }: { children?: ReactNode }) => <TableBlock>{children}</TableBlock>,
  // Capability markers [[id:payload]] arrive (via the remark plugin) as a <span> whose
  // text encodes the marker — decode it into the inline chip; pass other spans through.
  span: ({ children, node, ...rest }: { children?: ReactNode; node?: unknown }) => {
    const cap = decodeCapability(childrenToText(children));
    if (cap) return <CapabilityMarker capId={cap.id} payload={cap.payload} />;
    return <span {...rest}>{children}</span>;
  },
};

// The `remarkPlugins` prop REPLACES streamdown's default list (whose only feature plugin
// is remark-gfm), so we must re-include gfm ourselves or tables/strikethrough silently
// stop rendering. Order: gfm first, then our capability marker plugin.
const MD_REMARK = [remarkGfm, remarkCapabilities];

// Reasoning (#68) renders with GFM only — deliberately WITHOUT the capability-marker plugin: a
// model's chain-of-thought is behind-the-scenes text, never an interactive chip / todo surface.
const REASONING_REMARK = [remarkGfm];

// Suppress streamdown's built-in code/table toolbars; we render our own (above).
const MD_CONTROLS = { code: false, table: false } as const;

// Live checked-state of every interactive task-list checkbox, keyed by 0-based ordinal. Provided by
// Message from the message content and read by each TodoCheckbox. This is the fix for a ticked box
// not repainting until a refresh (#138): streamdown memoizes an already-rendered block and WON'T
// re-render it for a same-length `[ ]`↔`[x]` flip, so its cached checkbox keeps the pre-click
// state. A React context bypasses that memo entirely — React.memo never blocks context propagation
// — so flipping the state here repaints ONLY the subscribed checkbox, leaving the block (and any
// running TimerChip co-located in the same recipe message) mounted and untouched.
// Exported so a unit test can drive a checkbox's checked state the way Message's own Provider does.
export const TodoCheckedContext = createContext<readonly boolean[]>([]);
// Stable empty value for the read-only path (no interactive toggling), so the Provider never churns.
const NO_TODO_STATES: readonly boolean[] = [];

// An enabled, controlled task-list checkbox that reads its checked state from TodoCheckedContext by
// ordinal (not from streamdown's cached parse). Its click reports the ordinal + the next state.
function TodoCheckbox({ index, onToggle }: { index: number; onToggle: (index: number, done: boolean) => void }) {
  const checked = !!useContext(TodoCheckedContext)[index];
  return (
    <input
      type="checkbox"
      className="todo-check"
      checked={checked}
      onChange={() => onToggle(index, !checked)}
    />
  );
}

// Status shown while the assistant reply is still computing: the animated a7t
// mark (three pulsing teal bars) beside the "Thinking…" verb.
function ThinkingVerb() {
  const t = useT();
  return (
    <span className="thinking" aria-label={t("message.thinking")}>
      <svg className="thinking-mark" viewBox="0 0 100 100" width="22" height="22" aria-hidden="true">
        <rect className="tb tb1" x="26" y="30" width="48" height="8" rx="4" />
        <rect className="tb tb2" x="26" y="46" width="40" height="8" rx="4" />
        <rect className="tb tb3" x="34" y="62" width="30" height="8" rx="4" />
      </svg>
      <span className="thinking-verb">{t("message.thinking")}</span>
    </span>
  );
}

// Message-action row glyphs: inline 16px Lucide, one stroke weight across the app.
const ICONS = {
  copy: <Copy size={16} strokeWidth={1.75} aria-hidden="true" />,
  check: <Check size={16} strokeWidth={1.75} aria-hidden="true" />,
  speak: <Volume2 size={16} strokeWidth={1.75} aria-hidden="true" />,
  up: <ThumbsUp size={16} strokeWidth={1.75} aria-hidden="true" />,
  down: <ThumbsDown size={16} strokeWidth={1.75} aria-hidden="true" />,
  stop: <Square size={16} strokeWidth={1.75} aria-hidden="true" />,
  retry: <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />,
  branch: <GitBranch size={16} strokeWidth={1.75} aria-hidden="true" />,
  resume: <Play size={16} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />,
  edit: <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />,
  chevLeft: <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />,
  chevRight: <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />,
};

// "Jun 14" — short date label shown beside the user's own messages, formatted in the
// active locale (e.g. "14 de jun." in pt-BR).
function formatDate(ts: number, tag: string): string {
  return new Date(ts).toLocaleDateString(tag, { month: "short", day: "numeric" });
}

// The in-flight status shown in the message body: the queue position while waiting, or
// the thinking indicator once it's this turn's slot.
function QueueIndicator({ position }: { position?: number }) {
  const t = useT();
  if (position && position >= 1) {
    return (
      <span className="queue-status" aria-live="polite">
        {t("chat.queuedPosition", { n: String(position) })}
      </span>
    );
  }
  return <ThinkingVerb />;
}

// The files a user message carried into its turn (files-to-prompt, #128), rendered read-only under
// the message. Historical + cross-viewer safe: a plain labeled chip (name + size), never a live
// thumbnail or download link (the file bytes are scoped to the prompter, so a collaborator viewing
// the thread couldn't fetch them anyway). The live pre-send gallery in the composer still shows
// image previews; this is the persisted record.
function Attachments({ items }: { items: MessageAttachment[] }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <ul className="msg-attachments" aria-label={t("message.attachments")}>
      {items.map((a) => (
        <li key={a.id} className="msg-attachment">
          <span className="msg-attachment-thumb" aria-hidden="true">
            <Paperclip size={14} strokeWidth={1.75} />
          </span>
          <span className="msg-attachment-meta">
            <span className="msg-attachment-name" title={a.name}>
              {a.name}
            </span>
            <span className="msg-attachment-sub muted">{formatBytes(a.size)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// A small globe used for the search status + sources header.
const GLOBE = <Globe size={16} strokeWidth={1.75} aria-hidden="true" />;

// Live status during the web-search ("Research") phase: searching, then reading sources.
// Shown in place of the thinking indicator while the answer is still being retrieved.
function SearchStatus({ search }: { search: SearchStage }) {
  const t = useT();
  const text =
    search.stage === "searching"
      ? t("search.searching")
      : search.stage === "reading"
        ? t("search.reading", { n: String(search.count) })
        : t("search.error");
  return (
    <span className="search-status" aria-live="polite">
      <span className="search-status-globe">{GLOBE}</span>
      <span className="search-status-text">{text}</span>
    </span>
  );
}

// The cited web sources used for a search-augmented answer. Numbered to match the inline
// [n] citations; each chip links out. No favicons are fetched — nothing external loads
// until the user clicks, keeping with the app's no-leak posture.
function Sources({ sources }: { sources: Source[] }) {
  const t = useT();
  if (sources.length === 0) return null;
  return (
    <div className="sources">
      <div className="sources-label">
        <span className="sources-globe">{GLOBE}</span>
        {t("search.sources", { n: String(sources.length) })}
      </div>
      <div className="sources-list">
        {sources.map((s) => (
          <a
            key={s.n}
            className="source-chip"
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`${s.title} — ${s.url}`}
          >
            <span className="source-n">{s.n}</span>
            <span className="source-title">{s.title}</span>
            <span className="source-domain muted">{s.domain}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

// The model's thinking (#68): a COLLAPSED-by-default disclosure shown above the answer, visually
// distinct (muted, bordered) from the final reply and expandable for power users. Only reasoning
// models emit this, so a non-reasoning reply carries no `reasoning` and no toggle appears at all
// (the graceful degradation the #63 catalog gate calls for). `streaming` marks the still-generating
// turn so the header can show a subtle live pulse. Rendered with plain GFM — never capability chips.
function Reasoning({ text, streaming }: { text: string; streaming?: boolean }) {
  const t = useT();
  if (!text) return null;
  return (
    <details className="reasoning">
      <summary className="reasoning-summary">
        <Brain size={15} strokeWidth={1.75} aria-hidden="true" />
        <span className="reasoning-label">{t("message.reasoning")}</span>
        {streaming && <span className="reasoning-live" aria-hidden="true" />}
      </summary>
      <div className="reasoning-body">
        <Streamdown controls={MD_CONTROLS} remarkPlugins={REASONING_REMARK}>
          {text}
        </Streamdown>
      </div>
    </details>
  );
}

export function Message({
  role,
  content,
  reasoning,
  id,
  anchorId,
  vote = 0,
  createdAt,
  stopped,
  variantCount,
  variantIndex = 0,
  attachments,
  inFlight,
  queuePosition,
  search,
  sources,
  onVote,
  onRetry,
  onEdit,
  onContinue,
  onBranch,
  onVariantPrev,
  onVariantNext,
  onToggleTodo,
}: {
  role: string;
  content: string;
  // The model's thinking for an assistant reply (#68), shown in a collapsed "Reasoning" disclosure
  // above the answer. Absent on user/system rows and on non-reasoning replies (no section renders).
  reasoning?: string;
  id?: string;
  // Stable per-row index the conversation minimap targets to scroll this message into
  // view (rendered as data-mm-index). Distinct from `id` (the server message id), which
  // is absent for the in-flight/streaming row and for system notes.
  anchorId?: number;
  vote?: number;
  createdAt?: number;
  stopped?: boolean;
  variantCount?: number;
  variantIndex?: number;
  // Files the user attached to this message (files-to-prompt, #128) — rendered read-only under a
  // user message. Absent on assistant/system rows and on messages sent without attachments.
  attachments?: MessageAttachment[];
  // This is the live, still-generating turn (queued, thinking, or streaming).
  inFlight?: boolean;
  // Live queue position on the in-flight turn (n>=1 waiting, 0 generating).
  queuePosition?: number;
  // Web-search ("Research") progress for the in-flight turn, then its cited sources.
  search?: SearchStage;
  sources?: Source[];
  onVote?: (id: string, vote: number) => void;
  onRetry?: () => void;
  onEdit?: () => void;
  onContinue?: () => void;
  // Branch this message into a new chat (#72): fork the thread here, carrying context up to this
  // point. Wired only for persisted messages the caller owns; absent for watchers, ghost/in-flight
  // rows, and system notes. Shown on both user and assistant messages.
  onBranch?: () => void;
  onVariantPrev?: () => void;
  onVariantNext?: () => void;
  // Shared-page TODO completions (#45): when set, this message's task-list checkboxes render
  // interactive and a click reports (item index, next state). Only the public watch page wires
  // it; everywhere else checkboxes render read-only (streamdown's default). The index is the
  // 0-based ordinal of the checkbox within THIS message's content.
  onToggleTodo?: (index: number, done: boolean) => void;
}) {
  const t = useT();
  const lang = useLang();
  const openCap = useOpenCapability();
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  // Per-render ordinal counter for interactive task-list checkboxes. Reset at the top of each
  // render (below), then incremented once per checkbox as streamdown renders this message's
  // markdown in document order — so the click handler learns which item it toggled. The ref is
  // per Message instance, so sibling messages never share a counter.
  const todoCounter = useRef(0);
  todoCounter.current = 0;
  const mdComponents = useMemo(() => {
    if (!onToggleTodo) return MD_COMPONENTS;
    const onToggle = onToggleTodo;
    return {
      ...MD_COMPONENTS,
      // streamdown renders GFM task items as <input type="checkbox" disabled>; override it with an
      // enabled, controlled checkbox that reads its state from TodoCheckedContext by ordinal. We
      // deliberately IGNORE streamdown's own `checked` (its memoized block won't re-render for a
      // same-length flip — #138); the context is the live source of truth and repaints on toggle.
      input: ({ type, checked, node, ...rest }: { type?: string; checked?: boolean; node?: unknown }) => {
        if (type === "checkbox") return <TodoCheckbox index={todoCounter.current++} onToggle={onToggle} />;
        return <input type={type} {...rest} />;
      },
    };
  }, [onToggleTodo]);

  // The checked state each interactive checkbox reads, derived from the current content in the same
  // document order streamdown renders them. Recomputed on every content change (the optimistic flip
  // AND the server reconciliation) so a toggle repaints immediately, with no refetch/poll.
  const checkedStates = useMemo(
    () => (onToggleTodo ? taskItemStates(content) : NO_TODO_STATES),
    [onToggleTodo, content],
  );

  // Bulk "open all" actions: when this reply names >=2 places of a capability (a trip
  // itinerary), offer one button that opens them all at once instead of clicking each.
  const bulkActions = useMemo(() => {
    if (role !== "assistant" || !content) return [];
    const byId = new Map<string, string[]>();
    for (const m of extractMarkers(content)) {
      const arr = byId.get(m.id) ?? [];
      arr.push(m.payload);
      byId.set(m.id, arr);
    }
    const actions: { id: string; label: string; payloads: string[] }[] = [];
    for (const [id, payloads] of byId) {
      const cap = capabilityById(id);
      if (cap?.Surface && cap.bulkActionLabel && payloads.length >= 2) {
        actions.push({ id, label: cap.bulkActionLabel(payloads.length), payloads });
      }
    }
    return actions;
  }, [role, content]);

  if (role === "system")
    return (
      <div className="msg system" data-mm-index={anchorId}>
        {content}
      </div>
    );

  const isAssistant = role === "assistant";
  // Show the ◀ n/m ▶ navigator once an answer has been regenerated at least once.
  const hasVariants = isAssistant && (variantCount ?? 0) > 1;

  async function copy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  // Toggle playback: start speaking, or stop if this message is already mid-playback. Rides the
  // shared speech helper (also used by Voice mode, #70) so both read-aloud paths behave alike.
  function toggleSpeak() {
    if (speaking) {
      cancelSpeech();
      setSpeaking(false);
      return;
    }
    setSpeaking(speak(content, { onEnd: () => setSpeaking(false) }));
  }

  return (
    <div className={`msg ${role}`} data-mm-index={anchorId}>
      <div className="msg-body">
        {/* The model's thinking (#68) sits above the answer, collapsed by default. Rendered
            whenever this reply carries reasoning — even while the answer is still streaming. */}
        {isAssistant && reasoning ? <Reasoning text={reasoning} streaming={inFlight} /> : null}
        {isAssistant ? (
          content ? (
            <TodoCheckedContext.Provider value={checkedStates}>
              <Streamdown components={mdComponents} controls={MD_CONTROLS} remarkPlugins={MD_REMARK}>
                {/* A completed reply is final: strip any dangling incomplete-link/marker tail so
                    streamdown's streaming completion never leaves a raw `streamdown:incomplete-link`
                    placeholder on a truncated stored message. The still-streaming bubble keeps its
                    raw text so a mid-stream link completes cleanly as tokens arrive. */}
                {inFlight ? content : stripIncompleteMarkdownTail(content)}
              </Streamdown>
            </TodoCheckedContext.Provider>
          ) : stopped ? null : search && !(sources && sources.length > 0) ? (
            // Web-search phase runs before generation: show its live status in place of the
            // thinking/queue indicator until sources resolve and tokens start arriving.
            <SearchStatus search={search} />
          ) : (
            <QueueIndicator position={queuePosition} />
          )
        ) : (
          <div className="plain">{linkify(content)}</div>
        )}
      </div>
      {/* Files the user attached to this message (files-to-prompt, #128), under the bubble. */}
      {!isAssistant && attachments && attachments.length > 0 && <Attachments items={attachments} />}
      {/* Cited web sources sit between the answer and its action row. */}
      {isAssistant && sources && sources.length > 0 && <Sources sources={sources} />}
      {bulkActions.map((a) => (
        <button key={a.id} type="button" className="cap-bulk" onClick={() => a.payloads.forEach((p) => openCap(a.id, p))}>
          <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
          {a.label}
        </button>
      ))}
      {/* An aborted turn (often an accidental Stop) reads as a plain note plus a
          one-tap Continue to pick the answer back up, rather than a bare "Stopped". */}
      {isAssistant && stopped && (
        <div className="stopped-notice">
          <span className="stopped-text">{t("message.stoppedNotice")}</span>
          {onContinue && (
            <button
              type="button"
              className="act stopped-continue"
              onClick={onContinue}
              title={t("message.continueResponse")}
              aria-label={t("message.continueResponse")}
            >
              {ICONS.resume}
              <span>{t("message.continue")}</span>
            </button>
          )}
        </div>
      )}
      {isAssistant && (hasVariants || (content && id)) && (
        <div className="msg-actions">
          {content && id && (
            <>
              <button className="act" onClick={copy} title={t("common.copy")} aria-label={t("common.copy")}>
                {copied ? ICONS.check : ICONS.copy}
              </button>
              <button
                className={`act ${speaking ? "on" : ""}`}
                onClick={toggleSpeak}
                title={speaking ? t("message.stop") : t("message.speak")}
                aria-label={speaking ? t("message.stop") : t("message.speak")}
              >
                {speaking ? ICONS.stop : ICONS.speak}
              </button>
              <button
                className={`act ${vote === 1 ? "on" : ""}`}
                onClick={() => onVote?.(id, vote === 1 ? 0 : 1)}
                title={t("message.goodReply")}
                aria-label={t("message.goodReply")}
              >
                {ICONS.up}
              </button>
              <button
                className={`act ${vote === -1 ? "on" : ""}`}
                onClick={() => onVote?.(id, vote === -1 ? 0 : -1)}
                title={t("message.badReply")}
                aria-label={t("message.badReply")}
              >
                {ICONS.down}
              </button>
              {onRetry && (
                <button className="act" onClick={onRetry} title={t("message.retry")} aria-label={t("message.retry")}>
                  {ICONS.retry}
                </button>
              )}
              {onBranch && (
                <button className="act" onClick={onBranch} title={t("message.branch")} aria-label={t("message.branch")}>
                  {ICONS.branch}
                </button>
              )}
            </>
          )}
          {/* Pinned to the right of the row so it never crowds the actions above. */}
          {hasVariants && (
            <div className="variant-nav">
              <button
                className="act"
                onClick={onVariantPrev}
                disabled={variantIndex <= 0 || !id}
                title={t("message.previousAnswer")}
                aria-label={t("message.previousAnswer")}
              >
                {ICONS.chevLeft}
              </button>
              <span className="variant-count">
                {variantIndex + 1}/{variantCount}
              </span>
              <button
                className="act"
                onClick={onVariantNext}
                disabled={variantIndex >= (variantCount ?? 1) - 1 || !id}
                title={t("message.nextAnswer")}
                aria-label={t("message.nextAnswer")}
              >
                {ICONS.chevRight}
              </button>
            </div>
          )}
        </div>
      )}
      {!isAssistant && content && (
        <div className="msg-actions">
          {createdAt != null && <span className="act-date muted">{formatDate(createdAt, localeTag(lang))}</span>}
          {onRetry && (
            <button className="act" onClick={onRetry} title={t("message.retry")} aria-label={t("message.retry")}>
              {ICONS.retry}
            </button>
          )}
          {onEdit && (
            <button className="act" onClick={onEdit} title={t("common.edit")} aria-label={t("common.edit")}>
              {ICONS.edit}
            </button>
          )}
          {onBranch && (
            <button className="act" onClick={onBranch} title={t("message.branch")} aria-label={t("message.branch")}>
              {ICONS.branch}
            </button>
          )}
          <button className="act" onClick={copy} title={t("common.copy")} aria-label={t("common.copy")}>
            {copied ? ICONS.check : ICONS.copy}
          </button>
        </div>
      )}
    </div>
  );
}

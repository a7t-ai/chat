import {
  ArrowUp,
  AudioLines,
  the workstation,
  Globe,
  ListTree,
  Menu,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Search,
  Square,
  SquarePen,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type ApiMessage,
  branchConversation,
  cancelGeneration,
  canEditContentIn,
  canPromptIn,
  type CatalogModel,
  compactConversation,
  type ContextUsage,
  type ConversationAccessRole,
  type ConversationMeta,
  deleteConversation,
  dismissRecap,
  fetchConversation,
  fetchConversations,
  fetchModelCatalog,
  fetchModels,
  fetchRecap,
  generateConversationTitle,
  type Me,
  type MessageAttachment,
  type Recap,
  renameConversation,
  selectVariant,
  setConversationStarred,
  type Source,
  toggleConversationTodo,
  transcribe,
  voteMessage,
} from "../lib/api";
import { CapabilityProvider } from "../capabilities/context";
import { CapabilitySurface } from "../capabilities/surface";
import { CapabilityErrorPanel } from "./CapabilityErrorPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { type Attachment, dragHasFiles, filesFromDataTransfer, MAX_ATTACHMENTS, modelAcceptsAttachments, useAttachments } from "../lib/attachments";
import { attachChat, regenerateChat, type SearchStage, sendChat } from "../lib/chat";
import {
  applyDictationEvent,
  commitInterim,
  type DictationSession,
  dictationSupported,
  initTranscript,
  renderTranscript,
  streamDictation,
  type TranscriptState,
} from "../lib/dictation";
import { errorKey, isNetworkError } from "../lib/errors";
import { LOCALES, type MessageKey, setLang, type TFunc, useT } from "../lib/i18n";
import { usePreferences } from "../lib/preferences";
import { useRecapRunner } from "../lib/useRecapRunner";
import { useVoiceLoop } from "../lib/useVoiceLoop";
import { type VoiceState, voiceActionKey, voiceStatusKey } from "../lib/voiceLoop";
import { getBindings, isRecording, matchBinding, type ShortcutAction } from "../lib/keybindings";
import { buildMinimap, shouldShowMinimap } from "../lib/minimap";
import { currentConversationId, navigateToConversation, navigateToNew } from "../lib/route";
import { setTheme } from "../lib/theme";
import { THEMES } from "../lib/themes";
import { setTaskItem } from "../lib/todos";
import { displayNameOf } from "../lib/identity";
import { loadDismissed, matchSuggestion, persistDismissed } from "../lib/suggestions";
import { exactSlashCommand, matchSlashCommands, type SlashCommand, type SlashCommandContext } from "../lib/slashCommands";
import { AccountButton } from "./AccountButton";
import { CapabilitySuggestion } from "./CapabilitySuggestion";
import { PasskeyNudge } from "./PasskeyNudge";
import { AccountModal, type AccountSection } from "./AccountModal";
import { CollaboratorsPanel } from "./CollaboratorsPanel";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { ConvoItem } from "./ConvoItem";
import { EmptyState } from "./EmptyState";
import { formatBytes } from "./FilesPanel";
import { Message } from "./Message";
import { Minimap } from "./Minimap";
import { RecapCard } from "./RecapCard";
import { RecapLoading } from "./RecapLoading";
import { CompactionBanner } from "./CompactionBanner";
import { ModelPicker } from "./ModelPicker";
import { ShareControl } from "./ShareControl";
import { ConvoListSkeleton, ThreadSkeleton } from "./Skeleton";
import { StagingBadge } from "./StagingBadge";
import { TempChatIcon } from "./TempChatIcon";

// One regenerated alternative of an assistant answer.
interface UiVariant {
  id?: string; // undefined only while a fresh regeneration is still streaming
  content: string;
  vote?: number;
  reasoning?: string; // the variant's model thinking (#68), shown collapsed above its answer
}

interface UiMessage {
  role: "user" | "assistant" | "system";
  content: string;
  id?: string;
  vote?: number;
  createdAt?: number;
  // The model's thinking for an assistant reply (#68) — streamed live (grown apart from `content`),
  // replayed on reconnect, and persisted so it survives a reload. Rendered as a collapsed
  // "Reasoning" section above the answer; absent for a non-reasoning model (no section shown).
  reasoning?: string;
  // Set when the user aborted this still-streaming reply (Stop). Purely client-side —
  // an aborted turn isn't persisted server-side, so the flag is lost on reload, same as
  // the old inline "_Stopped_" note it replaces.
  stopped?: boolean;
  // Assistant answers that were regenerated carry every variant + the selected index.
  // `content`/`id`/`vote` always mirror `variants[activeIndex]` while present.
  variants?: UiVariant[];
  activeIndex?: number;
  // Web-search ("Research") live progress on the in-flight turn, then its cited sources.
  // Both are client-side only (streamed during the turn / replayed on reconnect) — sources
  // aren't persisted yet, so they're absent after a full reload.
  search?: SearchStage;
  sources?: Source[];
  // Files the user attached to this message (files-to-prompt, #128). Persisted server-side, so
  // they render on the user's message after a conversation (re)load.
  attachments?: MessageAttachment[];
}

// Text injected into the composer (e.g. when editing a past message). The nonce
// forces the composer to re-apply even when the same text is sent twice.
interface ComposerDraft {
  text: string;
  nonce: number;
}

// True when a thrown value is the AbortError raised by aborting an in-flight fetch
// (i.e. the user hit Stop) rather than a genuine failure.
function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

// Map the server's thread payload into the view model used by <Message>.
function toUiMessages(apiMsgs: ApiMessage[]): UiMessage[] {
  return apiMsgs.map((m) => ({
    role: m.role,
    content: m.content,
    id: m.id,
    vote: m.vote,
    createdAt: m.createdAt,
    reasoning: m.reasoning ?? undefined,
    variants: m.variants?.map((v) => ({ id: v.id, content: v.content, vote: v.vote, reasoning: v.reasoning ?? undefined })),
    activeIndex: m.activeIndex,
    attachments: m.attachments,
  }));
}

export function ChatView({ me, onSignOut, onUserChange }: { me: Me; onSignOut: () => void; onUserChange?: (patch: Partial<Me["user"]>) => void }) {
  const t = useT();
  // The name shown in the account button follows the shared display precedence (#189): handle →
  // displayName → email → a real login → a friendly fallback — NEVER a passkey account's synthetic
  // `acct_<uuid>` login. Sign-out is a real action for a passkey session (the owner-admin `via:"owner"`
  // and every `via:"session"` account both hold a real cookie), but a no-op for the local dev-admin
  // bootstrap (`via:"dev"` re-auths every request from config), so we hide the control for it (#180
  // dropped the explanatory note rather than advertise the path; the Tailscale path was removed #191).
  const accountName = displayNameOf(me.user, t("identity.fallback"));
  const roleKey = me.role === "admin" ? "role.admin" : me.role === "account" ? "role.account" : "role.guest";
  const canSignOut = me.via !== "dev";
  const accountEmail = me.user.email ?? accountName;
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  // Archivist recap (#37): the "where you left off" card shown at the BOTTOM of a conversation
  // re-opened after time away — as the newest entry in the thread, where a /recap run from the
  // composer expects it. null = nothing to show (fresh/short thread, dismissed, or the server
  // degraded). Fetched on open, cleared on navigation + when a new turn starts.
  const [recap, setRecap] = useState<Recap | null>(null);
  // On-demand `/recap` command (#37 follow-up): `recapping` drives the visible "Recapping..."
  // indicator while forceRecap runs; the hook guards concurrent runs and routes an empty/failed
  // result to a quiet notice (see runRecap's call sites: the palette + the composer slash command).
  const { recapping, runRecap } = useRecapRunner({
    onRecap: setRecap,
    onEmpty: () => showNotice(t("recap.empty")),
    onError: () => showNotice(t("recap.failed")),
  });
  // Compact conversation, context-aware (#38): the effective context-window usage for the open
  // thread (from the read + refreshed on each turn's done frame + after a compact). null = unknown
  // (a new/ghost thread, or not loaded yet). `compactDismissed` remembers the user waving off the
  // near-limit nudge for THIS thread (the meter still shows); reset on navigation. `compacting`
  // guards the in-flight compact request.
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [compactDismissed, setCompactDismissed] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [convosLoading, setConvosLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  // Friendly display names from Jano (id -> label); the wire value stays the id.
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({});
  // The enriched catalog (#63) keyed by model id — the attachment gate (#136) reads `input` and the
  // richer picker (#17) reads `tier`/`byokOnly`/`provider` for badges + search. Empty until the
  // catalog loads: `modelAcceptsAttachments` stays optimistic and the picker shows names badge-free.
  const [modelCatalog, setModelCatalog] = useState<Record<string, CatalogModel>>({});
  const modelLabel = (id: string) => modelLabels[id] ?? id;
  const [model, setModel] = useState<string>("");
  // True while THIS client is streaming a turn INTO THE OPEN THREAD (drives the composer's
  // Stop affordance). Navigating away detaches the stream (detachStream) and clears this,
  // so a fresh new chat — or another thread — shows a ready Send button while the turn it
  // left keeps running in the background. Invariant: sending ⇒ the open thread is the
  // one streaming.
  const [sending, setSending] = useState(false);
  // Queue position of the in-flight turn: 0 = generating, n>=1 = waiting n-th in line.
  const [queuePosition, setQueuePosition] = useState(0);
  // Temporary (ghost) chat: ephemeral, never persisted. The transcript lives only in
  // `messages` here — there's no conversation row, so it's gone on reload, leaves the
  // sidebar untouched, and the server is told not to train on it.
  const [temporary, setTemporary] = useState(false);
  // Web search ("Research") toggle in the composer. Sticky across turns (ChatGPT-style),
  // and only ever shown when the server reports the capability available for this caller.
  const [searchOn, setSearchOn] = useState(false);
  const searchAvailable = me.search?.available === true;
  // Composer "Thinking" toggle (#68 follow-up): opt in to `enable_thinking` so the model reasons
  // before answering. Mirrors the Search toggle — sticky across turns (ChatGPT-style), default OFF.
  // Always shown (no availability gate): the param is best-effort, and a model that ignores it just
  // answers. The always-on "Reasoning" disclosure (#68) still renders whatever reasoning is emitted.
  const [thinkingOn, setThinkingOn] = useState(false);
  // Voice / conversational mode (#70): a hands-free spoken loop (speak → transcribe → answer →
  // read aloud → reopen the mic). A CORE household feature, never paywalled (like memory). The
  // pure state machine lives in `lib/voiceLoop`; `useVoiceLoop` drives the mic/STT/TTS side of it.
  // `voiceNotice` surfaces a mic/transcription failure in the composer. `replyRef` holds the latest
  // final assistant text so the loop reads back a FINISHED answer, never a half-streamed one.
  const [voiceNotice, setVoiceNotice] = useState<MessageKey | null>(null);
  const replyRef = useRef("");
  useEffect(() => {
    const last = messages.filter((m) => m.role === "assistant").at(-1);
    replyRef.current = last?.content ?? "";
  }, [messages]);
  const voice = useVoiceLoop({
    busy: sending,
    getReply: () => replyRef.current,
    // Dropping a transcript into the pipeline is identical to the user having typed it.
    send: (text) => void handleSend(text),
    transcribe,
    onNotice: setVoiceNotice,
  });
  // The consolidated account modal — null when closed, else the open section (Profile, Plans …).
  const [accountSection, setAccountSection] = useState<AccountSection | null>(null);
  // The caller's role on the OPEN conversation: "owner" for their own (the default for new /
  // ghost / unopened threads), else the collaborator role from the Share primitive. Drives the
  // owner-only controls (share / collaborators) and the read-only composer for a watcher.
  const [access, setAccess] = useState<ConversationAccessRole>("owner");
  const [showPalette, setShowPalette] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Desktop-only: collapse the left sidebar for a full-width conversation.
  // Persisted across sessions like the theme preference.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("a7t_chat_sidebar_collapsed") === "1",
  );
  // Desktop sidebar is drag-resizable within a tight range (it's a list, not a canvas —
  // so a modest 200-400px, unlike the map drawer which can take most of the screen).
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const s = Number(localStorage.getItem("a7t_chat_sidebar_w"));
    return s >= 200 && s <= 400 ? s : 240;
  });
  const [sidebarResizing, setSidebarResizing] = useState(false);
  function startSidebarResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    let latest = startW;
    setSidebarResizing(true);
    const move = (ev: PointerEvent) => {
      latest = Math.min(Math.max(startW + (ev.clientX - startX), 200), 400);
      setSidebarWidth(latest);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      setSidebarResizing(false);
      localStorage.setItem("a7t_chat_sidebar_w", String(latest));
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.body.style.userSelect = "none";
  }
  const [menuOpen, setMenuOpen] = useState(false);
  // Capability canvas drawer (maps, …): which capability surface is open + the payloads
  // raised from its inline chips this session (newest last, deduped).
  const [activeCap, setActiveCap] = useState<string | null>(null);
  const [capRequests, setCapRequests] = useState<Record<string, string[]>>({});
  // Capability surfaces (map pins, …) are scoped to a conversation and PERSISTED there
  // (per-device view-state in localStorage), so reopening a chat restores its pins — a
  // trip itinerary you built stays put. Stored under the conversation id; new (id-less)
  // chats keep pins in memory and migrate them once the id arrives.
  const capStoreKey = (cid: string | null) => (cid ? `a7t_chat_caps_${cid}` : null);
  function saveCaps(cid: string | null, reqs: Record<string, string[]>) {
    const k = capStoreKey(cid);
    if (k) localStorage.setItem(k, JSON.stringify(reqs));
  }
  function openCapability(id: string, payload: string) {
    setCapRequests((prev) => {
      const list = prev[id] ?? [];
      if (list.includes(payload)) return prev;
      const next = { ...prev, [id]: [...list, payload] };
      saveCaps(conversationId, next);
      return next;
    });
    setActiveCap(id);
  }
  // On a real chat switch, close the drawer (unmounts the surface, clearing its internal
  // markers) and load the target chat's persisted pins. Skip the null -> id transition:
  // a fresh chat just getting its id is the same thread, so keep + persist its pins.
  const prevConvRef = useRef<string | null>(conversationId);
  useEffect(() => {
    const prev = prevConvRef.current;
    prevConvRef.current = conversationId;
    if (prev === conversationId) return;
    if (prev === null && conversationId !== null) {
      setCapRequests((cur) => {
        saveCaps(conversationId, cur);
        return cur;
      });
      return;
    }
    setActiveCap(null);
    const k = capStoreKey(conversationId);
    let loaded: Record<string, string[]> = {};
    if (k) {
      try {
        loaded = JSON.parse(localStorage.getItem(k) ?? "{}");
      } catch {
        /* corrupt entry — start fresh */
      }
    }
    setCapRequests(loaded);
  }, [conversationId]);
  // A brief, self-dismissing toast (e.g. "that conversation is gone" after a redirect home,
  // so the jump back to a fresh chat isn't silent). Set the message to show it; it clears
  // itself after a few seconds. The nonce restarts the timer when the same message re-fires.
  const [notice, setNotice] = useState<{ text: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);
  function showNotice(text: string) {
    setNotice((n) => ({ text, nonce: (n?.nonce ?? 0) + 1 }));
  }
  const [draft, setDraft] = useState<ComposerDraft>({ text: "", nonce: 0 });
  // Bumped to ask the composer to grab focus (e.g. after a new/temporary chat
  // shortcut). A counter rather than a boolean so repeat shortcuts re-fire the effect.
  const [focusNonce, setFocusNonce] = useState(0);
  // Bumped by the model-picker shortcut to ask the composer's ModelPicker to toggle open.
  // A counter (like focusNonce) so repeat presses re-fire.
  const [modelPickerNonce, setModelPickerNonce] = useState(0);
  // Bumped by the live-dictation shortcut (#71) to toggle the composer's live mic.
  const [dictationNonce, setDictationNonce] = useState(0);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // Conversations whose title is being (re)generated via the menu action, so the
  // sidebar shows its spinner while the model works.
  const [titlingIds, setTitlingIds] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  // The scrolling thread container — the conversation minimap reads its scroll position
  // and measures the message rows inside it.
  const messagesRef = useRef<HTMLDivElement>(null);
  // Conversation minimap (the Xcode-style scrubbable preview): on by default, remembered
  // across sessions like the sidebar/theme prefs.
  const [minimapOn, setMinimapOn] = useState(() => localStorage.getItem("a7t_chat_minimap") !== "0");
  useEffect(() => {
    localStorage.setItem("a7t_chat_minimap", minimapOn ? "1" : "0");
  }, [minimapOn]);
  // Deterministic minimap model — one block per message, sized by content (the strip
  // refines this with real rendered heights at paint time). Rebuilt as the thread grows.
  const minimap = useMemo(
    () => buildMinimap(messages.map((m) => ({ role: m.role, content: m.content }))),
    [messages],
  );
  // Capability suggestion engine (#22): a subtle, dismissible nudge below the latest reply when the
  // exchange relates to a capability the caller isn't yet using — the super-app's discoverability
  // fix. Matching is client-side + content-free (the server only ships WHICH capabilities are active
  // for this caller, via me.suggestions). Dismissals are remembered per capability so a dismissed
  // nudge never returns.
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(() => loadDismissed());
  const suggestion = useMemo(() => {
    // Wait for a complete turn (never mid-stream), and only when there's an active nudge set.
    if (sending || !me.suggestions?.length) return null;
    // The latest PERSISTED assistant reply (has an id + content) and the user turn that prompted it.
    let ai = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.id && m.content) {
        ai = i;
        break;
      }
    }
    if (ai === -1) return null;
    const assistantText = messages[ai].content;
    const prev = messages[ai - 1];
    const userText = prev && prev.role === "user" ? prev.content : "";
    return matchSuggestion({
      contextText: `${userText}\n${assistantText}`,
      assistantText,
      hints: me.suggestions,
      dismissed: dismissedSuggestions,
    });
  }, [sending, messages, me.suggestions, dismissedSuggestions]);
  const onDismissSuggestion = useCallback((id: string) => {
    setDismissedSuggestions((prev) => {
      const next = new Set(prev);
      next.add(id);
      persistDismissed(next);
      return next;
    });
  }, []);
  // Resolve a message index to its row element (rows carry data-mm-index) so the minimap
  // can scroll it into view on a scrub and measure its height.
  const getMessageEl = useCallback(
    (index: number): HTMLElement | null =>
      messagesRef.current?.querySelector<HTMLElement>(`[data-mm-index="${index}"]`) ?? null,
    [],
  );
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Controller for the in-flight chat/regenerate request, so Stop can abort it.
  const abortRef = useRef<AbortController | null>(null);
  // Conversation whose turn is currently streaming — lets Stop target the server even
  // for a brand-new chat whose id only just arrived via the `meta` frame.
  const liveConvIdRef = useRef<string | null>(null);
  // Set while we abort the in-flight stream to DETACH from it (navigating away) rather
  // than to STOP it. A detach leaves the server turn running, so its abort must NOT mark
  // the thread we're leaving as stopped — and must not stomp the stream state, which by
  // then may belong to the thread we just opened. The abort handlers consult this to tell
  // a detach apart from a real Stop.
  const detachingRef = useRef(false);
  // Monotonic id for the in-flight thread load. A stale or duplicate openConversation
  // (StrictMode double-invokes the mount effect; quick chat switches overlap) bails at
  // the seq check instead of overwriting the chat the user actually landed on — and,
  // crucially, the resume placeholder a winning load installs to show "Thinking…".
  const loadSeqRef = useRef(0);

  // Title of the currently open conversation (null when on the new-chat screen).
  const currentTitle = useMemo(() => {
    if (!conversationId) return null;
    return conversations.find((c) => c.id === conversationId)?.title ?? t("chat.untitled");
  }, [conversations, conversationId, t]);

  // The open conversation's row, for the topbar star's filled/outline state (null on the
  // new-chat/ghost screen — nothing to favorite yet).
  const currentConvo = useMemo(
    () => (conversationId ? (conversations.find((c) => c.id === conversationId) ?? null) : null),
    [conversations, conversationId],
  );

  // Sidebar buckets: starred chats are pinned to a "Favorites" section, the rest
  // fall under "Recents". Both keep the server's updated-desc order.
  const favorites = useMemo(() => conversations.filter((c) => c.starred), [conversations]);
  const recents = useMemo(() => conversations.filter((c) => !c.starred), [conversations]);

  // Drag-to-favorite (#57): the id of the row being dragged and which bucket the pointer
  // is over, so we highlight the live drop target and reveal an empty Favorites drop zone.
  const [draggingConvoId, setDraggingConvoId] = useState<string | null>(null);
  const [dragOverBucket, setDragOverBucket] = useState<"favorites" | "recents" | null>(null);

  // Conversations to mark as "crunching" in the sidebar: those the server reports as
  // generating (e.g. after a refresh) plus the one we're actively streaming right now,
  // so the indicator appears immediately without waiting for a list refresh.
  const generatingIds = useMemo(() => {
    const ids = new Set(conversations.filter((c) => c.generating).map((c) => c.id));
    if (sending && conversationId) ids.add(conversationId);
    for (const id of titlingIds) ids.add(id);
    return ids;
  }, [conversations, sending, conversationId, titlingIds]);

  // While any turn is generating in the background (another tab, or one we reattached
  // to), poll the list so the sidebar indicator clears itself when it finishes.
  const anyGenerating = useMemo(() => conversations.some((c) => c.generating), [conversations]);
  useEffect(() => {
    if (!anyGenerating) return;
    const t = setInterval(() => refreshConversations(), 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyGenerating]);

  // Keep the document title in sync with the active section.
  useEffect(() => {
    const section = accountSection
      ? t("nav.settings")
      : temporary
        ? t("nav.temporaryChat")
        : conversationId
          ? currentTitle ?? t("chat.untitled")
          : t("nav.newChat");
    document.title = `${section} • a7t.chat`;
  }, [accountSection, temporary, conversationId, currentTitle, t]);

  useEffect(() => {
    if (editingName) nameInputRef.current?.select();
  }, [editingName]);

  // Remember the collapsed sidebar choice for the next visit.
  useEffect(() => {
    localStorage.setItem("a7t_chat_sidebar_collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  // Optimistically rename a conversation, rolling back from the server on failure.
  async function commitRename(id: string, title: string) {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      await renameConversation(id, title);
    } catch {
      refreshConversations();
    }
  }

  // Manually (re)generate a conversation's title from its first exchange — the menu
  // action for when the automatic post-turn titling didn't take. Shows the sidebar
  // spinner while it runs, then swaps in the new title.
  async function regenerateTitle(id: string) {
    setTitlingIds((prev) => new Set(prev).add(id));
    try {
      const title = await generateConversationTitle(id);
      if (title) setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    } catch {
      /* leave the existing title untouched on failure */
    } finally {
      setTitlingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // Persist a new title for the open conversation (topbar rename).
  function saveName() {
    const id = conversationId;
    const title = nameDraft.trim();
    setEditingName(false);
    if (!id || !title || title === currentTitle) return;
    commitRename(id, title);
  }

  // Toggle a conversation's favorite state (optimistic).
  async function toggleStar(c: ConversationMeta) {
    const starred = !c.starred;
    setConversations((prev) => prev.map((x) => (x.id === c.id ? { ...x, starred } : x)));
    try {
      await setConversationStarred(c.id, starred);
    } catch {
      refreshConversations();
    }
  }

  // Drag-to-favorite (#57): dragging a Recents row onto Favorites stars it, and a Favorite
  // back onto Recents unstars it — riding the SAME optimistic `toggleStar` persistence as the
  // kebab and topbar star (starred is a plain boolean, so there's no order/position to store).
  // Additive to the click/keyboard paths, never the only way in.
  function onConvoDragStart(id: string) {
    return (e: React.DragEvent) => {
      setDraggingConvoId(id);
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
    };
  }
  function onConvoDragEnd() {
    setDraggingConvoId(null);
    setDragOverBucket(null);
  }
  function onBucketDragOver(bucket: "favorites" | "recents") {
    return (e: React.DragEvent) => {
      if (!draggingConvoId) return; // only OUR row drags are droppable (ignore file/text drags)
      e.preventDefault(); // makes this a valid drop target, so `drop` fires
      e.dataTransfer.dropEffect = "move";
      setDragOverBucket((b) => (b === bucket ? b : bucket));
    };
  }
  function onBucketDragLeave(bucket: "favorites" | "recents") {
    return () => setDragOverBucket((b) => (b === bucket ? null : b));
  }
  function onBucketDrop(bucket: "favorites" | "recents") {
    return (e: React.DragEvent) => {
      if (!draggingConvoId) return;
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain") || draggingConvoId;
      setDraggingConvoId(null);
      setDragOverBucket(null);
      const c = conversations.find((x) => x.id === id);
      if (!c) return;
      const targetStarred = bucket === "favorites";
      if (c.starred === targetStarred) return; // dropped on its own section — graceful no-op
      toggleStar(c);
    };
  }

  // Delete a conversation after confirmation; leave the new-chat screen if it was open.
  async function removeConversation(c: ConversationMeta) {
    if (!window.confirm(t("chat.deleteConfirm", { title: c.title ?? t("chat.untitled") }))) return;
    setConversations((prev) => prev.filter((x) => x.id !== c.id));
    if (conversationId === c.id) newChat();
    try {
      await deleteConversation(c.id);
    } catch {
      refreshConversations();
    }
  }

  async function refreshConversations() {
    try {
      setConversations(await fetchConversations());
    } catch {
      /* ignore */
    } finally {
      setConvosLoading(false);
    }
  }

  useEffect(() => {
    fetchModels()
      .then((r) => {
        setModels(r.models);
        setModelLabels(r.labels ?? {});
        setModel((m) => m || r.default);
      })
      .catch(() => {});
    // Load the enriched catalog for the attachment gate (#136); a failure leaves it empty, and
    // attachments stay permissively enabled until it arrives (the send gate is the backstop).
    fetchModelCatalog()
      .then((r) => {
        const map: Record<string, CatalogModel> = {};
        for (const m of r.models) map[m.id] = m;
        setModelCatalog(map);
      })
      .catch(() => {});
    refreshConversations();
    // Deep-link: if the URL points at a conversation, open it on load.
    const id = currentConversationId();
    if (id) openConversation(id, { push: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync with browser back/forward navigation.
  useEffect(() => {
    function onPop() {
      const id = currentConversationId();
      if (id) {
        openConversation(id, { push: false });
      } else {
        detachStream();
        setConversationId(null);
        setMessages([]);
        setTemporary(false);
        setThreadLoading(false);
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Don't scroll an empty thread to the bottom — on mobile it pushes the "What can I help
    // with?" welcome out of view. Only follow to the bottom once the thread has messages.
    //
    // The recap (#37) now lands at the bottom of the thread (above the endRef sentinel), so
    // `recapping` + `recap` join the deps: when the on-demand /recap indicator appears or the
    // card resolves, the same scroll-to-latest reveals it like a new message — the user runs
    // /recap from the bottom and sees the result right there, without scrolling.
    if (messages.length === 0) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, recapping, recap]);

  // Global shortcuts. The chords are user-rebindable (see ../lib/keybindings); the set of
  // actions is fixed here. Every chord requires the platform modifier (Cmd/Ctrl), so the
  // handler stays inert while the user types in the composer. We deliberately avoid combos the
  // browser claims first — Cmd/Ctrl+N (new window) / +Shift+N (incognito) never reach the page,
  // so they aren't offered as bindings.
  //
  // A live `dispatchRef` (reassigned every render) lets a single, stable window listener always
  // run against fresh state (the open conversation, the list) with no stale-closure bug and no
  // re-subscribing on every keystroke.
  const stepThread = (dir: 1 | -1) => {
    if (conversations.length === 0) return;
    const idx = conversations.findIndex((c) => c.id === conversationId);
    // From the new-chat screen (idx === -1) step into the first/last; otherwise wrap around.
    const nextIdx =
      idx === -1
        ? dir === 1
          ? 0
          : conversations.length - 1
        : (idx + dir + conversations.length) % conversations.length;
    const target = conversations[nextIdx];
    if (target && target.id !== conversationId) openConversation(target.id);
  };
  const deleteCurrentChat = () => {
    const c = conversations.find((x) => x.id === conversationId);
    if (c) void removeConversation(c);
  };
  const dispatchRef = useRef<(action: ShortcutAction) => void>(() => {});
  dispatchRef.current = (action: ShortcutAction) => {
    switch (action) {
      case "search":
        setShowPalette((v) => !v);
        break;
      case "newThread":
        newChat();
        setFocusNonce((n) => n + 1);
        break;
      case "temporaryChat":
        newTemporaryChat();
        setFocusNonce((n) => n + 1);
        break;
      case "toggleSidebar":
        setSidebarCollapsed((v) => !v);
        break;
      case "minimap":
        setMinimapOn((v) => !v);
        break;
      case "modelPicker":
        setModelPickerNonce((n) => n + 1);
        break;
      case "dictation":
        setDictationNonce((n) => n + 1);
        break;
      case "nextThread":
        stepThread(1);
        break;
      case "prevThread":
        stepThread(-1);
        break;
      case "deleteChat":
        deleteCurrentChat();
        break;
    }
  };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isRecording()) return; // the KeyboardSheet is capturing this keystroke as a new binding
      const action = matchBinding(getBindings(), e);
      if (!action) return; // unbound (or a non-mod keystroke) — leave the browser default alone
      e.preventDefault();
      dispatchRef.current(action);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Detach from the turn streaming into the OPEN thread when we navigate away from it.
  // The chat runs server-side independently of this client, so we only abort our local
  // stream — otherwise its onDelta callbacks keep appending into whatever thread we switch
  // to (the cross-conversation bleed this fixes). The turn keeps generating in the
  // background (the sidebar shows its indicator) and resumeGeneration reattaches on return.
  // No-op when nothing is streaming. The matching abort handler clears `detachingRef`.
  function detachStream() {
    // Leaving a thread invalidates any in-flight thread load: bump the seq so a still-pending
    // openConversation fetch bails at its seq check instead of resolving later and reattaching
    // (resumeGeneration) — which would otherwise flip the composer back to its Stop state on
    // the fresh new chat we just landed on. And clear the open thread's streaming state up
    // front (even with nothing locally attached — e.g. a turn running purely in the
    // background), so a thread that isn't the one streaming always shows a ready Send button.
    loadSeqRef.current++;
    setSending(false);
    setQueuePosition(0);
    const controller = abortRef.current;
    if (!controller) return;
    detachingRef.current = true;
    abortRef.current = null;
    liveConvIdRef.current = null;
    controller.abort();
    refreshConversations();
  }

  async function openConversation(id: string, opts?: { push?: boolean }) {
    // Leaving a thread that's still streaming? Detach first so its deltas stop landing in
    // the thread we're about to open. Skip when re-opening the very thread we're streaming.
    if (id !== (liveConvIdRef.current ?? conversationId)) detachStream();
    setSidebarOpen(false);
    setTemporary(false); // opening a saved chat leaves ghost mode
    setConversationId(id);
    setRecap(null); // clear any prior chat's recap while this one loads
    setContextUsage(null); // and its context-usage meter (#38)
    setCompactDismissed(false); // a fresh thread earns a fresh look at the compact nudge
    if (opts?.push !== false) navigateToConversation(id);
    setThreadLoading(true);
    // Tag this load; a newer one supersedes it (see loadSeqRef). Everything after the
    // seq check runs synchronously, so the winning load can't be clobbered mid-flight.
    const seq = ++loadSeqRef.current;
    try {
      const r = await fetchConversation(id);
      if (loadSeqRef.current !== seq) return; // a newer load took over — drop this result
      // The conversation isn't this caller's (deleted, or another user's id in the URL):
      // don't strand them on a dead thread — go home + tell them why. Covers all three
      // callers of openConversation (deep-link on mount, popstate, sidebar/palette clicks).
      if (r === null) {
        handleConversationGone();
        return;
      }
      setMessages(toUiMessages(r.messages));
      if (r.conversation.model) setModel(r.conversation.model);
      // The Share primitive: capture the caller's role on this object so the UI shows the owner
      // controls only to the owner and a read-only composer to a watcher. Owned chats report
      // "owner"; a shared one carries the granted collaborator role.
      setAccess(r.conversation.access ?? "owner");
      setContextUsage(r.conversation.context ?? null); // the context-usage meter/nudge (#38)
      setThreadLoading(false);
      // A turn that began before a refresh is still running server-side — reattach so the
      // thinking indicator (and streaming text) resumes where it left off.
      if (r.conversation.generating) resumeGeneration(id);
      // Archivist recap (#37): if we returned to a stale conversation, surface "where you left
      // off" at the top. Best-effort + non-blocking: it rides its own request so it never
      // delays the thread, and a null (fresh/short/dismissed/degraded) simply shows no card.
      // Skip while a turn is streaming (nothing to recap yet) and guard the seq so a slow recap
      // can't land on a chat the user already navigated away from.
      if (!r.conversation.generating) {
        void fetchRecap(id)
          .then((rc) => {
            if (loadSeqRef.current === seq) setRecap(rc);
          })
          .catch(() => {});
      }
    } catch {
      if (loadSeqRef.current === seq) setThreadLoading(false);
    }
  }

  // Reattach to a turn still streaming for `id` after a page refresh: append a
  // placeholder answer (renders the "Thinking…" verb until deltas arrive), stream the
  // buffered + live text, then reconcile to the persisted thread.
  async function resumeGeneration(id: string) {
    if (abortRef.current) return;
    setSending(true);
    liveConvIdRef.current = id;
    const controller = new AbortController();
    abortRef.current = controller;
    setMessages((m) => [...m, { role: "assistant", content: "" }]);
    let errored = false;
    try {
      await attachChat(
        id,
        {
          onQueue: setQueuePosition,
          onSearch: (stage) => patchInFlight({ search: stage }),
          onSources: (srcs) => patchInFlight({ sources: srcs }),
          onReasoning: (txt) => {
            setQueuePosition(0);
            appendReasoning(txt);
          },
          onDelta: (txt) => {
            setQueuePosition(0);
            appendDelta(txt);
          },
          onError: (info) => {
            errored = true;
            appendDelta(`\n\n⚠️ ${t(errorKey(info))}`);
          },
          // The turn's conversation vanished for this caller mid-reattach — go home + notice
          // rather than leaving a stuck "Thinking…"/error on a thread that no longer exists.
          onNotFound: () => {
            errored = true; // skip the post-stream reconcile (the thread is gone)
            handleConversationGone();
          },
        },
        controller.signal,
      );
    } catch (e) {
      // Detached by navigating away while the reattached turn was streaming: detachStream
      // already cleared the stream state and the turn keeps running server-side, so bail
      // without marking the thread we moved to as stopped or reconciling it below.
      if (detachingRef.current) {
        detachingRef.current = false;
        return;
      }
      if (isAbortError(e)) {
        markLastStopped();
        abortRef.current = null;
        liveConvIdRef.current = null;
        setSending(false);
        refreshConversations();
        return;
      }
      errored = true;
      appendDelta(`\n\n⚠️ ${t(errorKey({ network: isNetworkError(e) }))}`);
    }
    abortRef.current = null;
    liveConvIdRef.current = null;
    setSending(false);
    setQueuePosition(0);
    // Reconcile to the canonical thread (real message ids, final text) once the stream
    // ends. Skip on error: the partial answer wasn't persisted, so keep the on-screen
    // note rather than blanking it. Skip if the user navigated away meanwhile.
    if (!errored && currentConversationId() === id) {
      try {
        const r = await fetchConversation(id);
        // Deleted DURING the turn (another tab / device): the thread is gone for this
        // caller now — go home rather than reconcile against a thread that no longer exists.
        if (r === null) {
          handleConversationGone();
          return;
        }
        setMessages(toUiMessages(r.messages));
        setContextUsage(r.conversation.context ?? null); // refresh the meter/nudge (#38)
      } catch {
        /* ignore */
      }
    }
    refreshConversations();
  }

  // Land on a fresh new chat (the home/empty state): detach any stream, clear the open
  // thread + its id, and reset the URL to "/". Backs both the explicit "New chat" action
  // and the "this conversation is gone" recovery (a 404 on open / send / regenerate), so
  // the user is never stranded on a dead/empty thread or a stuck "not found" note.
  function goHome() {
    detachStream();
    setConversationId(null);
    setMessages([]);
    setRecap(null);
    setContextUsage(null); // no meter on the empty state (#38)
    setTemporary(false);
    setAccess("owner"); // a fresh/empty thread is always the caller's own
    setSidebarOpen(false);
    // Clear any in-flight thread spinner too: a redirect home from a mid-load 404 would
    // otherwise leave the skeleton up instead of the fresh empty state.
    setThreadLoading(false);
    navigateToNew();
  }

  function newChat() {
    goHome();
  }

  // Recover from a conversation that's gone for this caller (404): go home AND surface a
  // brief toast so the redirect isn't silent. The single entry point every access path —
  // open / popstate / deep-link / send / regenerate / mid-turn delete — routes through.
  function handleConversationGone() {
    goHome();
    showNotice(t("chat.conversationGone"));
  }

  // Like newChat, but lands straight in a fresh temporary (ghost) thread. Unlike the
  // topbar toggle, this always enters ghost mode rather than flipping it off.
  function newTemporaryChat() {
    detachStream();
    setConversationId(null);
    setMessages([]);
    setRecap(null);
    setTemporary(true);
    setAccess("owner");
    setSidebarOpen(false);
    navigateToNew();
  }

  // Enter (or, if already in it, leave) temporary chat mode. Either way we start from a
  // clean, unsaved thread — a ghost chat is never persisted, so there's nothing to keep.
  function toggleTemporaryChat() {
    if (sending) return;
    // Invalidate any in-flight thread load so it can't resolve later and clobber this
    // freshly-cleared screen (same guard newChat gets via detachStream).
    loadSeqRef.current++;
    setConversationId(null);
    setMessages([]);
    setRecap(null);
    setAccess("owner");
    setSidebarOpen(false);
    setMenuOpen(false);
    setTemporary((v) => !v);
    navigateToNew();
  }

  function appendDelta(text: string) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      // Normally the last message is the streaming assistant placeholder we grow in
      // place. If it's gone (a concurrent reload reset the thread), recreate it so the
      // text — and the "Thinking…" verb it carries — is never silently dropped.
      if (last && last.role === "assistant" && !last.id) {
        next[next.length - 1] = { ...last, content: last.content + text };
      } else {
        next.push({ role: "assistant", content: text });
      }
      return next;
    });
  }

  // Grow the model's thinking (#68) on the in-flight assistant placeholder — the last, id-less row,
  // mirroring appendDelta's targeting — so the collapsed "Reasoning" section fills in live, apart
  // from the answer. Recreates the placeholder if a concurrent reload dropped it.
  function appendReasoning(text: string) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === "assistant" && !last.id) {
        next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + text };
      } else {
        next.push({ role: "assistant", content: "", reasoning: text });
      }
      return next;
    });
  }

  // Attach live web-search state (progress, then resolved sources) to the in-flight
  // assistant placeholder — the last, id-less row — mirroring appendDelta's targeting.
  function patchInFlight(patch: Partial<UiMessage>) {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === "assistant" && !last.id) {
        next[next.length - 1] = { ...last, ...patch };
      }
      return next;
    });
  }

  // `fileIds` carries the ids of files attached in the composer (files-to-prompt, #128). The
  // retry/edit callers send none. The server delivers their text into the turn and persists the
  // association, so they surface on this message after the next conversation (re)load.
  async function handleSend(text: string, fileIds?: string[]) {
    if (sending) return;
    setSending(true);
    setRecap(null); // a new turn supersedes the "where you left off" card

    const controller = new AbortController();
    abortRef.current = controller;
    const isCommand = text.trim().startsWith("/model");
    // A ghost chat keeps no server-side transcript, so replay the turns so far. Snapshot
    // them now, before the optimistic user + placeholder rows are appended below.
    const history = temporary
      ? messages
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))
      : undefined;
    if (!isCommand) {
      setMessages((m) => [...m, { role: "user", content: text, createdAt: Date.now() }, { role: "assistant", content: "" }]);
    }
    try {
      const cmd = await sendChat(
        {
          conversationId: conversationId ?? undefined,
          content: text,
          model: model || undefined,
          temporary,
          // Only request search when it's available to this caller; the server re-checks.
          search: searchAvailable && searchOn,
          // Opt in to model reasoning via enable_thinking when the Thinking toggle is on.
          thinking: thinkingOn,
          history,
          // Attached files (#128): the server validates each belongs to the caller and inlines
          // their text into the turn. Omitted when nothing's attached.
          fileIds,
        },
        {
          onMeta: (mta) => {
            // Ghost chats have no persisted conversation — don't adopt an id or touch the
            // URL (that would make it look saved / survive a reload).
            if (temporary || !mta.conversationId) return;
            setConversationId((id) => id ?? mta.conversationId);
            // Track the live conversation so Stop can target it even before this state
            // update lands (brand-new chats learn their id here).
            liveConvIdRef.current = mta.conversationId;
            // Reflect the (possibly brand-new) conversation in the URL so a
            // refresh reopens it; replace so it doesn't add a history entry.
            navigateToConversation(mta.conversationId, true);
            // First message of a brand-new chat: the server already persisted the
            // conversation row before this frame, so surface it in the sidebar right away
            // instead of waiting for the turn to finish.
            if (!conversationId) refreshConversations();
          },
          onQueue: setQueuePosition,
          onSearch: (stage) => patchInFlight({ search: stage }),
          onSources: (srcs) => patchInFlight({ sources: srcs }),
          onReasoning: (txt) => {
            setQueuePosition(0);
            appendReasoning(txt);
          },
          onDelta: (txt) => {
            setQueuePosition(0);
            appendDelta(txt);
          },
          onDone: (d) => {
            // Refresh the context-usage meter/nudge (#38) from the post-turn snapshot.
            if (d.context) setContextUsage(d.context);
            setMessages((prev) => {
              const next = prev.slice();
              const last = next[next.length - 1];
              if (last && last.role === "assistant") next[next.length - 1] = { ...last, id: d.messageId };
              return next;
            });
          },
          onError: (info) => appendDelta(`\n\n⚠️ ${t(errorKey(info))}`),
          // Sent to a conversation that's gone for this caller (deleted, or another user's
          // id): go home + notice instead of appending a stuck "⚠️ conversation not found".
          onNotFound: handleConversationGone,
        },
        controller.signal,
      );
      if (cmd) {
        if ("error" in cmd) {
          setMessages((m) => [...m, { role: "system", content: `⚠️ ${cmd.error}` }]);
        } else if (cmd.command === "model.list") {
          setModels(cmd.models);
          setMessages((m) => [
            ...m,
            {
              role: "system",
              content: t("chat.modelsList", { models: cmd.models.map(modelLabel).join(", "), current: modelLabel(cmd.current) }),
            },
          ]);
        } else if (cmd.command === "model.set") {
          setModel(cmd.model);
          setMessages((m) => [...m, { role: "system", content: t("chat.switchedModel", { model: modelLabel(cmd.model) }) }]);
        }
      }
    } catch (e) {
      // Detached by navigating away mid-stream: the turn keeps running server-side and
      // reattaches on return, so leave the thread we moved to untouched.
      if (detachingRef.current) {
        /* handled in detachStream */
      } else if (isAbortError(e)) {
        // Stop button aborted the stream: close out the empty/partial reply so it
        // stops showing the "Thinking…" indicator.
        markLastStopped();
      } else {
        // Surface anything else inline. A thrown fetch error is almost always a transport
        // failure (offline / connection dropped) — classify it so the user gets the
        // "check your connection" copy rather than a raw "Failed to fetch".
        appendDelta(`\n\n⚠️ ${t(errorKey({ network: isNetworkError(e) }))}`);
      }
    } finally {
      // A detach already cleared the shared stream state (and may have handed the slot to
      // the thread we opened), so don't stomp it here — just consume the flag.
      if (detachingRef.current) {
        detachingRef.current = false;
      } else {
        abortRef.current = null;
        liveConvIdRef.current = null;
        setSending(false);
        setQueuePosition(0);
        refreshConversations();
      }
    }
  }

  // Flag the still-streaming assistant reply (the last message, before its `done` id
  // arrives) as stopped so an aborted turn renders the "you stopped this" notice +
  // Continue affordance rather than sitting stuck on the thinking indicator.
  function markLastStopped() {
    setMessages((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last && last.role === "assistant" && !last.id) {
        next[next.length - 1] = { ...last, stopped: true };
      }
      return next;
    });
  }

  // Stop the in-flight turn. The chat turn runs server-side independent of this client,
  // so tell the server to cancel it (by conversation) AND abort the local stream so the
  // UI settles immediately. Regenerate still halts purely via the local abort.
  function stopGeneration() {
    const id = liveConvIdRef.current ?? conversationId;
    if (id) void cancelGeneration(id).catch(() => {});
    abortRef.current?.abort();
  }

  async function onVote(id: string, vote: number) {
    setMessages((prev) =>
      prev.map((m) => {
        const isActive = m.id === id;
        const inVariants = m.variants?.some((v) => v.id === id);
        if (!isActive && !inVariants) return m;
        return {
          ...m,
          vote: isActive ? vote : m.vote,
          variants: m.variants?.map((v) => (v.id === id ? { ...v, vote } : v)),
        };
      }),
    );
    try {
      await voteMessage(id, vote);
    } catch {
      /* ignore */
    }
  }

  // Tick/untick a TODO checkbox on a persisted message in the OPEN conversation (#131). Optimistic:
  // flip the checkbox locally at once (in the message content, and in the matching variant if this
  // is a regenerated answer), then confirm with the server and adopt its authoritative content —
  // reverting to the prior content on any rejection (403/404/network). Mirrors WatchView's public
  // toggle; here the caller is authorized by the auth gate + their role (owner / edit / prompt).
  async function onToggleTodo(messageId: string, index: number, done: boolean) {
    const cid = conversationId;
    if (!cid) return; // a ghost/new chat has nothing persisted to toggle
    let previous: string | undefined;
    const withContent = (m: UiMessage, content: string): UiMessage => ({
      ...m,
      content,
      variants: m.variants?.map((v) => (v.id === messageId ? { ...v, content } : v)),
    });
    setMessages((cur) =>
      cur.map((m) => {
        if (m.id !== messageId) return m;
        previous = m.content;
        const next = setTaskItem(m.content, index, done);
        return next === null ? m : withContent(m, next);
      }),
    );
    const serverContent = await toggleConversationTodo(cid, messageId, index, done);
    const resolved = serverContent ?? previous;
    if (resolved === undefined) return; // message vanished mid-flight — nothing to reconcile
    setMessages((cur) => cur.map((m) => (m.id === messageId ? withContent(m, resolved) : m)));
  }

  // Re-ask the user message at `index`, sending it again as a fresh turn.
  function onResend(index: number) {
    if (sending) return;
    const msg = messages[index];
    if (msg?.role === "user" && msg.content) handleSend(msg.content);
  }

  // "Continue" on a stopped reply: an aborted turn is never persisted server-side, so
  // there's no half-answer to resume — instead re-ask the question that produced it.
  // Drop the orphaned question + stopped reply first so the re-ask reads as one clean
  // turn rather than echoing the prompt twice.
  function onContinue(index: number) {
    if (sending) return;
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content) {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;
    const content = messages[userIndex].content;
    setMessages((prev) => prev.filter((_, i) => i !== index && i !== userIndex));
    handleSend(content);
  }

  // Regenerate an assistant answer in place: re-run the model against the prior
  // context (no new user message) and keep the result alongside the original as a
  // variant you can flip between with the ◀ n/m ▶ arrows.
  async function onRegenerate(index: number) {
    if (sending) return;
    const msg = messages[index];
    if (!msg || msg.role !== "assistant" || !msg.id) return;
    const targetId = msg.id;
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // Seed the variant list from the current answer (first regenerate) and append a
    // streaming placeholder that becomes the active one.
    setMessages((prev) =>
      prev.map((m, i) => {
        if (i !== index) return m;
        const variants = m.variants ?? [{ id: m.id, content: m.content, vote: m.vote, reasoning: m.reasoning }];
        const next = [...variants, { id: undefined, content: "", vote: 0 }];
        // Reset the streaming placeholder's reasoning (#68) — the retry grows its own thinking.
        return { ...m, variants: next, activeIndex: next.length - 1, content: "", id: undefined, vote: 0, reasoning: undefined };
      }),
    );
    try {
      await regenerateChat(targetId, {
        onReasoning: (text) =>
          setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, reasoning: (m.reasoning ?? "") + text } : m))),
        onDelta: (text) =>
          setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, content: m.content + text } : m))),
        onDone: (d) =>
          setMessages((prev) =>
            prev.map((m, i) => {
              if (i !== index) return m;
              const variants = (d.variants ?? []).map((v) => ({ id: v.id, content: v.content, vote: v.vote, reasoning: v.reasoning ?? undefined }));
              const ai = d.activeIndex ?? Math.max(variants.length - 1, 0);
              const active = variants[ai];
              if (!active) return { ...m, id: d.messageId };
              return { ...m, variants, activeIndex: ai, id: active.id, content: active.content, vote: active.vote ?? 0, reasoning: active.reasoning };
            }),
          ),
        onError: (info) =>
          setMessages((prev) =>
            prev.map((m, i) => {
              if (i !== index) return m;
              const content = `${m.content}\n\n⚠️ ${t(errorKey(info))}`;
              const variants = m.variants?.slice();
              if (variants && m.activeIndex != null) variants[m.activeIndex] = { ...variants[m.activeIndex], content };
              return { ...m, content, variants };
            }),
          ),
        // The conversation owning this answer is gone for the caller — go home + notice
        // (the in-flight variant was never persisted, so there's nothing to keep).
        onNotFound: handleConversationGone,
      }, controller.signal);
    } catch (e) {
      // Detached by navigating away mid-regenerate: the half-streamed variant was never
      // persisted, so returning to the thread reloads its canonical (pre-regenerate)
      // answer — nothing to restore, and we mustn't touch the thread we moved to.
      if (detachingRef.current) {
        /* handled in the finally below */
      } else if (isAbortError(e)) {
        // Stop button aborted the regeneration before it produced anything persistable.
        // Revert to the answer that was showing before: the half-streamed variant was
        // never saved server-side, so dropping it (restoring the pre-regenerate snapshot)
        // leaves a real answer in place instead of a stuck, empty "stopped" variant.
        // Other failures already surface through onError above.
        setMessages((prev) => prev.map((m, i) => (i === index ? msg : m)));
      }
    } finally {
      // On detach, detachStream already reset the stream state (possibly for the thread we
      // opened) — just consume the flag rather than stomping it.
      if (detachingRef.current) {
        detachingRef.current = false;
      } else {
        abortRef.current = null;
        setSending(false);
        refreshConversations();
      }
    }
  }

  // Flip the active variant of a regenerated answer; persist the choice so the rest of
  // the thread (and the next turn) follows the selected branch.
  function navVariant(index: number, dir: number) {
    const m = messages[index];
    if (!m?.variants || m.variants.length < 2) return;
    const n = m.variants.length;
    const ai = Math.min(Math.max((m.activeIndex ?? 0) + dir, 0), n - 1);
    if (ai === m.activeIndex) return;
    const v = m.variants[ai];
    setMessages((prev) =>
      prev.map((x, i) => (i === index ? { ...x, activeIndex: ai, id: v.id, content: v.content, vote: v.vote ?? 0, reasoning: v.reasoning } : x)),
    );
    if (v.id) void selectVariant(v.id).catch(() => {});
  }

  // Load a past user message back into the composer for editing.
  function onEdit(content: string) {
    setDraft((d) => ({ text: content, nonce: d.nonce + 1 }));
  }

  // Dismiss the recap card (#37): hide it now, and remember the dismissal server-side so it stays
  // hidden until new activity mints a fresh recap. Best-effort; the hide is optimistic.
  function onDismissRecap() {
    const id = conversationId;
    setRecap(null);
    if (id) void dismissRecap(id);
  }

  // Resume from the recap's suggested next step (#37): seed the composer with it so the user can
  // pick the conversation back up in one tap, then clear the card.
  function onResumeRecap(text: string) {
    setDraft((d) => ({ text, nonce: d.nonce + 1 }));
    setRecap(null);
  }

  // The `/recap` command (#37) lives in `useRecapRunner` (above): it forces "where you left off"
  // for the OPEN conversation on demand, bypassing ONLY the 24h staleness gate server-side (the
  // auth/owner-memory scoping is unchanged), surfaces the recap through the SAME card the
  // auto-surface uses, and now shows a "Recapping..." indicator for the several seconds it runs.

  // Compact the open conversation (#38): fold its older turns into the rolling summary so it keeps
  // fitting the model's context window. The transcript is untouched server-side (the messages stay),
  // so we DON'T reload them here — only the effective usage drops. On success we swap in the new
  // snapshot (which hides the nudge as usage falls); on any failure we leave the UI as-is.
  async function onCompact() {
    const id = conversationId;
    if (!id || compacting) return;
    setCompacting(true);
    try {
      const result = await compactConversation(id);
      if (result) {
        setContextUsage(result.context);
        setCompactDismissed(false); // a fresh, lower snapshot earns a clean slate
      }
    } finally {
      setCompacting(false);
    }
  }

  // Wave off the near-limit compact nudge for this thread (the subtle meter stays). Purely local +
  // per-open-thread — reset on navigation, and re-armed when a later turn refills the window.
  function onDismissCompact() {
    setCompactDismissed(true);
  }

  // Guards a branch request in flight so a double-click can't fork twice (each POST creates a
  // fresh conversation). Not React state — it only needs to short-circuit the handler, not render.
  const branchingRef = useRef(false);

  // Branch the open conversation at message `index` into a new chat (#72): the server copies the
  // active thread up to and including that message into a fresh conversation the caller owns, then
  // we open it. Only persisted messages in the caller's own conversation are branchable (the button
  // is hidden otherwise). A failure (foreign/stale conversation, network) surfaces a brief notice
  // and leaves the current thread untouched.
  async function onBranch(index: number) {
    const cid = conversationId;
    const msg = messages[index];
    if (!cid || !msg?.id || branchingRef.current) return;
    branchingRef.current = true;
    try {
      const created = await branchConversation(cid, msg.id);
      if (!created) {
        showNotice(t("chat.branchFailed"));
        return;
      }
      await refreshConversations();
      openConversation(created.id);
      showNotice(t("chat.branched"));
    } finally {
      branchingRef.current = false;
    }
  }

  const paletteItems: CommandItem[] = useMemo(() => {
    const actions = t("palette.groupActions");
    const list: CommandItem[] = [
      { id: "new", group: actions, label: t("nav.newChat"), run: newChat },
      { id: "temp", group: actions, label: t("nav.temporaryChat"), keywords: "ghost ephemeral private incognito temporaria fantasma", run: toggleTemporaryChat },
      { id: "profile", group: actions, label: t("profile.title"), keywords: "account plan usage tokens limit budget meter perfil plano uso", run: () => setAccountSection("profile") },
      { id: "directory", group: actions, label: t("directory.title"), keywords: "people directory users find members handle search pessoas usuarios diretorio membros buscar", run: () => setAccountSection("directory") },
      { id: "settings", group: actions, label: t("palette.openSettings"), keywords: "theme appearance language idioma tema", run: () => setAccountSection("settings") },
      { id: "memory", group: actions, label: t("memory.title"), keywords: "memory remember forget facts archivist privacy recall memoria lembrar esquecer fatos", run: () => setAccountSection("memory") },
      { id: "files", group: actions, label: t("files.title"), keywords: "files attachments uploads documents storage arquivos anexos uploads armazenamento", run: () => setAccountSection("files") },
      { id: "keys", group: actions, label: t("byok.title"), keywords: "byok api key keys bring your own openai anthropic provider token chave chaves provedor", run: () => setAccountSection("keys") },
      { id: "about", group: actions, label: t("about.title"), keywords: "about help a7t.ai info sobre ajuda informacoes", run: () => setAccountSection("about") },
    ];
    // Passkey manager (#20) — only when the server has WebAuthn configured (dark otherwise).
    if (me.passkeys?.available) {
      list.push({ id: "passkeys", group: actions, label: t("passkeys.title"), keywords: "passkey webauthn security fingerprint touch id face biometric senha chave", run: () => setAccountSection("passkeys") });
    }
    if (me.role === "admin") {
      list.push({ id: "stats", group: actions, label: t("palette.telemetryStats"), keywords: "usage", run: () => setAccountSection("stats") });
    }
    // The /recap command (#37): only when a real conversation is open (a ghost/new chat has nothing
    // persisted to recap). Forces "where you left off" on demand, ignoring the 24h staleness gate.
    if (conversationId) {
      list.push({
        id: "recap",
        group: actions,
        label: t("palette.recap"),
        hint: t("palette.recapHint"),
        keywords: "recap summary catch up where you left off resumo recapitular retomar",
        run: () => void runRecap(conversationId),
      });
    }
    // Tailscale admins can't sign out (the header re-auths every request), so omit it for them.
    if (canSignOut) list.push({ id: "signout", group: actions, label: t("nav.signOut"), run: onSignOut });
    for (const c of conversations) {
      list.push({ id: `c:${c.id}`, group: t("palette.groupChats"), label: c.title ?? t("chat.untitled"), hint: c.model ?? "", keywords: "conversation", run: () => openConversation(c.id) });
    }
    for (const th of THEMES) {
      list.push({ id: `t:${th.id}`, group: t("palette.groupTheme"), label: t("palette.themeLabel", { name: th.name }), keywords: "color appearance", run: () => setTheme(th.id) });
    }
    for (const l of LOCALES) {
      list.push({ id: `l:${l.id}`, group: t("palette.groupLanguage"), label: t("palette.languageLabel", { name: l.name }), keywords: "language idioma locale", run: () => setLang(l.id) });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, conversationId, me.role, t]);

  return (
    <CapabilityProvider value={openCapability}>
    <div className="app">
      {notice && (
        <div className="app-toast" role="status" aria-live="polite">
          {notice.text}
        </div>
      )}
      <div className="body">
        {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
        <aside
          className={`sidebar ${sidebarOpen ? "open" : ""} ${sidebarCollapsed ? "collapsed" : ""} ${sidebarResizing ? "resizing" : ""}`}
          style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}
        >
          {!sidebarCollapsed && (
            <div className="sidebar-resizer" onPointerDown={startSidebarResize} role="separator" aria-label="Resize sidebar" />
          )}
          {/* Brand icon sits top-left; the collapse toggle top-right. */}
          <div className="sidebar-header">
            <a
              className="brand"
              href="/"
              aria-label={t("nav.home")}
              title={t("nav.home")}
              onClick={(e) => {
                e.preventDefault();
                newChat();
              }}
            >
              <img src="/icon-mark-light.svg" alt="a7t.chat" className="brand-icon brand-icon-dark" />
              <img src="/icon-mark.svg" alt="a7t.chat" className="brand-icon brand-icon-light" />
            </a>
            <StagingBadge env={me.env} />
            {/* Desktop: collapse the sidebar to a 0-width rail (the topbar grows an expand
                button). Hidden on mobile, where the sidebar is an overlay drawer instead. */}
            <button
              className="btn ghost small icon-btn collapse-btn"
              onClick={() => setSidebarCollapsed(true)}
              aria-label={t("chat.collapseSidebar")}
              title={t("chat.collapseSidebar")}
            >
              <PanelLeftClose size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
            {/* Mobile-only: the drawer is governed by sidebarOpen, NOT the desktop collapse
                state, so its close affordance must dismiss the overlay (collapse can't). */}
            <button
              className="btn ghost small icon-btn sidebar-close-btn"
              onClick={() => setSidebarOpen(false)}
              aria-label={t("chat.closeConversations")}
              title={t("chat.closeConversations")}
            >
              <X size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          <div className="sidebar-body">
            {convosLoading ? (
              <ConvoListSkeleton />
            ) : conversations.length === 0 ? (
              <p className="convo-empty muted small">{t("chat.noConversations")}</p>
            ) : (
              <div className="convo-sections">
                {/* Favorites: always shown while a drag is in flight so an empty Favorites still
                    offers a drop target for a Recents row being dragged up (#57). */}
                {(favorites.length > 0 || draggingConvoId) && (
                  <section
                    className={`convo-section ${dragOverBucket === "favorites" ? "drag-over" : ""}`}
                    onDragOver={onBucketDragOver("favorites")}
                    onDragLeave={onBucketDragLeave("favorites")}
                    onDrop={onBucketDrop("favorites")}
                  >
                    <div className="convo-section-label">{t("chat.favorites")}</div>
                    {favorites.length === 0 ? (
                      <p className="convo-empty muted small convo-drop-hint">{t("chat.dropToFavorite")}</p>
                    ) : (
                      <ul className="convo-list">
                        {favorites.map((c) => (
                          <ConvoItem
                            key={c.id}
                            convo={c}
                            active={c.id === conversationId}
                            generating={generatingIds.has(c.id)}
                            draggable
                            onOpen={() => openConversation(c.id)}
                            onRename={(title) => commitRename(c.id, title)}
                            onGenerateTitle={() => regenerateTitle(c.id)}
                            onToggleStar={() => toggleStar(c)}
                            onDelete={() => removeConversation(c)}
                            onDragStart={onConvoDragStart(c.id)}
                            onDragEnd={onConvoDragEnd}
                          />
                        ))}
                      </ul>
                    )}
                  </section>
                )}
                <section
                  className={`convo-section ${dragOverBucket === "recents" ? "drag-over" : ""}`}
                  onDragOver={onBucketDragOver("recents")}
                  onDragLeave={onBucketDragLeave("recents")}
                  onDrop={onBucketDrop("recents")}
                >
                  <div className="convo-section-label">{t("chat.recents")}</div>
                  {recents.length === 0 ? (
                    <p className="convo-empty muted small">{t("chat.noRecents")}</p>
                  ) : (
                    <ul className="convo-list">
                      {recents.map((c) => (
                        <ConvoItem
                          key={c.id}
                          convo={c}
                          active={c.id === conversationId}
                          generating={generatingIds.has(c.id)}
                          draggable
                          onOpen={() => openConversation(c.id)}
                          onRename={(title) => commitRename(c.id, title)}
                          onGenerateTitle={() => regenerateTitle(c.id)}
                          onToggleStar={() => toggleStar(c)}
                          onDelete={() => removeConversation(c)}
                          onDragStart={onConvoDragStart(c.id)}
                          onDragEnd={onConvoDragEnd}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}
          </div>
          {/* Account menu lives at the foot of the sidebar (ChatGPT-style) and
              opens upward. */}
          <div className="sidebar-footer">
            <div className="menu">
              <AccountButton
                name={accountName}
                role={t(roleKey)}
                label={t("chat.accountMenu")}
                expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              />
              {menuOpen && (
                <>
                  <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="menu-pop up">
                    <div className="menu-account-email" title={accountEmail}>{accountEmail}</div>
                    <div className="menu-sep" />
                    <button className="menu-item" onClick={() => { setAccountSection("profile"); setMenuOpen(false); }}>
                      {t("nav.settings")}
                    </button>
                    <a className="menu-item" href="/help">
                      {t("menu.getHelp")}
                    </a>
                    {/* Tailscale admins re-auth via the header every request, so a client-side
                        sign-out is a no-op — hide the control entirely (and its separator) rather
                        than advertise the auth path. */}
                    {canSignOut && (
                      <>
                        <div className="menu-sep" />
                        <button className="menu-item" onClick={() => { onSignOut(); setMenuOpen(false); }}>
                          {t("nav.signOut")}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </aside>
        <div className="main-col">
          <header className="topbar">
            <div className="topbar-left">
              <button
                className="btn ghost small icon-btn menu-btn"
                onClick={() => setSidebarOpen((v) => !v)}
                aria-label={t("chat.toggleConversations")}
              >
                <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <StagingBadge env={me.env} className="staging-badge--topbar" />
              {/* Desktop: when the sidebar is collapsed it owns no controls, so the
                  expand affordance surfaces here in the topbar rail. */}
              {sidebarCollapsed && (
                <button
                  className="btn ghost small icon-btn collapse-btn"
                  onClick={() => setSidebarCollapsed(false)}
                  aria-label={t("chat.expandSidebar")}
                  aria-pressed={true}
                  title={t("chat.expandSidebar")}
                >
                  <PanelLeftOpen size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
              )}
              {conversationId &&
                (editingName ? (
                  <input
                    ref={nameInputRef}
                    className="convo-name-input"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={saveName}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveName();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingName(false);
                      }
                    }}
                    maxLength={200}
                    aria-label={t("chat.conversationName")}
                  />
                ) : (
                  <button
                    className="convo-name"
                    title={t("chat.renameChat")}
                    onClick={() => {
                      setNameDraft(currentTitle ?? "");
                      setEditingName(true);
                    }}
                  >
                    {currentTitle}
                  </button>
                ))}
            </div>
            <div className="topbar-right">
              {/* Share is offered only for a real (persisted) open chat — a ghost chat has no
                  server row to share, and the new-chat screen nothing to share yet. The
                  entitlement hint hides it if a tier ever gates sharing (re-checked server-side). */}
              {/* Topbar star (#57): favs/unfavs the open chat, staying in sync with the sidebar
                  bucket + kebab (all share `toggleStar`). Owner-only + persisted-chat gate matches
                  the share controls (the PATCH is owner-scoped) — hidden on the new-chat/ghost screen. */}
              {conversationId && !temporary && access === "owner" && currentConvo && (
                <button
                  className={`btn ghost small icon-btn star-btn ${currentConvo.starred ? "active" : ""}`}
                  onClick={() => toggleStar(currentConvo)}
                  aria-pressed={currentConvo.starred}
                  aria-label={currentConvo.starred ? t("convo.unstar") : t("convo.star")}
                  title={currentConvo.starred ? t("convo.unstar") : t("convo.star")}
                >
                  <Star size={18} strokeWidth={1.75} fill={currentConvo.starred ? "currentColor" : "none"} aria-hidden="true" />
                </button>
              )}
              {/* Owner-only sharing controls — hidden when viewing a conversation shared WITH
                  the caller (access !== "owner"): a collaborator can't re-share or manage people.
                  key by conversation so switching chats remounts fresh (no stale popover). */}
              {conversationId && !temporary && access === "owner" && me.features?.["conversations.collaborate"] !== false && (
                <CollaboratorsPanel key={`collab-${conversationId}`} conversationId={conversationId} />
              )}
              {conversationId && !temporary && access === "owner" && me.features?.["conversations.share"] !== false && (
                <ShareControl key={conversationId} conversationId={conversationId} />
              )}
              <button
                className={`btn ghost small icon-btn temp-btn ${temporary ? "active" : ""}`}
                onClick={toggleTemporaryChat}
                title={temporary ? t("temp.exitTitle") : t("temp.startTitle")}
                aria-label={temporary ? t("temp.exitTitle") : t("temp.startTitle")}
                aria-pressed={temporary}
              >
                <TempChatIcon size={18} />
              </button>
              <button
                className="btn ghost small icon-btn newchat-btn"
                onClick={newChat}
                title={t("nav.newChat")}
                aria-label={t("nav.newChat")}
              >
                <SquarePen size={18} strokeWidth={1.75} className="newchat-ico" aria-hidden="true" />
              </button>
              <button className="btn ghost small icon-btn search-btn" onClick={() => setShowPalette(true)} title={t("chat.search")} aria-label={t("chat.search")}>
                <Search size={18} strokeWidth={1.75} className="search-ico" aria-hidden="true" />
              </button>
            </div>
          </header>
          <main className={`thread ${temporary ? "temporary" : ""}`}>
            {temporary && (
              <div className="temp-banner" role="status">
                <span className="temp-banner-ico">
                  <TempChatIcon size={16} />
                </span>
                <span className="temp-banner-text">{t("temp.banner")}</span>
              </div>
            )}
            {/* Post-login passkey nudge (#149): self-gating — renders null unless this is an account
                with no passkey, on a passkey-capable browser + configured server. */}
            <PasskeyNudge me={me} />
            {/* Conversation minimap controls live INSIDE the thread column, not the
                topbar: a small floating toggle pins to the thread's top-right, and the
                scrubbable strip pins to its right edge. Both hide on narrow viewports +
                below the min thread length (the strip via shouldShowMinimap, the toggle
                via the same gate so it never offers a strip that can't render). */}
            {shouldShowMinimap(messages.length) && (
              <button
                type="button"
                className={`minimap-toggle ${minimapOn ? "on" : ""}`}
                onClick={() => setMinimapOn((v) => !v)}
                aria-pressed={minimapOn}
                aria-label={minimapOn ? t("minimap.hide") : t("minimap.show")}
                title={minimapOn ? t("minimap.hide") : t("minimap.show")}
              >
                {/* The minimap glyph: a tree of lines standing in for the thread outline. */}
                <ListTree size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            {!threadLoading && (
              <Minimap
                open={minimapOn}
                model={minimap}
                scrollRef={messagesRef}
                getMessageEl={getMessageEl}
                messageCount={messages.length}
              />
            )}
            <div className="messages" ref={messagesRef}>
              {threadLoading ? (
                <ThreadSkeleton />
              ) : (
                <>
                  {messages.length === 0 && (
                    <EmptyState
                      onPick={(text) => setDraft((d) => ({ text, nonce: d.nonce + 1 }))}
                      temporary={temporary}
                    />
                  )}
                  {messages.map((m, i) => {
                    // The in-flight assistant turn (last row, still streaming): it carries
                    // the live queue position + the "email me when done" control.
                    const inFlight = sending && m.role === "assistant" && !m.id && i === messages.length - 1;
                    return (
                    <Message
                      key={i}
                      role={m.role}
                      content={m.content}
                      reasoning={m.reasoning}
                      id={m.id}
                      anchorId={i}
                      vote={m.vote}
                      createdAt={m.createdAt}
                      stopped={m.stopped}
                      variantCount={m.variants?.length}
                      variantIndex={m.activeIndex}
                      attachments={m.attachments}
                      inFlight={inFlight}
                      queuePosition={inFlight ? queuePosition : undefined}
                      search={m.search}
                      sources={m.sources}
                      onVote={access === "owner" ? onVote : undefined}
                      onRetry={
                        access !== "owner"
                          ? undefined
                          : m.role === "assistant"
                            ? () => onRegenerate(i)
                            : m.role === "user"
                              ? () => onResend(i)
                              : undefined
                      }
                      onEdit={access === "owner" && m.role === "user" ? () => onEdit(m.content) : undefined}
                      onContinue={access === "owner" && m.role === "assistant" && m.stopped ? () => onContinue(i) : undefined}
                      // Branch (#72): fork the thread at this message into a new chat. Owner-only
                      // (the server forks only the caller's own conversation) and only for persisted
                      // messages (a fork point needs a real id); hidden for watchers + in-flight rows.
                      onBranch={access === "owner" && m.id ? () => onBranch(i) : undefined}
                      onVariantPrev={() => navVariant(i, -1)}
                      onVariantNext={() => navVariant(i, 1)}
                      // Interactive shopping-list / task-list checkboxes (#131): enabled only when the
                      // caller may write this conversation (owner / edit / prompt) and the message is
                      // persisted (has an id); read-only otherwise (watchers, ghost/in-flight rows).
                      onToggleTodo={
                        m.id && canEditContentIn(access)
                          ? (index, done) => onToggleTodo(m.id!, index, done)
                          : undefined
                      }
                    />
                    );
                  })}
                  {/* Contextual capability nudge (#22): at most one, below the latest reply. */}
                  {suggestion && (
                    <CapabilitySuggestion hint={suggestion} onDismiss={() => onDismissSuggestion(suggestion.id)} />
                  )}
                  {/* Archivist recap (#37): "where you left off", rendered at the BOTTOM of the thread
                      as the newest entry — where a /recap run from the composer expects it, not
                      scrolled off the top. Only the owner / a prompt collaborator can resume into the
                      composer; a read-only watcher just reads + dismisses. While the on-demand
                      `/recap` command runs, the RecapLoading indicator holds this slot so the user
                      sees the recap coming (#37 follow-up) instead of a blank several-second gap; it
                      resolves into the card (or a quiet notice) when forceRecap returns. It sits above
                      the endRef sentinel so the scroll-to-latest effect reveals it like a new message. */}
                  {messages.length > 0 &&
                    (recapping ? (
                      <RecapLoading />
                    ) : recap ? (
                      <RecapCard
                        recap={recap}
                        onDismiss={onDismissRecap}
                        onResume={canPromptIn(access) ? onResumeRecap : undefined}
                      />
                    ) : null)}
                  <div ref={endRef} />
                </>
              )}
            </div>
            {canPromptIn(access) ? (
              <>
              {/* Compact conversation, context-aware (#38): a subtle usage meter that grows a
                  dismissible "Compact" nudge near the window limit. Owner-only (the compact route is
                  owner-scoped) and never on a ghost chat (nothing persisted to compact). */}
              {access === "owner" && !temporary && contextUsage && (
                <CompactionBanner
                  context={contextUsage}
                  dismissed={compactDismissed}
                  compacting={compacting}
                  onCompact={onCompact}
                  onDismiss={onDismissCompact}
                />
              )}
              <Composer
                onSend={handleSend}
                onStop={stopGeneration}
                disabled={sending}
                models={models.filter((m) => m !== "whisper")}
                modelLabels={modelLabels}
                modelCatalog={modelCatalog}
                model={model}
                onModelChange={setModel}
                searchAvailable={searchAvailable}
                searchOn={searchOn}
                onToggleSearch={() => setSearchOn((v) => !v)}
                // Live dictation / streaming STT (#71): the live mic is offered only when the
                // server has a streaming ASR backend configured; else the batch mic is shown.
                dictationAvailable={me.dictation?.available === true}
                dictationNonce={dictationNonce}
                thinkingOn={thinkingOn}
                onToggleThinking={() => setThinkingOn((v) => !v)}
                // Voice / conversational mode (#70): the composer renders the toggle + the status
                // pill; the hands-free loop itself is driven above (useVoiceLoop).
                voiceState={voice.state}
                onToggleVoice={voice.toggle}
                onVoiceStop={voice.stopTurn}
                voiceNotice={voiceNotice}
                // Drag-and-drop + click-to-attach (#129) ride the `files` entitlement — the
                // server re-checks it on every /api/files upload. Absent hint ⇒ allowed.
                filesEnabled={me.features?.["files"] !== false}
                // Whether the ACTIVE model can read attachments (#136): only Omni/multimodal models
                // (non-text `input` modality) accept files; text-only models disable the affordance.
                attachSupported={modelAcceptsAttachments(modelCatalog[model || models[0]]?.input)}
                draft={draft}
                focusNonce={focusNonce}
                modelPickerNonce={modelPickerNonce}
                // Composer slash commands (#37 follow-up): `/recap` and future one-line-entry commands.
                // Reuses the existing recap force path so the typed command shares the auto-surface card.
                slashContext={{ conversationId, runRecap: (id: string) => void runRecap(id) }}
              />
              </>
            ) : (
              // Viewing a conversation shared WITH the caller at a non-prompt role — read +
              // live-watch only. The owner (or a future "prompt" collaborator, #46) sends here.
              <div className="composer-readonly muted small" role="note">
                {t("shared.readOnly")}
              </div>
            )}
          </main>
        </div>
      </div>
      {accountSection && (
        <AccountModal
          me={me}
          section={accountSection}
          onSection={setAccountSection}
          onClose={() => setAccountSection(null)}
          onUserChange={onUserChange}
          onOpenConversation={(id) => {
            setAccountSection(null);
            openConversation(id);
          }}
        />
      )}
      {showPalette && <CommandPalette items={paletteItems} onClose={() => setShowPalette(false)} />}
      {activeCap && (
        // A throw in the drawer (MapLibre, geocoding, …) is contained to a compact panel
        // instead of unmounting the whole app to a dark screen. Dismiss runs the same close.
        <ErrorBoundary fallback={<CapabilityErrorPanel onClose={() => setActiveCap(null)} />}>
          <CapabilitySurface capId={activeCap} requests={capRequests[activeCap] ?? []} onClose={() => setActiveCap(null)} />
        </ErrorBoundary>
      )}
    </div>
    </CapabilityProvider>
  );
}

interface Suggestion {
  value: string;
  label: string;
  desc?: string;
  replace: string;
}

// One row in the composer's "/"-menu. A "command" runs a client action (from the slash-command
// registry); a "complete" fills the box with a `/model` completion. Discriminated so the keyboard
// + click handlers dispatch the right behavior and Enter only ever runs the command kind.
type MenuRow =
  | { kind: "command"; key: string; label: string; desc?: string; command: SlashCommand }
  | { kind: "complete"; key: string; label: string; desc?: string; replace: string };

// Chat commands typed into the composer and SENT to the server (distinct from the client-side
// composer commands in ../lib/slashCommands, which run locally and never reach /chat). `/model`
// is the sole one — it lists/switches the model, and takes an argument the block below completes.
const MODEL_COMMANDS = [{ name: "model", descKey: "composer.modelDesc" }] as const;

function getSuggestions(v: string, models: string[], t: TFunc, label: (id: string) => string): Suggestion[] {
  if (!v.startsWith("/")) return [];
  const sp = v.indexOf(" ");
  if (sp === -1) {
    const token = v.slice(1).toLowerCase();
    return MODEL_COMMANDS.filter((c) => c.name.startsWith(token)).map((c) => ({
      value: c.name,
      label: `/${c.name}`,
      desc: t(c.descKey),
      replace: `/${c.name} `,
    }));
  }
  const cmd = v.slice(1, sp).toLowerCase();
  const arg = v.slice(sp + 1).toLowerCase();
  if (cmd === "model") {
    // Match on both the friendly name and the id; display the friendly name, but the
    // completed value stays the id (the wire value Jano switches on).
    return models
      .filter((m) => m.toLowerCase().includes(arg) || label(m).toLowerCase().includes(arg))
      .map((m) => ({ value: m, label: label(m), desc: t("composer.switchTo", { model: label(m) }), replace: `/model ${m}` }));
  }
  return [];
}

// Dictation mic is hidden for a cleaner composer; Voice mode (#70) is the single voice entry
// point. Flip to re-enable — all the dictation wiring (batch recorder, live streaming, the
// mod+shift+u shortcut) stays intact behind it.
const DICTATION_MIC_ENABLED = false;

function Composer({
  onSend,
  onStop,
  disabled,
  models,
  modelLabels,
  modelCatalog,
  model,
  onModelChange,
  searchAvailable,
  searchOn,
  onToggleSearch,
  dictationAvailable,
  dictationNonce,
  thinkingOn,
  onToggleThinking,
  voiceState,
  onToggleVoice,
  onVoiceStop,
  voiceNotice,
  filesEnabled,
  attachSupported,
  draft,
  focusNonce,
  modelPickerNonce,
  slashContext,
}: {
  onSend: (t: string, fileIds?: string[]) => void;
  onStop: () => void;
  disabled: boolean;
  models: string[];
  modelLabels: Record<string, string>;
  // Enriched catalog keyed by id (#63) — feeds the richer picker's badges + search (#17).
  modelCatalog: Record<string, CatalogModel>;
  model: string;
  onModelChange: (m: string) => void;
  // Web search ("Research"): the toggle is rendered only when available to this caller.
  searchAvailable: boolean;
  searchOn: boolean;
  onToggleSearch: () => void;
  // Live dictation / streaming STT (#71): when true the mic streams partials live into the field
  // (falling back to batch when the browser can't capture audio); when false the mic is the
  // existing batch Whisper recorder. `dictationNonce` bumps to toggle it from the shortcut.
  dictationAvailable: boolean;
  dictationNonce: number;
  // Thinking (#68 follow-up): opt in to model reasoning (enable_thinking). Always rendered.
  thinkingOn: boolean;
  onToggleThinking: () => void;
  // Voice / conversational mode (#70): the current loop phase (off = the toggle is off), plus the
  // on/off gesture and the pill's "end my turn / interrupt" action. Notice surfaces mic/STT errors.
  voiceState: VoiceState;
  onToggleVoice: () => void;
  onVoiceStop: () => void;
  voiceNotice: MessageKey | null;
  // Attachments (#129): render the attach button + drag-and-drop drop-zone only when the
  // caller is entitled to the `files` feature (re-checked server-side on upload).
  filesEnabled: boolean;
  // Whether the ACTIVE model can read attachments (#136). When false the attach button is
  // disabled with a reason, a file drag shows a red "not supported" overlay and is rejected,
  // and a send carrying already-attached files is blocked with a clear notice.
  attachSupported: boolean;
  draft: ComposerDraft;
  focusNonce: number;
  // Bumped by the model-picker shortcut to toggle the ModelPicker open.
  modelPickerNonce: number;
  // Client-side composer slash commands (#37 follow-up): the ctx `available`/`run` close over
  // (the open conversation + the recap force path). Rebuilt by ChatView each render.
  slashContext: SlashCommandContext;
}) {
  const t = useT();
  const enterToSend = usePreferences().behavior.enterToSend;
  const [v, setV] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Live dictation / streaming STT (#71): whether the live mic is currently streaming partials
  // into the field. Distinct from `recording` (batch capture) and `transcribing` (batch upload).
  const [listening, setListening] = useState(false);
  // Voice-input failure (mic access denied or a failed transcription) — surfaced as an
  // in-voice composer notice instead of the old silent swallow (#42). Cleared on the next
  // recording and on a successful transcription.
  const [voiceError, setVoiceError] = useState<MessageKey | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Live-dictation session + its running transcript reconciler (#71). The reconciler is the pure
  // module (lib/dictation) — all the interim/final merge logic lives there, tested without a mic.
  const dictationRef = useRef<DictationSession | null>(null);
  const transcriptRef = useRef<TranscriptState | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // In-prompt attachments (upload via the shared /api/files pipeline) + their little gallery.
  const attachments = useAttachments();
  // Whether a file is currently dragged over the composer, so the "Drop the files here"
  // overlay shows. A depth counter (not a bare boolean) absorbs the dragenter/dragleave
  // pair that fires as the cursor crosses child elements — the overlay only clears when the
  // pointer has truly left the composer (depth back to 0), not on every internal boundary.
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Apply an externally-supplied draft (e.g. "Edit" on a past message) and focus.
  useEffect(() => {
    if (draft.nonce === 0) return;
    setV(draft.text);
    setDismissed(true);
    inputRef.current?.focus();
  }, [draft]);

  // Grab focus on demand (e.g. the new/temporary-chat shortcuts) without touching the
  // text, so the user can start typing the moment a fresh thread opens. Skips the
  // initial mount (nonce 0) so we don't steal focus on first paint.
  useEffect(() => {
    if (focusNonce === 0) return;
    inputRef.current?.focus();
  }, [focusNonce]);

  // Auto-grow the composer to fit its content as the user adds lines (Shift+Enter).
  // It expands up to the CSS max-height (half the viewport); past that the textarea
  // caps and scrolls internally. Runs on every value change, including the reset to ""
  // after sending, which collapses it back to a single row.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // box-sizing is border-box app-wide, so the border isn't part of scrollHeight —
    // add it back or the textarea ends up ~2px short and shows a phantom scrollbar.
    const cs = getComputedStyle(el);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = `${el.scrollHeight + border}px`;
  }, [v]);

  // The composer's "/"-triggered menu unifies two kinds of row into one keyboard-navigable list:
  //  - "command": a client-side action from the registry (e.g. "/recap") — activating it RUNS the
  //    action and clears the box; it is never sent to the model.
  //  - "complete": the existing `/model` text completion — activating it fills the box, and Enter
  //    still SENDS it to the server (the chat-command path is unchanged).
  // Commands come first so a bare "/" highlights an action, not a completion.
  const commandMatches = matchSlashCommands(v, slashContext);
  const modelSuggestions = getSuggestions(v, models, t, (id) => modelLabels[id] ?? id);
  const menuRows: MenuRow[] = [
    ...commandMatches.map((c): MenuRow => ({ kind: "command", key: `cmd:${c.id}`, label: `/${c.name}`, desc: t(c.hint), command: c })),
    ...modelSuggestions.map((s): MenuRow => ({ kind: "complete", key: `mdl:${s.value}`, label: s.label, desc: s.desc, replace: s.replace })),
  ];
  const open = menuRows.length > 0 && !dismissed;
  // The send affordance turns blue only once there's something to send (ChatGPT-style);
  // empty/whitespace-only keeps it grey and inert.
  const ready = v.trim().length > 0;
  // The active model can't read files yet there ARE uploaded files staged (#136): show a notice
  // and block the send until the user switches to an Omni model or removes them.
  const attachBlocked = !attachSupported && attachments.items.some((a) => a.status === "ready");
  // Voice mode (#70) view state: whether the loop is running, its phase label, and (when the phase
  // is actionable) what tapping the status pill does.
  const voiceOn = voiceState !== "off";
  const voiceStatus = voiceStatusKey(voiceState);
  const voiceAction = voiceActionKey(voiceState);

  // Run a client slash command against the live context, then clear the composer (a command is an
  // action, not a message). Unavailable commands are never surfaced, so callers pass runnable ones.
  function runSlashCommand(c: SlashCommand) {
    c.run(slashContext);
    setV("");
    setActive(0);
    setDismissed(false);
  }

  function submit() {
    const text = v.trim();
    if (!text || disabled) return;
    // Guard: a recognized composer command (e.g. "/recap") is an ACTION, never a chat message —
    // run it if it's runnable, else swallow it (a safe no-op). Either way it is not sent, so
    // "/recap" typed on a screen where it can't run still never reaches the model as literal text.
    const cmd = exactSlashCommand(text);
    if (cmd) {
      if (cmd.available(slashContext)) cmd.run(slashContext);
      setV("");
      setActive(0);
      setDismissed(false);
      return;
    }
    // Deliver only the attachments that finished uploading (files-to-prompt, #128) — a chip still
    // uploading or in error has no server file id yet and is simply left behind. The server
    // re-validates every id belongs to the caller before inlining its text.
    const fileIds = attachments.items
      .filter((a) => a.status === "ready" && a.fileId)
      .map((a) => a.fileId as string);
    // Never send text-blind attachments to a model that can't read them (#136): if the user
    // attached files on an Omni model then switched to a text one, block the send. The notice
    // (rendered below the gallery) already explains why, so this is a silent, safe no-op.
    if (fileIds.length > 0 && !attachSupported) return;
    onSend(text, fileIds.length > 0 ? fileIds : undefined);
    setV("");
    setDismissed(false);
    // Reset the in-prompt gallery for the next message (the files stay in the caller's file
    // manager; a reload of this conversation shows them attached to the message just sent).
    attachments.clear();
  }
  // Activate the highlighted (or clicked) menu row: run a command, or complete a `/model` text.
  // This is the "pick it" gesture (Enter on a command / a click) — a command RUNS.
  function activateRow(i: number) {
    const row = menuRows[i];
    if (!row) return;
    if (row.kind === "command") {
      runSlashCommand(row.command);
    } else {
      setV(row.replace);
      setActive(0);
      setDismissed(false);
    }
  }
  // Tab COMPLETES the highlighted row without running it: a command row autocompletes its name
  // (`/rec` -> `/recap`) so the user can review then press Enter to run; a "/model" completion
  // fills its replacement text (unchanged). Deliberately distinct from activateRow — Tab never
  // executes a command, it only types it, and the menu stays open on the now-fuller text.
  function completeRow(i: number) {
    const row = menuRows[i];
    if (!row) return;
    setV(row.kind === "command" ? `/${row.command.name}` : row.replace);
    setActive(0);
    setDismissed(false);
  }

  async function startRec() {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        for (const t of stream.getTracks()) t.stop();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        setTranscribing(true);
        try {
          const text = await transcribe(blob);
          if (text) setV((prev) => (prev ? `${prev.trimEnd()} ` : "") + text);
        } catch (e) {
          // Don't strand the user who just spoke with no feedback — say the transcription
          // failed (or that we couldn't reach the server) with a clear next step (#42).
          setVoiceError(isNetworkError(e) ? "error.network" : "composer.transcribeError");
        }
        setTranscribing(false);
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      // getUserMedia rejected: permission denied or no microphone. Tell them what to check.
      setVoiceError("composer.micError");
    }
  }
  function stopRec() {
    recRef.current?.stop();
    setRecording(false);
  }

  // Live dictation / streaming STT (#71). Streams partial transcripts into the composer AS the
  // user speaks (each partial replaces the interim tail; a final commits) via the pure reconciler.
  // Falls back to the batch mic transparently when streaming can't START (mic denied / recorder
  // unusable). A mid-stream upstream error surfaces a notice and commits whatever was captured.
  async function startLiveDictation() {
    setVoiceError(null);
    // The current composer text is the base: dictation appends to it, never clobbers it.
    transcriptRef.current = initTranscript(v);
    try {
      const session = await streamDictation({
        onEvent: (ev, terminal) => {
          // Thread the terminal-segment flag through so only the ?final=1 segment commits (#218).
          const next = applyDictationEvent(transcriptRef.current ?? initTranscript(v), ev, terminal);
          transcriptRef.current = next;
          setV(renderTranscript(next));
        },
        onError: (e) => {
          setVoiceError(isNetworkError(e) ? "error.network" : "composer.dictationError");
          stopLiveDictation();
        },
        onStop: () => {
          // Commit any trailing interim (stream ended on a partial) and reset.
          const committed = commitInterim(transcriptRef.current ?? initTranscript(v));
          setV(renderTranscript(committed));
          transcriptRef.current = null;
          dictationRef.current = null;
          setListening(false);
        },
      });
      dictationRef.current = session;
      setListening(true);
    } catch {
      // Couldn't open the live mic — fall back to the existing batch recorder transparently.
      transcriptRef.current = null;
      void startRec();
    }
  }
  function stopLiveDictation() {
    dictationRef.current?.stop();
    // onStop (from streamDictation) commits the transcript + clears `listening`.
  }
  // Toggle the live mic from the shortcut (#71). Skips the initial mount (nonce 0). When the
  // server has no streaming backend, or the browser can't capture audio, this no-ops (the
  // shortcut simply does nothing rather than surprising the user with the batch recorder).
  useEffect(() => {
    if (dictationNonce === 0) return;
    if (listening) stopLiveDictation();
    else if (dictationAvailable && dictationSupported()) void startLiveDictation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictationNonce]);

  // Which action the mic button takes on click: stop whatever is running, else start the live
  // path when available + supported, else the batch recorder. Keeps the single mic affordance.
  function onMicClick() {
    if (listening) return stopLiveDictation();
    if (recording) return stopRec();
    if (dictationAvailable && dictationSupported()) return void startLiveDictation();
    return void startRec();
  }

  // Files picked through the attach button. Reset the input's value after so re-picking the
  // same file fires `change` again.
  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length) attachments.addFiles(files);
    e.target.value = "";
  }

  // Drag-and-drop (#129). Only react to real file drags — a text/selection/link drag never
  // shows the overlay and drops through untouched. preventDefault on enter/over is what makes
  // the element a valid drop target (so `drop` fires) and stops the browser from navigating
  // to the file. The depth counter tolerates the enter/leave churn across child nodes.
  function onDragEnter(e: React.DragEvent) {
    if (!filesEnabled || !dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!filesEnabled || !dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
  }
  function onDragLeave(e: React.DragEvent) {
    // Decrement off the depth state, NOT a fresh dragHasFiles check: some browsers report an
    // empty dataTransfer.types on `dragleave`, and re-gating on it there could strand the
    // overlay open. We only ever incremented for a real file drag, so any leave while depth>0
    // belongs to it; a text drag never bumped depth, so its leaves are ignored here.
    if (!filesEnabled || dragDepth.current === 0) return;
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current === 0) setDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    if (!filesEnabled || !dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    // Reject the drop on a model that can't read files (#136): the red overlay already told the
    // user; consume the event (no navigation) but upload nothing.
    if (!attachSupported) return;
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) attachments.addFiles(files);
  }

  return (
    <div
      className="composer-wrap"
      onDragEnter={filesEnabled ? onDragEnter : undefined}
      onDragOver={filesEnabled ? onDragOver : undefined}
      onDragLeave={filesEnabled ? onDragLeave : undefined}
      onDrop={filesEnabled ? onDrop : undefined}
    >
      {open && (
        <div className="ac-list" id="composer-ac-list" role="listbox" aria-label={t("composer.commandsLabel")}>
          {menuRows.map((row, i) => (
            <button
              key={row.key}
              id={`ac-option-${i}`}
              role="option"
              aria-selected={i === active}
              type="button"
              className={`ac-item ${i === active ? "active" : ""}`}
              onMouseMove={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                activateRow(i);
              }}
            >
              <span className="ac-label">{row.label}</span>
              {row.desc ? <span className="ac-desc muted">{row.desc}</span> : null}
            </button>
          ))}
          {/* Non-option footer hint — presentation-only so it isn't announced as a listbox item. */}
          <div className="ac-hint muted" role="presentation">{t("composer.acHint")}</div>
        </div>
      )}
      <div className="composer">
        {filesEnabled && dragging && (
          // Drop-zone overlay (#129): the dashed cut-out frame + label the classic drop target
          // shows while a file hovers. It lives INSIDE `.composer` (a positioned ancestor) so its
          // `inset:0` maps to the rounded card only, not the footer disclaimer below (#136).
          // pointer-events:none so it never becomes the drag target itself (the depth counter on
          // the wrap owns enter/leave). When the active model can't read files it turns red and
          // reads "not supported" (#136). Fade honors prefers-reduced-motion via CSS.
          <div className={`composer-dropzone ${attachSupported ? "" : "rejected"}`} aria-hidden="true">
            <div className="composer-dropzone-inner">
              <Paperclip size={22} strokeWidth={1.75} aria-hidden="true" />
              <span>{attachSupported ? t("composer.dropHere") : t("composer.dropUnsupported")}</span>
            </div>
          </div>
        )}
        {attachments.items.length > 0 && (
          <ul className="composer-attachments">
            {attachments.items.map((a) => (
              <AttachmentChip key={a.localId} att={a} onRemove={() => attachments.remove(a.localId)} />
            ))}
          </ul>
        )}
        {attachBlocked && (
          <p className="composer-notice" role="alert">
            {t("composer.attachBlocked")}
          </p>
        )}
        {attachments.limitHit && (
          <p className="composer-notice" role="alert">
            {t("composer.attachLimit", { max: MAX_ATTACHMENTS })}
          </p>
        )}
        {voiceError && (
          <p className="composer-notice" role="alert">
            {t(voiceError)}
          </p>
        )}
        {/* Voice mode (#70) failure (mic denied / STT down) — same notice treatment as dictation. */}
        {voiceNotice && (
          <p className="composer-notice" role="alert">
            {t(voiceNotice)}
          </p>
        )}
        {/* Voice mode status pill: announces the phase (aria-live) and, when the phase is
            actionable, doubles as the tap-to-end-turn / tap-to-interrupt control. The pulsing dot
            is reduced-motion-gated in CSS. Never shown when voice mode is off. */}
        {voiceOn && voiceStatus && (
          <div className="composer-voice-status" role="status" aria-live="polite">
            <span className={`composer-voice-dot phase-${voiceState}`} aria-hidden="true" />
            <span className="composer-voice-phase">{t(voiceStatus)}</span>
            {voiceAction && (
              <button type="button" className="composer-voice-action" onClick={onVoiceStop} aria-label={t(voiceAction)}>
                {t(voiceAction)}
              </button>
            )}
          </div>
        )}
        {listening && (
          // Live dictation is running (#71). role=status announces it politely; the pulsing dot is
          // reduced-motion-gated in CSS (the OS query + the app's data-motion="reduced" rule).
          <p className="composer-notice dictation-live" role="status" aria-live="polite">
            <span className="dictation-dot" aria-hidden="true" />
            {t("composer.listening")}
          </p>
        )}
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={v}
          placeholder={t("composer.placeholder")}
          // Combobox pattern for the "/"-menu: the textarea owns the listbox and points at the
          // active option so a screen reader announces the highlighted command as the user arrows.
          role="combobox"
          aria-expanded={open}
          aria-controls="composer-ac-list"
          aria-autocomplete="list"
          aria-activedescendant={open ? `ac-option-${active}` : undefined}
          onChange={(e) => {
            setV(e.target.value);
            setActive(0);
            setDismissed(false);
          }}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, menuRows.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
                return;
              }
              if (e.key === "Tab") {
                // Tab autocompletes the highlighted row (a command's name, or a /model text) —
                // it never runs a command. Enter (below) is what RUNS a highlighted command.
                e.preventDefault();
                completeRow(active);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(true);
                return;
              }
              // Enter on a highlighted client command RUNS it (and clears) instead of sending —
              // a `/model` completion falls through to the send handler below, unchanged.
              if (e.key === "Enter" && menuRows[active]?.kind === "command") {
                e.preventDefault();
                activateRow(active);
                return;
              }
            }
            if (e.key === "Enter") {
              // Behavior preference (#11): with enterToSend (default) Enter sends and
              // Shift+Enter inserts a newline; with it off, plain Enter is a newline and
              // ⌘/Ctrl+Enter sends. When it's a newline we let the textarea's default run.
              const sends = enterToSend ? !e.shiftKey : e.metaKey || e.ctrlKey;
              if (sends) {
                e.preventDefault();
                submit();
              }
            }
          }}
          disabled={disabled}
        />
        <div className="composer-toolbar">
          <div className="composer-tools-left">
            <ModelPicker model={model} models={models} labels={modelLabels} catalog={modelCatalog} onSelect={onModelChange} disabled={disabled} openNonce={modelPickerNonce} />
            {filesEnabled && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="composer-file-input"
                  onChange={onPickFiles}
                  aria-hidden="true"
                  tabIndex={-1}
                />
                <button
                  type="button"
                  className="composer-attach"
                  onClick={() => fileInputRef.current?.click()}
                  // Disabled on a text-only model (#136) — it can't read files. The title/aria
                  // carries the reason so the affordance explains itself on hover + to a11y tech.
                  disabled={disabled || !attachSupported}
                  title={attachSupported ? t("composer.attach") : t("composer.attachUnsupported")}
                  aria-label={attachSupported ? t("composer.attach") : t("composer.attachUnsupported")}
                >
                  <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </>
            )}
            {searchAvailable && (
              <button
                type="button"
                className={`composer-search ${searchOn ? "active" : ""}`}
                onClick={onToggleSearch}
                aria-pressed={searchOn}
                title={searchOn ? t("search.tooltipOn") : t("search.tooltipOff")}
                aria-label={searchOn ? t("search.tooltipOn") : t("search.tooltipOff")}
              >
                <Globe size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="composer-search-label">{t("search.label")}</span>
              </button>
            )}
            <button
              type="button"
              className={`composer-thinking ${thinkingOn ? "active" : ""}`}
              onClick={onToggleThinking}
              aria-pressed={thinkingOn}
              title={thinkingOn ? t("thinking.tooltipOn") : t("thinking.tooltipOff")}
              aria-label={thinkingOn ? t("thinking.tooltipOn") : t("thinking.tooltipOff")}
            >
              <the workstation size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="composer-thinking-label">{t("thinking.label")}</span>
            </button>
            {/* Voice / conversational mode (#70): a sibling toggle to Search/Thinking. On, it runs
                the hands-free loop (never auto-starting the mic until this gesture). */}
            <button
              type="button"
              className={`composer-voice ${voiceOn ? "active" : ""}`}
              onClick={onToggleVoice}
              aria-pressed={voiceOn}
              title={voiceOn ? t("voice.tooltipOn") : t("voice.tooltipOff")}
              aria-label={voiceOn ? t("voice.tooltipOn") : t("voice.tooltipOff")}
            >
              <AudioLines size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="composer-voice-label">{t("voice.label")}</span>
            </button>
          </div>
          <div className="composer-tools-right">
            {/* Standalone dictation mic — hidden behind DICTATION_MIC_ENABLED for a cleaner
                composer (Voice mode #70 is the single voice entry point). The handlers/state stay
                wired (incl. the mod+shift+u shortcut) so flipping the flag brings it right back. */}
            {DICTATION_MIC_ENABLED && (
              <button
                type="button"
                className={`mic ${recording || listening ? "rec" : ""}`}
                // Disabled while voice mode owns the mic — the recorders can't run at once (#70). The
                // click handler picks live dictation vs. the batch recorder when the mic is free (#71).
                onClick={onMicClick}
                disabled={disabled || transcribing || voiceOn}
                title={
                  listening
                    ? t("composer.stopDictation")
                    : recording
                      ? t("composer.stopRecording")
                      : dictationAvailable
                        ? t("composer.liveDictation")
                        : t("composer.voiceInput")
                }
                aria-label={dictationAvailable ? t("composer.liveDictation") : t("composer.voiceInput")}
                aria-pressed={listening}
              >
                {transcribing ? (
                  <span className="mic-busy" />
                ) : recording || listening ? (
                  <Square size={16} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
                ) : (
                  <Mic size={16} strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
            )}
            {disabled ? (
              <button
                type="button"
                className="composer-send stop"
                onClick={onStop}
                title={t("composer.stopGenerating")}
                aria-label={t("composer.stopGenerating")}
              >
                <Square size={18} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                onClick={submit}
                disabled={!ready}
                title={t("composer.send")}
                aria-label={t("composer.send")}
              >
                <ArrowUp size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-disclaimer muted">{t("composer.disclaimer")}</div>
    </div>
  );
}

// One pending attachment in the composer's in-prompt gallery: an image thumbnail (or a
// generic file glyph), the name, and a remove control. The status drives the trailing hint —
// a spinner while uploading, a localized error line if the upload was rejected.
function AttachmentChip({ att, onRemove }: { att: Attachment; onRemove: () => void }) {
  const t = useT();
  const errorText =
    att.errorReason === "too_large"
      ? t("files.errorTooLarge")
      : att.errorReason === "quota"
        ? t("files.errorQuota")
        : t("files.errorGeneric");
  return (
    <li className={`composer-attachment ${att.status === "error" ? "error" : ""}`}>
      <span className="composer-attachment-thumb" aria-hidden="true">
        {att.isImage && att.previewUrl ? (
          <img src={att.previewUrl} alt="" />
        ) : (
          <Paperclip size={14} strokeWidth={1.75} />
        )}
      </span>
      <span className="composer-attachment-meta">
        <span className="composer-attachment-name" title={att.name}>
          {att.name}
        </span>
        <span className="composer-attachment-sub muted">
          {att.status === "uploading"
            ? t("files.uploading")
            : att.status === "error"
              ? errorText
              : formatBytes(att.size)}
        </span>
      </span>
      <button
        type="button"
        className="composer-attachment-remove"
        onClick={onRemove}
        title={t("composer.removeAttachment")}
        aria-label={t("composer.removeAttachment")}
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </li>
  );
}

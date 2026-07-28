import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import type { ApiMessage, ConversationMeta, Me } from "../lib/api";
import type { ChatEvents, CommandResult } from "../lib/chat";
import { DEFAULT_PREFERENCES, syncPreferences } from "../lib/preferences";

// ChatView is the whole app shell. We mock the network seams (../lib/api, ../lib/chat) and
// the streaming-markdown renderer (streamdown) so tests are deterministic + offline, then
// drive the major flows: conversation list, send (-> sendChat), the model picker + /model
// autocomplete, queue + remind wiring, sidebar collapse/resize, the capability drawer,
// temp chat, and stop/regenerate.

// --- streamdown: render assistant markdown as plain text (no heavy pipeline in jsdom) ----
// The real Streamdown runs the remark capability plugin + a span override that turns
// [[id:payload]] markers into inline chips. We don't want the heavy markdown pipeline in
// jsdom, so the mock reproduces just that: plain text passthrough, but with markers split
// out into real <CapabilityMarker> chips (which wire through the CapabilityProvider exactly
// like production). Everything else renders as text.
vi.mock("streamdown", async () => {
  const { CapabilityMarker } = await import("../capabilities/marker");
  const MARKER = /\[\[([a-z][\w-]*):([^\]]+)\]\]/gi;
  // A GFM task-list checkbox line (marker prefix, `[ ]`/`[x]`, then content).
  const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+(.*)$/;
  const renderText = (text: string, keyBase: string): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    let last = 0;
    MARKER.lastIndex = 0;
    let key = 0;
    for (let m = MARKER.exec(text); m !== null; m = MARKER.exec(text)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(<CapabilityMarker key={`${keyBase}-${key++}`} capId={m[1].toLowerCase()} payload={m[2].trim()} />);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };
  return {
    Streamdown: ({ children, components }: { children?: string; components?: { input?: (p: unknown) => React.ReactNode } }) => {
      const text = children ?? "";
      const lines = text.split("\n");
      // When the message carries a task list AND a checkbox override is wired (the owner /
      // collaborator interactive path, #131), render each checkbox through `components.input`
      // in document order — the same seam Message.tsx uses to attach its click handler — so the
      // toggle flow is exercised in jsdom (the plain-text passthrough below skips it otherwise).
      if (components?.input && lines.some((l) => TASK.test(l))) {
        const input = components.input;
        return (
          <div className="md">
            {lines.map((line, i) => {
              const m = line.match(TASK);
              if (!m) return <div key={i}>{renderText(line, `l${i}`)}</div>;
              return (
                <div key={i}>
                  {input({ type: "checkbox", checked: m[2].toLowerCase() === "x" })} {m[3]}
                </div>
              );
            })}
          </div>
        );
      }
      return <div className="md">{renderText(text, "t")}</div>;
    },
  };
});

// --- CapabilitySurface: avoid lazy-loading the real MapCanvas chunk in the drawer test ---
vi.mock("../capabilities/surface", () => ({
  CapabilitySurface: ({ capId, requests, onClose }: { capId: string; requests: string[]; onClose: () => void }) => (
    <div data-testid="cap-surface">
      <span>cap:{capId}</span>
      <span>reqs:{requests.join("|")}</span>
      <button type="button" onClick={onClose}>
        close-cap
      </button>
    </div>
  ),
}));

// --- ../lib/api mock --------------------------------------------------------------------
const api = {
  fetchModels: vi.fn(),
  fetchModelCatalog: vi.fn(),
  fetchConversations: vi.fn(),
  fetchConversation: vi.fn(),
  renameConversation: vi.fn(),
  generateConversationTitle: vi.fn(),
  setConversationStarred: vi.fn(),
  deleteConversation: vi.fn(),
  branchConversation: vi.fn(),
  fetchRecap: vi.fn(),
  forceRecap: vi.fn(),
  dismissRecap: vi.fn(),
  transcribe: vi.fn(),
  voteMessage: vi.fn(),
  toggleConversationTodo: vi.fn(),
  selectVariant: vi.fn(),
  cancelGeneration: vi.fn(),
  remindByEmail: vi.fn(),
  listInvites: vi.fn(),
  mintInvite: vi.fn(),
  revokeInvite: vi.fn(),
  listAccounts: vi.fn(),
  revokeAccount: vi.fn(),
  updateAccount: vi.fn(),
  resetAccountUsage: vi.fn(),
  getShare: vi.fn(),
  createShare: vi.fn(),
  deleteShare: vi.fn(),
  listCollaborators: vi.fn(),
  inviteCollaborator: vi.fn(),
  updateCollaboratorRole: vi.fn(),
  removeCollaborator: vi.fn(),
  fetchSharedConversations: vi.fn(),
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  fileDownloadUrl: vi.fn(),
};
vi.mock("../lib/api", () => ({
  fetchModels: (...a: unknown[]) => api.fetchModels(...a),
  fetchModelCatalog: (...a: unknown[]) => api.fetchModelCatalog(...a),
  fetchConversations: (...a: unknown[]) => api.fetchConversations(...a),
  fetchConversation: (...a: unknown[]) => api.fetchConversation(...a),
  renameConversation: (...a: unknown[]) => api.renameConversation(...a),
  generateConversationTitle: (...a: unknown[]) => api.generateConversationTitle(...a),
  setConversationStarred: (...a: unknown[]) => api.setConversationStarred(...a),
  deleteConversation: (...a: unknown[]) => api.deleteConversation(...a),
  branchConversation: (...a: unknown[]) => api.branchConversation(...a),
  fetchRecap: (...a: unknown[]) => api.fetchRecap(...a),
  forceRecap: (...a: unknown[]) => api.forceRecap(...a),
  dismissRecap: (...a: unknown[]) => api.dismissRecap(...a),
  transcribe: (...a: unknown[]) => api.transcribe(...a),
  voteMessage: (...a: unknown[]) => api.voteMessage(...a),
  toggleConversationTodo: (...a: unknown[]) => api.toggleConversationTodo(...a),
  selectVariant: (...a: unknown[]) => api.selectVariant(...a),
  cancelGeneration: (...a: unknown[]) => api.cancelGeneration(...a),
  remindByEmail: (...a: unknown[]) => api.remindByEmail(...a),
  listInvites: (...a: unknown[]) => api.listInvites(...a),
  mintInvite: (...a: unknown[]) => api.mintInvite(...a),
  revokeInvite: (...a: unknown[]) => api.revokeInvite(...a),
  listAccounts: (...a: unknown[]) => api.listAccounts(...a),
  revokeAccount: (...a: unknown[]) => api.revokeAccount(...a),
  updateAccount: (...a: unknown[]) => api.updateAccount(...a),
  resetAccountUsage: (...a: unknown[]) => api.resetAccountUsage(...a),
  getShare: (...a: unknown[]) => api.getShare(...a),
  createShare: (...a: unknown[]) => api.createShare(...a),
  deleteShare: (...a: unknown[]) => api.deleteShare(...a),
  listCollaborators: (...a: unknown[]) => api.listCollaborators(...a),
  inviteCollaborator: (...a: unknown[]) => api.inviteCollaborator(...a),
  updateCollaboratorRole: (...a: unknown[]) => api.updateCollaboratorRole(...a),
  removeCollaborator: (...a: unknown[]) => api.removeCollaborator(...a),
  fetchSharedConversations: (...a: unknown[]) => api.fetchSharedConversations(...a),
  listFiles: (...a: unknown[]) => api.listFiles(...a),
  uploadFile: (...a: unknown[]) => api.uploadFile(...a),
  deleteFile: (...a: unknown[]) => api.deleteFile(...a),
  fileDownloadUrl: (...a: unknown[]) => api.fileDownloadUrl(...a),
  // Pure helper ChatView depends on directly — keep the real logic so the read-only composer
  // branch behaves as in production (owner + `prompt` collaborators send; lower roles read+watch).
  canPromptIn: (access: string | undefined) =>
    access === undefined || access === "owner" || access === "prompt",
  // Real logic (like canPromptIn) so the interactive-checkbox branch matches production: owner +
  // edit/prompt collaborators get a live checkbox; view/suggest stay read-only (#131).
  canEditContentIn: (access: string | undefined) =>
    access === undefined || access === "owner" || access === "edit" || access === "prompt",
}));

// --- ../lib/chat mock -------------------------------------------------------------------
const sendChat = vi.fn();
const regenerateChat = vi.fn();
const attachChat = vi.fn();
vi.mock("../lib/chat", () => ({
  sendChat: (...a: unknown[]) => sendChat(...a),
  regenerateChat: (...a: unknown[]) => regenerateChat(...a),
  attachChat: (...a: unknown[]) => attachChat(...a),
}));

// --- ../lib/dictation partial mock (#71) ------------------------------------------------
// Keep the REAL pure reconciler (initTranscript/applyDictationEvent/commitInterim/
// renderTranscript) so the composer's interim/final merge behaves as in production, but stub
// the impure transport (streamDictation) + capability probe (dictationSupported) so tests drive
// live dictation without a mic.
const dictation = {
  dictationSupported: vi.fn(),
  streamDictation: vi.fn(),
};
vi.mock("../lib/dictation", async () => {
  const actual = await vi.importActual<typeof import("../lib/dictation")>("../lib/dictation");
  return {
    ...actual,
    dictationSupported: (...a: unknown[]) => dictation.dictationSupported(...a),
    streamDictation: (...a: unknown[]) => dictation.streamDictation(...a),
  };
});

// --- ../lib/route partial mock ----------------------------------------------------------
// Keep the real URL parsing (currentConversationId) + navigation side effects, but wrap
// navigateToNew as a spy so the "redirect home" tests can assert it fired.
const navigateToNew = vi.fn();
vi.mock("../lib/route", async () => {
  const actual = await vi.importActual<typeof import("../lib/route")>("../lib/route");
  return {
    ...actual,
    navigateToNew: (...a: unknown[]) => {
      navigateToNew(...a);
      return actual.navigateToNew(...(a as [boolean?]));
    },
  };
});

import { ChatView } from "./ChatView";

const ME_ADMIN: Me = {
  role: "admin",
  via: "owner", // the owner-by-handle admin (#191) — a real passkey session, so sign-out works
  user: { id: "u1", login: "leo", displayName: "Leo" },
  key: null,
  theme: null,
  lang: null,
  search: { available: true },
};

const ME_GUEST: Me = {
  role: "guest",
  via: "bearer",
  user: { id: "u2", login: "guest", displayName: null },
  key: { id: "k1", label: "key" },
  theme: null,
  lang: null,
  search: { available: false },
};

// An admin whose server advertises live dictation (#71). Shared by the dictation tests, which
// now drive the mod+shift+u shortcut (the standalone mic button is hidden, DICTATION_MIC_ENABLED).
const ME_DICTATION: Me = { ...ME_ADMIN, dictation: { available: true } };

function convo(over: Partial<ConversationMeta> = {}): ConversationMeta {
  return { id: "c1", title: "First chat", model: "qwen", starred: false, updatedAt: 1, ...over };
}

function apiMsg(over: Partial<ApiMessage> = {}): ApiMessage {
  return { id: "m1", role: "user", content: "hi", model: null, vote: 0, createdAt: 1, ...over };
}

const MODELS = { models: ["qwen", "llama", "whisper"], labels: { qwen: "Qwen 3", llama: "Llama 3" }, default: "qwen" };
// Enriched catalog for the attachment gate (#136) + richer picker (#17): the default "qwen" is a
// free multimodal model (accepts files) so the drag/attach happy-path tests exercise the enabled
// state; "llama" is a text-only, BYOK-only "pro" model so the picker's $$ badge + BYOK tag + tier
// filters have something to render.
const CATALOG = {
  models: [
    { id: "qwen", displayName: "Qwen 3", input: ["text", "image"], tier: "free", byokOnly: false, provider: "qwen", recommendedFor: ["general"] },
    { id: "llama", displayName: "Llama 3", input: ["text"], tier: "pro", byokOnly: true, provider: "meta", recommendedFor: ["coding"] },
  ],
  default: "qwen",
};

beforeEach(() => {
  installLocalStorage();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  api.fetchModels.mockResolvedValue(MODELS);
  api.fetchModelCatalog.mockResolvedValue(CATALOG);
  api.fetchConversations.mockResolvedValue([]);
  api.fetchConversation.mockResolvedValue({ conversation: convo(), messages: [] });
  api.renameConversation.mockResolvedValue(undefined);
  api.generateConversationTitle.mockResolvedValue("Generated title");
  api.setConversationStarred.mockResolvedValue(undefined);
  api.deleteConversation.mockResolvedValue(undefined);
  api.branchConversation.mockResolvedValue(convo({ id: "c2", title: "T" }));
  api.fetchRecap.mockResolvedValue(null); // no recap by default (fresh/short threads)
  api.forceRecap.mockResolvedValue(null); // /recap: no recap by default (too-thin threads)
  api.dismissRecap.mockResolvedValue(undefined);
  api.voteMessage.mockResolvedValue(undefined);
  api.toggleConversationTodo.mockResolvedValue("- [x] eggs\n- [ ] flour");
  api.cancelGeneration.mockResolvedValue(undefined);
  api.remindByEmail.mockResolvedValue(undefined);
  api.listInvites.mockResolvedValue([]);
  api.mintInvite.mockResolvedValue({ token: "inv", invite: { id: "i", label: null } });
  api.revokeInvite.mockResolvedValue(undefined);
  api.listAccounts.mockResolvedValue([]);
  api.revokeAccount.mockResolvedValue(undefined);
  api.updateAccount.mockResolvedValue(undefined);
  api.resetAccountUsage.mockResolvedValue(undefined);
  api.getShare.mockResolvedValue({ shared: false, slug: null, url: null });
  api.createShare.mockResolvedValue({ shared: true, slug: "sg", url: "https://a7t.chat/s/sg" });
  api.deleteShare.mockResolvedValue(undefined);
  api.listCollaborators.mockResolvedValue([]);
  api.inviteCollaborator.mockResolvedValue({ ok: true, collaborator: { userId: "u", role: "view" } });
  api.updateCollaboratorRole.mockResolvedValue(undefined);
  api.removeCollaborator.mockResolvedValue(undefined);
  api.fetchSharedConversations.mockResolvedValue([]);
  api.listFiles.mockResolvedValue({ files: [], usage: { count: 0, totalBytes: 0 }, limits: { maxFileBytes: 26214400, maxTotalBytes: 209715200, maxCount: 200 } });
  api.uploadFile.mockResolvedValue({ ok: true, file: { id: "f1", filename: "x", contentType: "text/plain", size: 1, createdAt: 0 } });
  api.deleteFile.mockResolvedValue(undefined);
  api.fileDownloadUrl.mockReturnValue("/api/files/f1");
  sendChat.mockResolvedValue(null);
  regenerateChat.mockResolvedValue(undefined);
  // Live dictation (#71): supported by default; individual tests override.
  dictation.dictationSupported.mockReturnValue(true);
  dictation.streamDictation.mockReset();
  // window.confirm defaults to accept for delete tests.
  vi.spyOn(window, "confirm").mockReturnValue(true);
  // jsdom lacks scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom has no object-URL support — the attachment gallery mints previews for images.
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderView(me: Me = ME_ADMIN, onSignOut = vi.fn()) {
  return render(<ChatView me={me} onSignOut={onSignOut} />);
}

describe("ChatView — conversations list", () => {
  test("renders favorites + recents buckets from fetchConversations", async () => {
    api.fetchConversations.mockResolvedValue([
      convo({ id: "a", title: "Star me", starred: true }),
      convo({ id: "b", title: "Recent one", starred: false }),
    ]);
    renderView();
    expect(await screen.findByText("Star me")).toBeInTheDocument();
    expect(screen.getByText("Recent one")).toBeInTheDocument();
    expect(screen.getByText("Favorites")).toBeInTheDocument();
    expect(screen.getByText("Recents")).toBeInTheDocument();
  });

  test("empty list shows the 'no conversations' note", async () => {
    api.fetchConversations.mockResolvedValue([]);
    renderView();
    expect(await screen.findByText("No conversations yet.")).toBeInTheDocument();
  });

  test("clicking a conversation loads its thread", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Open me" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Open me" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "the question" })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Open me"));
    expect(await screen.findByText("the question")).toBeInTheDocument();
    expect(api.fetchConversation).toHaveBeenCalledWith("c1");
  });

  test("deep-links to a conversation when the URL is /c/<id> on load", async () => {
    window.history.replaceState({}, "", "/c/deep");
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "deep", title: "Deep" }),
      messages: [apiMsg({ id: "m9", role: "assistant", content: "deep answer" })],
    });
    renderView();
    expect(await screen.findByText("deep answer")).toBeInTheDocument();
    expect(api.fetchConversation).toHaveBeenCalledWith("deep");
  });

  // Archivist recap (#37): a stale conversation surfaces the "where you left off" card on open.
  test("shows the recap card when the server returns one, and dismiss hides it + remembers", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Old chat" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Old chat" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "the question" })],
    });
    api.fetchRecap.mockResolvedValue({
      topic: "Lisbon trip",
      progress: ["Chose May", "Shortlisted areas"],
      whereItEnded: "Comparing hotels",
      nextStep: "Pick a hotel",
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Old chat"));

    expect(await screen.findByText("Where you left off")).toBeInTheDocument();
    expect(screen.getByText("Lisbon trip")).toBeInTheDocument();
    expect(api.fetchRecap).toHaveBeenCalledWith("c1");

    // Bottom placement (#37): the recap is the newest entry — it renders AFTER the last message in
    // document order, not pinned above the first, so a return-to-thread recap lands where you are.
    const msgs = document.querySelectorAll<HTMLElement>(".messages [data-mm-index]");
    const lastMsg = msgs[msgs.length - 1];
    const card = document.querySelector("section.recap-card")!;
    expect(lastMsg.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss recap" }));
    expect(api.dismissRecap).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(screen.queryByText("Where you left off")).not.toBeInTheDocument());
  });

  test("the recap resume button seeds the composer with the next step", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Old chat" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Old chat" }),
      messages: [apiMsg({ id: "m1", role: "assistant", content: "an answer" })],
    });
    api.fetchRecap.mockResolvedValue({
      topic: "Lisbon trip",
      progress: ["Chose May"],
      whereItEnded: "Comparing hotels",
      nextStep: "Pick a hotel and book it",
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Old chat"));
    await userEvent.click(await screen.findByRole("button", { name: "Pick up here" }));

    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Pick a hotel and book it"));
    // Seeding resumed into the composer clears the card.
    expect(screen.queryByText("Where you left off")).not.toBeInTheDocument();
  });
});

describe("ChatView — empty state + sending", () => {
  test("shows the empty welcome state with no messages", async () => {
    renderView();
    expect(await screen.findByText("What can I help with?")).toBeInTheDocument();
    // EmptyState renders lane tabs.
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  test("typing + Send calls sendChat with the content and renders the user message", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    await userEvent.type(box, "hello there");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sendChat).toHaveBeenCalled());
    const body = sendChat.mock.calls[0][0];
    expect(body.content).toBe("hello there");
    expect(body.model).toBe("qwen");
    expect(screen.getByText("hello there")).toBeInTheDocument();
  });

  test("Enter (no shift) submits; the composer clears", async () => {
    renderView();
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    await userEvent.type(box, "via enter{Enter}");
    await waitFor(() => expect(sendChat).toHaveBeenCalled());
    expect(box.value).toBe("");
  });

  // Behavior preference (#11): the send/newline key mapping is user-configurable.
  describe("enterToSend preference", () => {
    afterEach(() => syncPreferences(DEFAULT_PREFERENCES)); // reset the shared store

    test("off: plain Enter is a newline (no send); ⌘/Ctrl+Enter sends", async () => {
      syncPreferences({ ...DEFAULT_PREFERENCES, behavior: { ...DEFAULT_PREFERENCES.behavior, enterToSend: false } });
      renderView();
      const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
      await userEvent.type(box, "line one{Enter}line two");
      expect(sendChat).not.toHaveBeenCalled();
      expect(box.value).toContain("line one");
      expect(box.value).toContain("line two");
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
      await waitFor(() => expect(sendChat).toHaveBeenCalled());
    });

    test("on (default): plain Enter sends", async () => {
      syncPreferences(DEFAULT_PREFERENCES);
      renderView();
      await userEvent.type(await screen.findByPlaceholderText(/Message/), "hi{Enter}");
      await waitFor(() => expect(sendChat).toHaveBeenCalled());
    });
  });

  test("send streams assistant deltas into the thread", async () => {
    sendChat.mockImplementation(async (_body: unknown, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "qwen" });
      events.onDelta?.("Hello");
      events.onDelta?.(" world");
      events.onDone?.({ conversationId: "c1", model: "qwen", messageId: "m-done", usage: null });
      return null;
    });
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "ping");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Hello world")).toBeInTheDocument();
  });

  test("clicking an empty-state prompt drops it into the composer", async () => {
    renderView();
    await screen.findByRole("tablist");
    const prompts = screen.getAllByRole("button").filter((b) => b.classList.contains("starter-row"));
    await userEvent.click(prompts[0]);
    const box = screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement;
    expect(box.value.length).toBeGreaterThan(0);
  });

  // #236: focus must never leave the prompt field on send — the field stays live during a turn
  // (a disabled textarea gets blurred by the browser) and the caret returns to it after a send.
  describe("prompt focus stays put (#236)", () => {
    test("the prompt field is not disabled while a turn is in flight", async () => {
      let release: ((v: unknown) => void) | undefined;
      sendChat.mockImplementation(
        (_body: unknown, events: ChatEvents) =>
          new Promise((resolve) => {
            events.onMeta?.({ conversationId: "c1", model: "qwen" });
            release = resolve; // hold the turn open so we can observe the streaming state
          }),
      );
      renderView();
      const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
      await userEvent.type(box, "ping");
      await userEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendChat).toHaveBeenCalled());
      // Mid-turn the composer stays enabled so the browser can't blur focus out of it.
      expect(box.disabled).toBe(false);
      await act(async () => {
        release?.(null);
      });
    });

    test("focus returns to the prompt field after sending via the Send button", async () => {
      renderView();
      const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
      await userEvent.type(box, "hello");
      // Clicking Send moves focus onto the button; submit() must hand it back to the field.
      await userEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendChat).toHaveBeenCalled());
      await waitFor(() => expect(document.activeElement).toBe(box));
    });
  });
});

describe("ChatView — model picker + /model autocomplete", () => {
  test("model picker shows the active label and switches on select", async () => {
    renderView();
    // Picker button shows the friendly label of the default model.
    const pickerBtn = await screen.findByRole("button", { name: "Select model" });
    expect(pickerBtn).toHaveTextContent("Qwen 3");
    await userEvent.click(pickerBtn);
    // Listbox opens with both real models (whisper is filtered out of the composer list).
    const list = screen.getByRole("listbox");
    await userEvent.click(within(list).getByText("Llama 3"));
    // Button now reflects the new model.
    await waitFor(() => expect(screen.getByRole("button", { name: "Select model" })).toHaveTextContent("Llama 3"));
  });

  test("whisper is excluded from the picker list", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Select model" }));
    const list = screen.getByRole("listbox");
    expect(within(list).queryByText("whisper")).toBeNull();
    expect(within(list).getByText("Qwen 3")).toBeInTheDocument();
  });

  test("a premium BYOK-only model shows its $ tier badge and BYOK tag (#17)", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Select model" }));
    const list = screen.getByRole("listbox");
    const llamaRow = within(list).getByText("Llama 3").closest(".model-option") as HTMLElement;
    expect(within(llamaRow).getByText("$$")).toBeInTheDocument(); // "pro" → $$
    expect(within(llamaRow).getByText("BYOK")).toBeInTheDocument();
    // The free local default carries neither badge.
    const qwenRow = within(list).getByText("Qwen 3").closest(".model-option") as HTMLElement;
    expect(within(qwenRow).queryByText("$")).toBeNull();
    expect(within(qwenRow).queryByText("BYOK")).toBeNull();
  });

  test("search narrows the picker list by label / provider (#17)", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Select model" }));
    const search = screen.getByRole("textbox", { name: "Search models" });
    await userEvent.type(search, "llama");
    const list = screen.getByRole("listbox");
    expect(within(list).queryByText("Qwen 3")).toBeNull();
    expect(within(list).getByText("Llama 3")).toBeInTheDocument();
    // A query nothing matches shows the empty note.
    await userEvent.clear(search);
    await userEvent.type(search, "zzz-nope");
    expect(screen.getByText("No models match")).toBeInTheDocument();
  });

  test("the tier filters split free vs premium (#17)", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Select model" }));
    const list = screen.getByRole("listbox");
    await userEvent.click(screen.getByRole("button", { name: "Premium" }));
    expect(within(list).getByText("Llama 3")).toBeInTheDocument();
    expect(within(list).queryByText("Qwen 3")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Free" }));
    expect(within(list).getByText("Qwen 3")).toBeInTheDocument();
    expect(within(list).queryByText("Llama 3")).toBeNull();
  });

  test("favoriting a model persists it and floats it to the top (#17)", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Select model" }));
    // Star the second model; it persists to localStorage and its control flips to "Unfavorite".
    await userEvent.click(screen.getByRole("button", { name: "Favorite Llama 3" }));
    expect(JSON.parse(localStorage.getItem("a7t_chat_model_favorites") ?? "[]")).toEqual(["llama"]);
    expect(screen.getByRole("button", { name: "Unfavorite Llama 3" })).toBeInTheDocument();
    // The starred model is now pinned above the rest.
    const list = screen.getByRole("listbox");
    const names = Array.from(list.querySelectorAll(".model-option-name")).map((n) => n.textContent);
    expect(names[0]).toBe("Llama 3");
    // The "Favorites" filter narrows to just it.
    await userEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(within(list).getByText("Llama 3")).toBeInTheDocument();
    expect(within(list).queryByText("Qwen 3")).toBeNull();
  });

  test("typing /model surfaces the command suggestion", async () => {
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "/model");
    // The autocomplete dropdown shows the /model command + its description.
    const acDesc = await screen.findByText("list or switch the model");
    const acList = acDesc.closest(".ac-list") as HTMLElement;
    expect(acList).not.toBeNull();
    expect(within(acList).getByText("/model")).toBeInTheDocument();
  });

  test("/model <arg> autocompletes against model id + label", async () => {
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "/model lla");
    // Matches the "Llama 3" label / "llama" id.
    expect(await screen.findByText("switch to Llama 3")).toBeInTheDocument();
  });

  test("a /model command result switches the active model (no streamed turn)", async () => {
    sendChat.mockResolvedValue({ type: "command", command: "model.set", model: "llama" } as CommandResult);
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "/model llama{Enter}");
    // System note confirms the switch, and the picker label follows.
    expect(await screen.findByText(/switched model/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Select model" })).toHaveTextContent("Llama 3"));
  });

  test("a /model list command renders the system list note", async () => {
    sendChat.mockResolvedValue({
      type: "command",
      command: "model.list",
      models: ["qwen", "llama"],
      current: "qwen",
    } as CommandResult);
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "/model{Enter}");
    expect(await screen.findByText(/models:/)).toBeInTheDocument();
  });
});

// Composer slash commands (#37 follow-up): typing "/" in the message box opens a command menu;
// "/recap" runs the recap force path (never sent to the model). Behavior-focused — the recap fetch
// (forceRecap) is mocked, and the pure trigger rules are covered in ../lib/slashCommands.test.ts.
describe("ChatView — composer slash commands (/recap)", () => {
  function openThread(title = "Slash chat") {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title }),
      messages: [apiMsg({ id: "m1", role: "user", content: "the question" })],
    });
  }
  const RECAP = { topic: "Lisbon trip", progress: ["Chose May"], whereItEnded: "Comparing hotels", nextStep: "Pick a hotel" };

  test("typing / opens the command menu listing /recap when a conversation is open", async () => {
    openThread();
    renderView();
    await userEvent.click(await screen.findByTitle("Slash chat"));
    await screen.findByText("the question");
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "/");
    // The menu is a listbox with the /recap command (name + hint) above the composer.
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    expect(within(menu).getByText("/recap")).toBeInTheDocument();
    expect(within(menu).getByText("Catch up on this thread")).toBeInTheDocument();
  });

  test("/recap + Enter runs the recap, clears the composer, and does NOT send a message", async () => {
    openThread();
    api.forceRecap.mockResolvedValue(RECAP);
    renderView();
    await userEvent.click(await screen.findByTitle("Slash chat"));
    await screen.findByText("the question");
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    await userEvent.type(box, "/recap{Enter}");

    // The recap force path ran for the open conversation and its card rendered.
    await waitFor(() => expect(api.forceRecap).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("Where you left off")).toBeInTheDocument();
    expect(screen.getByText("Lisbon trip")).toBeInTheDocument();
    // The command cleared the box and was never dispatched to the model.
    await waitFor(() => expect(box.value).toBe(""));
    expect(sendChat).not.toHaveBeenCalled();
  });

  test("clicking the /recap menu item runs the recap", async () => {
    openThread();
    api.forceRecap.mockResolvedValue(RECAP);
    renderView();
    await userEvent.click(await screen.findByTitle("Slash chat"));
    await screen.findByText("the question");
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "/recap");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    await userEvent.click(within(menu).getByText("/recap"));
    await waitFor(() => expect(api.forceRecap).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("Where you left off")).toBeInTheDocument();
    expect(sendChat).not.toHaveBeenCalled();
  });

  test("Escape dismisses the command menu", async () => {
    openThread();
    renderView();
    await userEvent.click(await screen.findByTitle("Slash chat"));
    await screen.findByText("the question");
    const box = await screen.findByPlaceholderText(/Message/);
    await userEvent.type(box, "/recap");
    expect(await screen.findByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull());
  });

  test("a normal message that merely contains a slash mid-text sends unaffected", async () => {
    openThread();
    renderView();
    await userEvent.click(await screen.findByTitle("Slash chat"));
    await screen.findByText("the question");
    // No command menu for a slash that isn't at the start.
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "and/or maybe{Enter}");
    await waitFor(() => expect(sendChat).toHaveBeenCalled());
    expect(sendChat.mock.calls[0][0].content).toBe("and/or maybe");
    expect(api.forceRecap).not.toHaveBeenCalled();
  });

  test("/recap is not offered on the new-chat screen and is never sent as a literal message", async () => {
    renderView(); // stays on the new-chat screen — no conversation open
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    // Typing "/" still shows the /model completion, but not the (unavailable) /recap command.
    await userEvent.type(box, "/");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    expect(within(menu).getByText("/model")).toBeInTheDocument();
    expect(within(menu).queryByText("/recap")).toBeNull();
    // Fully typing "/recap" and pressing Enter is a safe no-op: cleared, not sent, no recap fetch.
    await userEvent.clear(box);
    await userEvent.type(box, "/recap{Enter}");
    await waitFor(() => expect(box.value).toBe(""));
    expect(sendChat).not.toHaveBeenCalled();
    expect(api.forceRecap).not.toHaveBeenCalled();
  });

  test("Tab completes a /model suggestion into the composer (completion path intact)", async () => {
    renderView();
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    await userEvent.type(box, "/model");
    await screen.findByRole("listbox", { name: "Commands" });
    fireEvent.keyDown(box, { key: "Tab" });
    await waitFor(() => expect(box.value).toBe("/model "));
    expect(sendChat).not.toHaveBeenCalled();
  });

  test("Tab AUTOCOMPLETES the /recap command name without running it; Enter then runs it", async () => {
    openThread();
    api.forceRecap.mockResolvedValue(RECAP);
    renderView();
    await userEvent.click(await screen.findByTitle("Slash chat"));
    await screen.findByText("the question");
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    // Highlight the /recap command row with a partial token.
    await userEvent.type(box, "/rec");
    await screen.findByRole("listbox", { name: "Commands" });
    // Tab fills in the command NAME — it must NOT run the recap and must NOT clear the field.
    fireEvent.keyDown(box, { key: "Tab" });
    await waitFor(() => expect(box.value).toBe("/recap"));
    expect(api.forceRecap).not.toHaveBeenCalled();
    // The menu stays open on the completed text; Enter now RUNS the command (still never sent).
    await userEvent.type(box, "{Enter}");
    await waitFor(() => expect(api.forceRecap).toHaveBeenCalledWith("c1"));
    expect(sendChat).not.toHaveBeenCalled();
  });
});

describe("ChatView — queue position", () => {
  test("shows the queue position while waiting for the in-flight turn", async () => {
    let captured: ChatEvents | null = null;
    sendChat.mockImplementation(async (_b: unknown, events: ChatEvents) => {
      captured = events;
      events.onMeta?.({ conversationId: "c1", model: "qwen" });
      events.onQueue?.(3);
      return new Promise(() => {}); // stay in-flight
    });
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "queue me");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/#3 in queue/)).toBeInTheDocument();
    expect(captured).not.toBeNull();
  });
});

describe("ChatView — stop + regenerate", () => {
  test("Stop cancels the in-flight turn server-side", async () => {
    sendChat.mockImplementation(async (_b: unknown, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "qwen" });
      events.onQueue?.(0);
      return new Promise(() => {}); // never resolves -> stays "sending"
    });
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "long one");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    // While sending, the send button becomes a Stop button.
    const stop = await screen.findByRole("button", { name: "Stop generating" });
    await userEvent.click(stop);
    await waitFor(() => expect(api.cancelGeneration).toHaveBeenCalledWith("c1"));
  });

  test("Retry on an assistant answer calls regenerateChat with its message id", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [
        apiMsg({ id: "u1", role: "user", content: "ask" }),
        apiMsg({ id: "a1", role: "assistant", content: "answer", vote: 0 }),
      ],
    });
    regenerateChat.mockImplementation(async (_id: string, events: ChatEvents) => {
      events.onDelta?.("new ");
      events.onDelta?.("answer");
      events.onDone?.({
        conversationId: "c1",
        model: "qwen",
        variants: [
          { id: "a1", content: "answer", vote: 0 },
          { id: "a2", content: "new answer", vote: 0 },
        ],
        activeIndex: 1,
        usage: null,
      });
    });
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("answer");
    // Retry button on the assistant message.
    const retryBtns = screen.getAllByRole("button", { name: "Retry" });
    await userEvent.click(retryBtns[retryBtns.length - 1]);
    await waitFor(() => expect(regenerateChat).toHaveBeenCalledWith("a1", expect.anything(), expect.anything()));
    expect(await screen.findByText("new answer")).toBeInTheDocument();
    // Variant navigator shows 2/2.
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  test("Branch on a message forks it into a new chat and opens the branch (#72)", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [
        apiMsg({ id: "u1", role: "user", content: "ask" }),
        apiMsg({ id: "a1", role: "assistant", content: "answer", vote: 0 }),
      ],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("answer");
    const branchBtns = screen.getAllByRole("button", { name: "Branch into a new chat" });
    // Fork at the assistant answer (last branch button in the row).
    await userEvent.click(branchBtns[branchBtns.length - 1]);
    await waitFor(() => expect(api.branchConversation).toHaveBeenCalledWith("c1", "a1"));
    // The new branch is opened (fetched by its id) and a confirmation toast is shown.
    await waitFor(() => expect(api.fetchConversation).toHaveBeenCalledWith("c2"));
    expect(await screen.findByText("Branched into a new chat.")).toBeInTheDocument();
  });

  test("Branch surfaces a notice and stays put when the fork fails (#72)", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [apiMsg({ id: "u1", role: "user", content: "ask" })],
    });
    api.branchConversation.mockResolvedValue(null);
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("ask");
    await userEvent.click(screen.getByRole("button", { name: "Branch into a new chat" }));
    await waitFor(() => expect(api.branchConversation).toHaveBeenCalledWith("c1", "u1"));
    expect(await screen.findByText("Couldn't branch this chat.")).toBeInTheDocument();
    // No navigation to a branch happened (only c1 was ever fetched).
    expect(api.fetchConversation).not.toHaveBeenCalledWith("c2");
  });
});

describe("ChatView — temp chat", () => {
  test("toggling temporary chat shows the ghost banner and sends with temporary:true", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Temporary chat" }));
    expect(await screen.findByText(/Temporary chat — not saved/)).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/Message/), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendChat).toHaveBeenCalled());
    expect(sendChat.mock.calls[0][0].temporary).toBe(true);
  });
});

describe("ChatView — sidebar collapse + resize", () => {
  test("collapse hides the in-sidebar controls and persists the choice", async () => {
    renderView();
    const collapse = await screen.findByRole("button", { name: "Collapse sidebar" });
    await userEvent.click(collapse);
    expect(localStorage.getItem("a7t_chat_sidebar_collapsed")).toBe("1");
    // The expand affordance now lives in the topbar.
    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  test("expand restores the collapsed state", async () => {
    localStorage.setItem("a7t_chat_sidebar_collapsed", "1");
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Expand sidebar" }));
    await waitFor(() => expect(localStorage.getItem("a7t_chat_sidebar_collapsed")).toBe("0"));
  });

  test("dragging the resizer updates and persists the sidebar width", async () => {
    renderView();
    await screen.findByPlaceholderText(/Message/);
    const resizer = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.pointerDown(resizer, { clientX: 240 });
    fireEvent.pointerMove(document, { clientX: 320 }); // +80 -> clamps within 200..400
    fireEvent.pointerUp(document);
    await waitFor(() => expect(localStorage.getItem("a7t_chat_sidebar_w")).toBe("320"));
  });
});

describe("ChatView — capability drawer", () => {
  test("opening a capability from a message chip mounts the surface drawer", async () => {
    // An assistant message with a [[map:…]] marker; clicking its chip opens the drawer.
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Trip" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [apiMsg({ id: "a1", role: "assistant", content: "Visit [[map:Lisbon, Portugal]] soon" })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Trip"));
    // The capability marker renders as a chip button (title set by MapChip; its visible
    // text is the short place name "Lisbon").
    const chip = await screen.findByTitle("Show Lisbon, Portugal on the map");
    await userEvent.click(chip);
    const drawer = await screen.findByTestId("cap-surface");
    expect(drawer).toHaveTextContent("cap:map");
    expect(drawer).toHaveTextContent("reqs:Lisbon, Portugal");
    // Closing the drawer unmounts it.
    await userEvent.click(within(drawer).getByText("close-cap"));
    await waitFor(() => expect(screen.queryByTestId("cap-surface")).toBeNull());
  });
});

describe("ChatView — search toggle availability", () => {
  test("admin (search available) sees the Research toggle; guest does not", async () => {
    const { unmount } = renderView(ME_ADMIN);
    expect(await screen.findByRole("button", { name: /Search the web|Web search is on/ })).toBeInTheDocument();
    unmount();

    renderView(ME_GUEST);
    await screen.findByPlaceholderText(/Message/);
    expect(screen.queryByRole("button", { name: /Search the web|Web search is on/ })).toBeNull();
  });
});

describe("ChatView — account menu + admin entry points", () => {
  test("admin sees the admin sections in the account settings modal", async () => {
    renderView(ME_ADMIN);
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    // The admin-only section lives in the settings modal's rail (#169: Invites removed; #179: the
    // Accounts manager removed → Telemetry is the last admin section).
    expect(await screen.findByRole("button", { name: "Telemetry" })).toBeInTheDocument();
    // The retired invite + guest key-generator + Accounts entries are gone.
    expect(screen.queryByRole("button", { name: "Invites" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Credentials" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accounts" })).toBeNull();
    // "Keys" is now the BYOK panel (#14) — a normal section present for every account.
    expect(screen.getByRole("button", { name: "Keys" })).toBeInTheDocument();
  });

  test("the local dev-bootstrap admin (via 'dev') gets no sign-out control (#191)", async () => {
    const onSignOut = vi.fn();
    // The dev bootstrap re-auths every request from config (no session cookie), so logout can't
    // work — the menu omits the control (mirrors the removed Tailscale-admin case, #180).
    renderView({ ...ME_ADMIN, via: "dev" }, onSignOut);
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    // The rest of the menu still works.
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  test("the owner-admin (via 'owner') sees a working sign out — a real passkey session (#191)", async () => {
    const onSignOut = vi.fn();
    renderView(ME_ADMIN, onSignOut); // ME_ADMIN is via 'owner'
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalled();
  });

  test("a guest (bearer token) sees a working sign out that fires onSignOut", async () => {
    const onSignOut = vi.fn();
    renderView(ME_GUEST, onSignOut);
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalled();
  });

  test("guest does not see admin entries in the account menu", async () => {
    renderView(ME_GUEST);
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("button", { name: "Credentials" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invites" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Telemetry" })).toBeNull();
  });

  test("any user opens the Files section from the account settings modal", async () => {
    renderView(ME_GUEST); // files are per-account, available to every role (not admin-only)
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Files" }));
    expect(await screen.findByRole("heading", { name: "Files" })).toBeInTheDocument();
    expect(api.listFiles).toHaveBeenCalled();
  });

  test("every role sees About in the settings modal and it opens", async () => {
    renderView(ME_GUEST);
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "About" }));
    expect(await screen.findByRole("heading", { name: "About" })).toBeInTheDocument();
    // The section surfaces the a7t.ai cross-link (the Help link was removed).
    expect(screen.queryByRole("link", { name: "Help" })).toBeNull();
    expect(screen.getByRole("link", { name: "Part of a7t.ai" })).toHaveAttribute("href", "https://a7t.ai");
  });
});

describe("ChatView — conversation actions", () => {
  test("deleting a conversation (confirmed) calls deleteConversation", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Trash me" })]);
    renderView();
    await screen.findByTitle("Trash me");
    await userEvent.click(screen.getByRole("button", { name: "Conversation options" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteConversation).toHaveBeenCalledWith("c1"));
  });

  test("starring a conversation calls setConversationStarred(true)", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Pin me", starred: false })]);
    renderView();
    await screen.findByTitle("Pin me");
    await userEvent.click(screen.getByRole("button", { name: "Conversation options" }));
    await userEvent.click(screen.getByRole("button", { name: "Star" }));
    await waitFor(() => expect(api.setConversationStarred).toHaveBeenCalledWith("c1", true));
  });

  test("generate-title menu action calls generateConversationTitle and swaps the title", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Old title" })]);
    api.generateConversationTitle.mockResolvedValue("Brand new title");
    renderView();
    await screen.findByTitle("Old title");
    await userEvent.click(screen.getByRole("button", { name: "Conversation options" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate title" }));
    await waitFor(() => expect(api.generateConversationTitle).toHaveBeenCalledWith("c1"));
    expect(await screen.findByTitle("Brand new title")).toBeInTheDocument();
  });

  test("renaming a conversation inline (double-click) commits via renameConversation", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Rename me" })]);
    renderView();
    const row = await screen.findByTitle("Rename me");
    fireEvent.doubleClick(row);
    const input = await screen.findByLabelText("Conversation name");
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed!{Enter}");
    await waitFor(() => expect(api.renameConversation).toHaveBeenCalledWith("c1", "Renamed!"));
  });
});

describe("ChatView — topbar rename", () => {
  test("renaming the open conversation from the topbar persists the new title", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Open title" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Open title" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "q" })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Open title"));
    // The topbar shows the title as a rename button (its title attr = "Rename chat").
    const nameBtn = await screen.findByTitle("Rename chat");
    await userEvent.click(nameBtn);
    const input = await screen.findByLabelText("Conversation name");
    await userEvent.clear(input);
    await userEvent.type(input, "New topbar name{Enter}");
    await waitFor(() => expect(api.renameConversation).toHaveBeenCalledWith("c1", "New topbar name"));
  });

  test("Escape cancels the topbar rename without persisting", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Keep me" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Keep me" }),
      messages: [apiMsg()],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Keep me"));
    await userEvent.click(await screen.findByTitle("Rename chat"));
    const input = await screen.findByLabelText("Conversation name");
    await userEvent.type(input, "scratch{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Conversation name")).toBeNull());
    expect(api.renameConversation).not.toHaveBeenCalled();
  });
});

describe("ChatView — message actions", () => {
  test("Edit on a user message loads its text into the composer", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [apiMsg({ id: "u1", role: "user", content: "edit this prompt" })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("edit this prompt");
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("edit this prompt"));
  });

  test("Retry on a user message re-sends it (onResend -> sendChat)", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [apiMsg({ id: "u1", role: "user", content: "resend me" })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("resend me");
    // The user message's Retry button.
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sendChat).toHaveBeenCalled());
    expect(sendChat.mock.calls[0][0].content).toBe("resend me");
  });

  test("voting a message calls voteMessage with the message id", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [
        apiMsg({ id: "u1", role: "user", content: "q" }),
        apiMsg({ id: "a1", role: "assistant", content: "an answer" }),
      ],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("an answer");
    await userEvent.click(screen.getByRole("button", { name: "Good reply" }));
    await waitFor(() => expect(api.voteMessage).toHaveBeenCalledWith("a1", 1));
  });
});

// The owner-side shopping-list / task-list checkbox toggle (#131): in the owner's OWN chat the
// checkbox is interactive (unlike the old read-only default), calls the owner endpoint with the
// ordinal + next state, and reconciles to the server's authoritative content.
describe("ChatView — owner TODO checkbox toggle (#131)", () => {
  const RECIPE = "- [ ] eggs\n- [ ] flour";

  test("ticking a checkbox in the owner's chat calls toggleConversationTodo and reconciles content", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Recipe" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Recipe", access: "owner" }),
      messages: [apiMsg({ id: "a1", role: "assistant", content: RECIPE })],
    });
    api.toggleConversationTodo.mockResolvedValue("- [ ] eggs\n- [x] flour");
    renderView();
    await userEvent.click(await screen.findByTitle("Recipe"));
    await screen.findByText("eggs");

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    // The owner view enables them (the bug was they rendered disabled/read-only).
    expect((boxes[1] as HTMLInputElement).disabled).toBe(false);
    await userEvent.click(boxes[1]);
    // The click reports the 0-based ordinal within the message + the next state to the owner endpoint.
    await waitFor(() => expect(api.toggleConversationTodo).toHaveBeenCalledWith("c1", "a1", 1, true));
    // After the server confirms, the second checkbox reflects the persisted `- [x] flour`.
    await waitFor(() => expect((screen.getAllByRole("checkbox")[1] as HTMLInputElement).checked).toBe(true));
  });

  test("a read-only collaborator (view) does NOT get the interactive toggle wired", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Watched" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Watched", access: "view" }),
      messages: [apiMsg({ id: "a1", role: "assistant", content: RECIPE })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Watched"));
    // The task list still renders, but for a viewer ChatView withholds onToggleTodo — so the
    // interactive checkbox override is never wired (in production streamdown falls back to its
    // disabled default), and no toggle can reach the server.
    await screen.findByText(/eggs/);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(api.toggleConversationTodo).not.toHaveBeenCalled();
  });
});

describe("ChatView — stop marks the reply stopped + continue", () => {
  test("Stop on a freshly-sent turn marks it stopped, and Continue re-asks the question", async () => {
    // sendChat aborts on signal (mimics the local stream abort the Stop button triggers).
    sendChat.mockImplementation(
      (_b: unknown, events: ChatEvents, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          events.onMeta?.({ conversationId: "c1", model: "qwen" });
          events.onQueue?.(0);
          signal?.addEventListener("abort", () => {
            const err = new DOMException("aborted", "AbortError");
            reject(err);
          });
        }),
    );
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "my question");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Stop generating" }));

    // The stopped notice appears, with a Continue affordance.
    expect(await screen.findByText("You stopped this response.")).toBeInTheDocument();
    const continueBtn = await screen.findByRole("button", { name: "Continue this response" });

    // Continue re-asks: a fresh sendChat with the same content.
    sendChat.mockResolvedValueOnce(null);
    await userEvent.click(continueBtn);
    await waitFor(() => expect(sendChat).toHaveBeenCalledTimes(2));
    expect(sendChat.mock.calls[1][0].content).toBe("my question");
  });

  test("a streamed error frame surfaces an in-voice note inline in the answer", async () => {
    sendChat.mockImplementation(async (_b: unknown, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "qwen" });
      // A mid-stream error frame now arrives classified (kind: "stream"), and the UI maps
      // it to the in-voice copy via errorKey() rather than leaking the raw server message.
      events.onError?.({ kind: "stream", serverMessage: "model exploded" });
      return null;
    });
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "boom");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/The response stopped early/)).toBeInTheDocument();
    // The raw server message is NOT leaked to the user.
    expect(screen.queryByText(/model exploded/)).toBeNull();
  });
});

describe("ChatView — variant navigation", () => {
  test("◀ / ▶ flips the active regenerated variant and persists the choice", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [
        apiMsg({ id: "u1", role: "user", content: "q" }),
        apiMsg({
          id: "a2",
          role: "assistant",
          content: "second answer",
          variants: [
            { id: "a1", content: "first answer", vote: 0, model: null },
            { id: "a2", content: "second answer", vote: 0, model: null },
          ],
          activeIndex: 1,
        }),
      ],
    });
    api.selectVariant.mockResolvedValue(undefined);
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    expect(await screen.findByText("second answer")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();
    // Go to the previous variant.
    await userEvent.click(screen.getByRole("button", { name: "Previous answer" }));
    expect(await screen.findByText("first answer")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    await waitFor(() => expect(api.selectVariant).toHaveBeenCalledWith("a1"));
  });
});

describe("ChatView — resume a generating turn on load", () => {
  test("a conversation flagged generating reattaches via attachChat and streams buffered text", async () => {
    window.history.replaceState({}, "", "/c/live");
    api.fetchConversation
      .mockResolvedValueOnce({
        conversation: convo({ id: "live", title: "Live", generating: true }),
        messages: [apiMsg({ id: "u1", role: "user", content: "earlier question" })],
      })
      // Reconciliation fetch after the stream ends.
      .mockResolvedValueOnce({
        conversation: convo({ id: "live", title: "Live", generating: false }),
        messages: [
          apiMsg({ id: "u1", role: "user", content: "earlier question" }),
          apiMsg({ id: "a1", role: "assistant", content: "resumed reply" }),
        ],
      });
    attachChat.mockImplementation(async (_id: string, events: ChatEvents) => {
      events.onDelta?.("resumed ");
      events.onDelta?.("reply");
      return true;
    });
    renderView();
    await waitFor(() => expect(attachChat).toHaveBeenCalledWith("live", expect.anything(), expect.anything()));
    expect(await screen.findByText("resumed reply")).toBeInTheDocument();
  });
});

describe("ChatView — command palette", () => {
  test("Cmd/Ctrl+K opens the palette; it lists actions, chats, themes, languages", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Palette chat" })]);
    renderView();
    await screen.findByTitle("Palette chat");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    // The palette opens as a `.palette` container; scope assertions to it so the sidebar's
    // copy of the conversation title doesn't collide.
    const palette = await waitFor(() => {
      const el = document.querySelector(".palette") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // It lists the conversation as a jump target + the admin actions for an admin caller.
    expect(within(palette).getByText("Palette chat")).toBeInTheDocument();
    // The admin telemetry action is present; the retired invites + Credentials/Keys generator +
    // Accounts (#179) are not.
    expect(within(palette).getByText("Telemetry (stats)")).toBeInTheDocument();
    expect(within(palette).queryByText("Accounts")).toBeNull();
    expect(within(palette).queryByText("Invites")).toBeNull();
    expect(within(palette).queryByText(/Credentials/)).toBeNull();
  });

  test("the About palette action opens the About dialog", async () => {
    renderView(ME_GUEST);
    await screen.findByPlaceholderText(/Message/);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await waitFor(() => {
      const el = document.querySelector(".palette") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await userEvent.click(within(palette).getByText("About"));
    expect(await screen.findByRole("heading", { name: "About" })).toBeInTheDocument();
  });

  // The /recap command (#37): force "where you left off" on demand, bypassing the 24h gate.
  test("the /recap command is absent on the new-chat screen (no open conversation)", async () => {
    renderView();
    await screen.findByPlaceholderText(/Message/); // on the empty new-chat screen
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await waitFor(() => {
      const el = document.querySelector(".palette") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(within(palette).queryByText("Recap this conversation")).toBeNull();
  });

  test("the /recap command force-fetches the recap and renders the card", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Fresh chat" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Fresh chat" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "the question" })],
    });
    // fetchRecap (auto-surface) stays null - only the command forces one.
    api.forceRecap.mockResolvedValue({
      topic: "Lisbon trip",
      progress: ["Chose May"],
      whereItEnded: "Comparing hotels",
      nextStep: "Pick a hotel",
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Fresh chat"));
    await screen.findByText("the question");
    // No auto recap on a fresh thread.
    expect(screen.queryByText("Where you left off")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await waitFor(() => {
      const el = document.querySelector(".palette") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // The endRef scroll uses { behavior: "smooth" }; the palette's own row-scroll uses
    // { block: "nearest" }. Clear here so a later smooth scroll can ONLY be the recap arriving.
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
    await userEvent.click(within(palette).getByText("Recap this conversation"));

    expect(await screen.findByText("Where you left off")).toBeInTheDocument();
    expect(screen.getByText("Lisbon trip")).toBeInTheDocument();
    expect(api.forceRecap).toHaveBeenCalledWith("c1");

    // Bottom placement + reveal (#37): the /recap result lands as the newest entry (after the last
    // message) and scrolls into view like a new message — run from the composer, seen where you are.
    const msgs = document.querySelectorAll<HTMLElement>(".messages [data-mm-index]");
    const lastMsg = msgs[msgs.length - 1];
    const card = document.querySelector("section.recap-card")!;
    expect(lastMsg.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth" });
  });

  test("the /recap command shows a subtle note when there is nothing to recap", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Thin chat" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Thin chat" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "hi there" })],
    });
    api.forceRecap.mockResolvedValue(null); // too thin / degraded
    renderView();
    await userEvent.click(await screen.findByTitle("Thin chat"));
    await screen.findByText("hi there");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await waitFor(() => {
      const el = document.querySelector(".palette") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await userEvent.click(within(palette).getByText("Recap this conversation"));

    expect(await screen.findByText("Nothing to recap yet.")).toBeInTheDocument();
    expect(screen.queryByText("Where you left off")).not.toBeInTheDocument();
  });

  test("Cmd/Ctrl+. starts a new chat (clears the thread)", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "to be cleared" })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("to be cleared");
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    // Back to the empty welcome state.
    await waitFor(() => expect(screen.queryByText("to be cleared")).toBeNull());
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  test("Cmd/Ctrl+/ starts a temporary chat", async () => {
    renderView();
    await screen.findByPlaceholderText(/Message/);
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    expect(await screen.findByText(/Temporary chat — not saved/)).toBeInTheDocument();
  });
});

describe("ChatView — browser back navigation", () => {
  test("popstate to / clears the open thread", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "navigated away" })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("navigated away");
    // Simulate Back to the root.
    window.history.replaceState({}, "", "/");
    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByText("navigated away")).toBeNull());
  });
});

describe("ChatView — panels + topbar entry points", () => {
  test("account menu opens Settings, and Close dismisses it", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    // SettingsPanel renders a Close button.
    const close = await screen.findByRole("button", { name: "Close" });
    await userEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Close" })).toBeNull());
  });

  test("account settings modal opens the Keyboard section", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Keyboard Sheet" }));
    expect(await screen.findByRole("heading", { name: "Keyboard Sheet" })).toBeInTheDocument();
  });

  test("account settings modal opens on Profile with the caller's plan", async () => {
    renderView({ ...ME_GUEST, plan: "free" });
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    // Settings opens the modal at Profile (the first section) by default.
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    // The usage meter was dropped (#186): the profile shows the plan badge, no progressbar.
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  test("the Profile palette action opens the Profile panel", async () => {
    renderView();
    await screen.findByPlaceholderText(/Message/);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const palette = await waitFor(() => {
      const el = document.querySelector(".palette") as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await userEvent.click(within(palette).getByText("Profile"));
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
  });

  test("the topbar search button opens the command palette", async () => {
    renderView();
    await userEvent.click(await screen.findByTitle("Search (Cmd/Ctrl+K)"));
    await waitFor(() => expect(document.querySelector(".palette")).not.toBeNull());
  });

  test("clicking the brand link starts a new chat", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "to clear" })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("to clear");
    await userEvent.click(screen.getByRole("link", { name: "Home" }));
    await waitFor(() => expect(screen.queryByText("to clear")).toBeNull());
  });

  test("the mobile sidebar backdrop closes the sidebar", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Toggle conversations" }));
    const backdrop = document.querySelector(".sidebar-backdrop") as HTMLElement;
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop);
    await waitFor(() => expect(document.querySelector(".sidebar-backdrop")).toBeNull());
  });

  test("toggling a starred conversation from the favorites bucket unstars it", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Fave", starred: true })]);
    renderView();
    // It lands under Favorites.
    await screen.findByText("Favorites");
    await userEvent.click(screen.getByRole("button", { name: "Conversation options" }));
    await userEvent.click(screen.getByRole("button", { name: "Unstar" }));
    await waitFor(() => expect(api.setConversationStarred).toHaveBeenCalledWith("c1", false));
  });
});

// A minimal HTML5 DataTransfer stand-in (jsdom has none) that carries the dragged row's id
// through the dragStart -> drop pair, mirroring a real drag.
function makeDataTransfer(): DataTransfer {
  const store: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? "",
    effectAllowed: "",
    dropEffect: "",
  } as unknown as DataTransfer;
}

describe("ChatView — favorites: drag-to-favorite (#57)", () => {
  test("dragging a Recents row onto Favorites stars it", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Drag me", starred: false })]);
    renderView();
    const row = (await screen.findByTitle("Drag me")).closest("li") as HTMLElement;
    const data = makeDataTransfer();
    // Lifting the row reveals the (otherwise hidden) empty Favorites drop zone.
    fireEvent.dragStart(row, { dataTransfer: data });
    const favSection = (await screen.findByText("Drop here to favorite")).closest("section") as HTMLElement;
    fireEvent.dragOver(favSection, { dataTransfer: data });
    expect(favSection).toHaveClass("drag-over");
    fireEvent.drop(favSection, { dataTransfer: data });
    await waitFor(() => expect(api.setConversationStarred).toHaveBeenCalledWith("c1", true));
  });

  test("dragging a Favorites row back onto Recents unstars it", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Fave", starred: true })]);
    renderView();
    const row = (await screen.findByTitle("Fave")).closest("li") as HTMLElement;
    const data = makeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: data });
    const recentsSection = (await screen.findByText("Recents")).closest("section") as HTMLElement;
    fireEvent.drop(recentsSection, { dataTransfer: data });
    await waitFor(() => expect(api.setConversationStarred).toHaveBeenCalledWith("c1", false));
  });

  test("dropping a row on its own section is a graceful no-op", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Stay put", starred: false })]);
    renderView();
    const row = (await screen.findByTitle("Stay put")).closest("li") as HTMLElement;
    const data = makeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: data });
    const recentsSection = (await screen.findByText("Recents")).closest("section") as HTMLElement;
    fireEvent.drop(recentsSection, { dataTransfer: data });
    // A drop back on Recents (already unstarred) persists nothing.
    expect(api.setConversationStarred).not.toHaveBeenCalled();
  });

  test("dragEnd clears the drop-target highlight without persisting", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Recent", starred: false })]);
    renderView();
    const row = (await screen.findByTitle("Recent")).closest("li") as HTMLElement;
    const data = makeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: data });
    const favSection = (await screen.findByText("Drop here to favorite")).closest("section") as HTMLElement;
    fireEvent.dragOver(favSection, { dataTransfer: data });
    expect(favSection).toHaveClass("drag-over");
    fireEvent.dragLeave(favSection, { dataTransfer: data });
    expect(favSection).not.toHaveClass("drag-over");
    fireEvent.dragEnd(row, { dataTransfer: data });
    // The revealed empty Favorites zone collapses again once the drag ends.
    await waitFor(() => expect(screen.queryByText("Drop here to favorite")).toBeNull());
    expect(api.setConversationStarred).not.toHaveBeenCalled();
  });
});

describe("ChatView — favorites: topbar star (#57)", () => {
  test("stars the open conversation from the topbar", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Open me", starred: false })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Open me", starred: false }),
      messages: [apiMsg()],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Open me"));
    // The topbar star reads "Star" while unstarred; clicking favorites the open chat.
    await userEvent.click(await screen.findByRole("button", { name: "Star" }));
    await waitFor(() => expect(api.setConversationStarred).toHaveBeenCalledWith("c1", true));
  });

  test("shows the Unstar affordance when the open conversation is starred", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Faved", starred: true })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Faved", starred: true }),
      messages: [apiMsg()],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Faved"));
    expect(await screen.findByRole("button", { name: "Unstar" })).toBeInTheDocument();
  });

  test("no topbar star on the new-chat screen", async () => {
    api.fetchConversations.mockResolvedValue([]);
    renderView();
    await screen.findByText("No conversations yet.");
    expect(screen.queryByRole("button", { name: "Star" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unstar" })).toBeNull();
  });
});

describe("ChatView — search progress patching", () => {
  test("onSearch + onSources render live status then the cited sources", async () => {
    sendChat.mockImplementation(async (_b: unknown, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "qwen" });
      events.onSearch?.({ stage: "searching", queries: ["q"] });
      events.onSources?.([{ n: 1, title: "Wikipedia", url: "https://en.wikipedia.org", domain: "wikipedia.org" }]);
      events.onDelta?.("answer with [1]");
      events.onDone?.({ conversationId: "c1", model: "qwen", messageId: "m", usage: null });
      return null;
    });
    renderView();
    // Turn search on first.
    await userEvent.click(await screen.findByRole("button", { name: /Search the web/ }));
    await userEvent.type(screen.getByPlaceholderText(/Message/), "research this");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    // The cited source chip appears.
    expect(await screen.findByText("Wikipedia")).toBeInTheDocument();
    expect(screen.getByText("answer with [1]")).toBeInTheDocument();
    // sendChat was asked to search.
    expect(sendChat.mock.calls[0][0].search).toBe(true);
  });
});

describe("ChatView — thinking toggle", () => {
  test("toggling Thinking sends thinking:true; default is thinking:false", async () => {
    sendChat.mockImplementation(async (_b: unknown, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "qwen" });
      events.onDelta?.("hi");
      events.onDone?.({ conversationId: "c1", model: "qwen", messageId: "m", usage: null });
      return null;
    });
    renderView();
    // Default: send without touching the toggle — thinking is off.
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "no thinking");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sendChat.mock.calls[0][0].thinking).toBe(false);

    // Flip Thinking on (default OFF) and send again — thinking is requested.
    await userEvent.click(screen.getByRole("button", { name: /Ask the model to reason/ }));
    await userEvent.type(screen.getByPlaceholderText(/Message/), "please think");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sendChat.mock.calls[1][0].thinking).toBe(true);
  });
});

describe("ChatView — composer autocomplete keyboard nav", () => {
  test("ArrowDown/ArrowUp move the active suggestion; Tab accepts it", async () => {
    renderView();
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    await userEvent.type(box, "/model ");
    // Two model options are suggested (qwen, llama); Tab completes the active one.
    await screen.findByText("switch to Qwen 3");
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.keyboard("{Tab}");
    // Tab fills the composer with the completed /model <id>.
    await waitFor(() => expect(box.value).toMatch(/^\/model /));
  });

  test("Escape dismisses the suggestion dropdown", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    await userEvent.type(box, "/mod");
    await screen.findByText("list or switch the model");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("list or switch the model")).toBeNull());
  });

  test("clicking a suggestion accepts it into the composer", async () => {
    renderView();
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    await userEvent.type(box, "/model lla");
    const opt = await screen.findByText("switch to Llama 3");
    // mousedown drives accept() (the button uses onMouseDown, not click).
    fireEvent.mouseDown(opt.closest("button") as HTMLElement);
    await waitFor(() => expect(box.value).toBe("/model llama"));
  });
});

describe("ChatView — regenerate stop", () => {
  test("Stop during regenerate reverts to the pre-regenerate answer", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [
        apiMsg({ id: "u1", role: "user", content: "q" }),
        apiMsg({ id: "a1", role: "assistant", content: "original answer" }),
      ],
    });
    regenerateChat.mockImplementation(
      (_id: string, events: ChatEvents, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          events.onDelta?.("partial");
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("original answer");
    const retryBtns = screen.getAllByRole("button", { name: "Retry" });
    await userEvent.click(retryBtns[retryBtns.length - 1]);
    // Stop the in-flight regeneration.
    await userEvent.click(await screen.findByRole("button", { name: "Stop generating" }));
    // The original answer is restored (the half-streamed variant was never persisted).
    expect(await screen.findByText("original answer")).toBeInTheDocument();
  });
});

describe("ChatView — conversation gone (404) redirects home", () => {
  test("a deep-link to a 404 conversation lands on the empty state + notices + navigateToNew", async () => {
    window.history.replaceState({}, "", "/c/gone");
    // The server can't find this conversation FOR THIS caller (deleted, or another user's id).
    api.fetchConversation.mockResolvedValue(null);
    renderView();
    // We never strand on a dead thread: the empty welcome state shows up...
    expect(await screen.findByText("What can I help with?")).toBeInTheDocument();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    // ...the "gone" toast surfaces...
    expect(await screen.findByText("That conversation is no longer available.")).toBeInTheDocument();
    // ...and we went home (URL reset to "/").
    await waitFor(() => expect(navigateToNew).toHaveBeenCalled());
    expect(window.location.pathname).toBe("/");
  });

  test("clicking a sidebar conversation that 404s redirects home (no stuck thread)", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Vanished" })]);
    api.fetchConversation.mockResolvedValue(null);
    renderView();
    await userEvent.click(await screen.findByTitle("Vanished"));
    expect(await screen.findByText("That conversation is no longer available.")).toBeInTheDocument();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    await waitFor(() => expect(navigateToNew).toHaveBeenCalled());
  });

  test("popstate to a 404 conversation redirects home", async () => {
    // Open a real thread first, then simulate Back to a /c/<id> the server now 404s.
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Open me" })]);
    api.fetchConversation.mockResolvedValueOnce({
      conversation: convo({ id: "c1", title: "Open me" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "still here" })],
    });
    renderView();
    await userEvent.click(await screen.findByTitle("Open me"));
    await screen.findByText("still here");
    // Now the popstate target 404s.
    api.fetchConversation.mockResolvedValue(null);
    window.history.replaceState({}, "", "/c/dead");
    fireEvent.popState(window);
    expect(await screen.findByText("That conversation is no longer available.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("still here")).toBeNull());
    expect(window.location.pathname).toBe("/");
  });

  test("a send that hits onNotFound (404 / 'conversation not found') redirects home with no ⚠️ note", async () => {
    // sendChat fires onNotFound instead of onError — the conversation is gone for the caller.
    sendChat.mockImplementation(async (_b: unknown, events: ChatEvents) => {
      events.onNotFound?.();
      return null;
    });
    renderView();
    await userEvent.type(await screen.findByPlaceholderText(/Message/), "into the void");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    // Home + notice...
    expect(await screen.findByText("That conversation is no longer available.")).toBeInTheDocument();
    await waitFor(() => expect(navigateToNew).toHaveBeenCalled());
    // ...and no stuck "⚠️ conversation not found" inline note was appended.
    expect(screen.queryByText(/⚠️/)).toBeNull();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
  });

  test("regenerate that hits onNotFound redirects home with no ⚠️ note", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "T" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1" }),
      messages: [
        apiMsg({ id: "u1", role: "user", content: "q" }),
        apiMsg({ id: "a1", role: "assistant", content: "an answer" }),
      ],
    });
    regenerateChat.mockImplementation(async (_id: string, events: ChatEvents) => {
      events.onNotFound?.();
    });
    renderView();
    await userEvent.click(await screen.findByTitle("T"));
    await screen.findByText("an answer");
    const retryBtns = screen.getAllByRole("button", { name: "Retry" });
    await userEvent.click(retryBtns[retryBtns.length - 1]);
    expect(await screen.findByText("That conversation is no longer available.")).toBeInTheDocument();
    await waitFor(() => expect(navigateToNew).toHaveBeenCalled());
    expect(screen.queryByText(/⚠️/)).toBeNull();
  });

  test("a turn deleted DURING the stream (reconcile returns null) redirects home", async () => {
    // A generating conversation reattaches via attachChat, then the post-stream reconcile
    // fetch returns null because it was deleted on another device mid-turn.
    window.history.replaceState({}, "", "/c/live");
    api.fetchConversation
      .mockResolvedValueOnce({
        conversation: convo({ id: "live", title: "Live", generating: true }),
        messages: [apiMsg({ id: "u1", role: "user", content: "earlier" })],
      })
      .mockResolvedValueOnce(null); // reconcile: gone now
    attachChat.mockImplementation(async (_id: string, events: ChatEvents) => {
      events.onDelta?.("partial reply");
      return true;
    });
    renderView();
    await waitFor(() => expect(attachChat).toHaveBeenCalled());
    expect(await screen.findByText("That conversation is no longer available.")).toBeInTheDocument();
    await waitFor(() => expect(navigateToNew).toHaveBeenCalled());
    expect(window.location.pathname).toBe("/");
  });
});

describe("ChatView — voice input (batch mic fallback)", () => {
  // The standalone dictation mic button is hidden (DICTATION_MIC_ENABLED=false) — Voice mode (#70)
  // is the single voice entry point. The batch Whisper recorder stays wired as the fallback the
  // live-dictation shortcut (mod+shift+u, #71) drops to when its stream can't open, which these
  // tests drive. A captured FakeRecorder instance stands in for the (now buttonless) stop gesture.
  let recorder: { stop: () => void } | null = null;
  function stubBatchBrowser(getUserMedia: ReturnType<typeof vi.fn>) {
    let onstop: (() => void) | null = null;
    class FakeRecorder {
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
      set onstop(fn: () => void) {
        onstop = fn;
      }
      start = vi.fn();
      stop = vi.fn(() => onstop?.());
      constructor() {
        recorder = this;
      }
    }
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", FakeRecorder as unknown as typeof MediaRecorder);
  }
  function fireDictationShortcut() {
    fireEvent.keyDown(window, { key: "u", metaKey: true, shiftKey: true });
  }

  test("live dictation drops to the batch recorder, which transcribes into the composer", async () => {
    recorder = null;
    const track = { stop: vi.fn() };
    stubBatchBrowser(vi.fn().mockResolvedValue({ getTracks: () => [track] }));
    dictation.streamDictation.mockRejectedValue(new Error("no live stream")); // stream won't open
    api.transcribe.mockResolvedValue("spoken words");

    renderView(ME_DICTATION);
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    fireDictationShortcut(); // startLiveDictation -> throws -> startRec (batch fallback)
    await waitFor(() => expect(recorder).not.toBeNull());
    // The (buttonless) recorder stops -> onstop -> transcribe -> the text lands in the composer.
    await act(async () => recorder?.stop());
    await waitFor(() => expect(api.transcribe).toHaveBeenCalled());
    await waitFor(() => expect(box.value).toContain("spoken words"));
  });

  test("a failed transcription shows an in-voice notice instead of silence (#42)", async () => {
    recorder = null;
    const track = { stop: vi.fn() };
    stubBatchBrowser(vi.fn().mockResolvedValue({ getTracks: () => [track] }));
    dictation.streamDictation.mockRejectedValue(new Error("no live stream"));
    api.transcribe.mockRejectedValue(new Error("stt engine down"));

    renderView(ME_DICTATION);
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    fireDictationShortcut();
    await waitFor(() => expect(recorder).not.toBeNull());
    await act(async () => recorder?.stop());
    expect(await screen.findByText("Could not transcribe that. Try again, or type instead.")).toBeInTheDocument();
    // The composer stays empty and the raw thrown string never leaks.
    expect(box.value).toBe("");
    expect(screen.queryByText(/stt engine down/)).not.toBeInTheDocument();
  });

  test("a denied microphone shows the mic-access notice when the batch fallback runs (#42)", async () => {
    stubBatchBrowser(vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")));
    dictation.streamDictation.mockRejectedValue(new Error("no live stream"));

    renderView(ME_DICTATION);
    await screen.findByPlaceholderText(/Message/);
    fireDictationShortcut(); // startLiveDictation -> throws -> startRec -> getUserMedia denied
    expect(
      await screen.findByText("Could not access the microphone. Check your browser permissions."),
    ).toBeInTheDocument();
  });
});

describe("ChatView — voice / conversational mode (#70)", () => {
  // A mic recorder shim whose stop() replays onstop (the endpoint the loop listens for), plus a
  // speech-synthesis stub — the same primitives the dictation tests above use.
  function stubVoiceBrowser() {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
    class FakeRecorder {
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
      onstop: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn(() => this.onstop?.());
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder as unknown as typeof MediaRecorder);
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak, cancel });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      vi.fn(function (this: Record<string, unknown>, text: string) {
        this.text = text;
      }),
    );
    return { track, getUserMedia, speak, cancel };
  }

  test("toggling Voice on opens the mic and shows the listening pill; a turn reads the reply aloud", async () => {
    const { speak } = stubVoiceBrowser();
    api.transcribe.mockResolvedValue("what is the time");
    // A controlled turn: the reply streams while `sending` stays true (as a real SSE stream does),
    // and only settles when we release it — so the loop reads back a FINISHED answer.
    let finishTurn!: () => void;
    const turnDone = new Promise<void>((r) => {
      finishTurn = r;
    });
    sendChat.mockImplementation(async (_body: unknown, events: ChatEvents) => {
      events.onMeta?.({ conversationId: "c1", model: "qwen" });
      events.onDelta?.("It is noon");
      await turnDone;
      events.onDone?.({ conversationId: "c1", model: "qwen", messageId: "m-done", usage: null });
      return null;
    });
    renderView();

    // The mic never opens until the user's explicit Voice gesture.
    const toggle = await screen.findByRole("button", { name: "Voice mode: speak, and replies read back to you" });
    await userEvent.click(toggle);
    // Listening pill appears (screen-reader legible status).
    expect(await screen.findByText("Listening…")).toBeInTheDocument();

    // End the turn via the pill's action → transcribe → send → the reply streams in.
    await userEvent.click(screen.getByRole("button", { name: "Stop and send" }));
    await waitFor(() => expect(api.transcribe).toHaveBeenCalled());
    expect(await screen.findByText("It is noon")).toBeInTheDocument();
    // Nothing is read back until the turn actually finishes.
    expect(speak).not.toHaveBeenCalled();

    finishTurn();
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(speak.mock.calls[0][0].text).toBe("It is noon");

    vi.unstubAllGlobals();
  });

  test("toggling Voice off stops the mic and cancels speech", async () => {
    const { track, cancel } = stubVoiceBrowser();
    api.transcribe.mockResolvedValue("hi");
    renderView();
    const toggle = await screen.findByRole("button", { name: "Voice mode: speak, and replies read back to you" });
    await userEvent.click(toggle); // on -> listening
    await screen.findByText("Listening…");
    // The toggle now reflects the on state; clicking it turns voice mode off.
    await userEvent.click(screen.getByRole("button", { name: "Voice mode is on. Tap to turn it off" }));
    await waitFor(() => expect(screen.queryByText("Listening…")).not.toBeInTheDocument());
    expect(track.stop).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("a denied mic in voice mode surfaces the mic notice", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) },
    });
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: "Voice mode: speak, and replies read back to you" }),
    );
    expect(
      await screen.findByText("Could not access the microphone. Check your browser permissions."),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe("ChatView — share control", () => {
  test("the Share button shows for an open (persisted) conversation", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Open me" })]);
    renderView();
    // No share button on the new-chat screen (nothing to share yet).
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByTitle("Open me"));
    expect(await screen.findByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  test("opening the share popover loads status and can create a link", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Open me" })]);
    renderView();
    await userEvent.click(await screen.findByTitle("Open me"));
    await userEvent.click(await screen.findByRole("button", { name: "Share" }));
    expect(await screen.findByRole("button", { name: "Create link" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(api.createShare).toHaveBeenCalledWith("c1");
    const input = (await screen.findByLabelText("Copy link")) as HTMLInputElement;
    expect(input.value).toBe("https://a7t.chat/s/sg");
  });

  test("switching conversations remounts the share control (no stale popover/link)", async () => {
    api.fetchConversations.mockResolvedValue([
      convo({ id: "c1", title: "First" }),
      convo({ id: "c2", title: "Second" }),
    ]);
    api.getShare.mockResolvedValue({ shared: true, slug: "s1", url: "https://a7t.chat/s/s1" });
    renderView();
    await userEvent.click(await screen.findByTitle("First"));
    await userEvent.click(await screen.findByRole("button", { name: "Share" }));
    expect(await screen.findByText("Share this chat")).toBeInTheDocument();
    // Switch chats — the popover must not carry over to the next conversation.
    await userEvent.click(screen.getByTitle("Second"));
    await waitFor(() => expect(screen.queryByText("Share this chat")).not.toBeInTheDocument());
  });

  test("the Share button is hidden when sharing is not entitled", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Open me" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Open me" }),
      messages: [apiMsg({ id: "m1", role: "user", content: "the question" })],
    });
    renderView({ ...ME_ADMIN, features: { "conversations.share": false } });
    await userEvent.click(await screen.findByTitle("Open me"));
    expect(await screen.findByText("the question")).toBeInTheDocument(); // thread loaded
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  });
});

describe("ChatView — Share primitive (collaborators)", () => {
  test("opening an owned conversation shows the People + Share owner controls", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Mine" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Mine", access: "owner" }),
      messages: [apiMsg({ content: "owned thread" })],
    });
    renderView(ME_ADMIN);
    await userEvent.click(await screen.findByTitle("Mine"));
    expect(await screen.findByText("owned thread")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    // The composer (not a read-only banner) is shown to the owner.
    expect(screen.getByPlaceholderText(/Message/)).toBeInTheDocument();
  });

  test("opening a conversation shared with you (view) hides owner controls and shows a read-only banner", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Shared in" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Shared in", access: "view" }),
      messages: [apiMsg({ id: "a1", role: "assistant", content: "the shared thread" })],
    });
    renderView(ME_ADMIN);
    await userEvent.click(await screen.findByTitle("Shared in"));
    expect(await screen.findByText("the shared thread")).toBeInTheDocument();
    // Owner-only controls are gone for a watcher.
    expect(screen.queryByRole("button", { name: "People" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    // The composer is replaced by the read-only note.
    expect(screen.queryByPlaceholderText(/Message/)).not.toBeInTheDocument();
    expect(screen.getByText(/viewing a shared conversation/i)).toBeInTheDocument();
    // Per-message mutations (owner-scoped server-side) aren't offered to a watcher.
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  test("a 'prompt' collaborator gets the composer (#46 send path) but no owner controls", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "c1", title: "Can prompt" })]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "c1", title: "Can prompt", access: "prompt" }),
      messages: [apiMsg({ content: "promptable thread" })],
    });
    renderView(ME_ADMIN);
    await userEvent.click(await screen.findByTitle("Can prompt"));
    expect(await screen.findByText("promptable thread")).toBeInTheDocument();
    // The composer is shown (they can send), and the read-only banner is gone.
    expect(screen.getByPlaceholderText(/Message/)).toBeInTheDocument();
    expect(screen.queryByText(/viewing a shared conversation/i)).not.toBeInTheDocument();
    // Owner-only controls stay hidden — a prompt collaborator sends but can't re-share or
    // manage people.
    expect(screen.queryByRole("button", { name: "People" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  });

  test("the account settings modal opens the 'Shared with me' section", async () => {
    api.fetchSharedConversations.mockResolvedValue([
      { id: "s1", title: "Owner's chat", model: null, updatedAt: 1, role: "view", ownerName: "Leo" },
    ]);
    renderView(ME_ADMIN);
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Shared with me" }));
    expect(await screen.findByRole("heading", { name: "Shared with me" })).toBeInTheDocument();
    expect(await screen.findByText("Owner's chat")).toBeInTheDocument();
  });

  test("opening a row in the Shared section loads that conversation", async () => {
    api.fetchSharedConversations.mockResolvedValue([
      { id: "s1", title: "Owner's chat", model: null, updatedAt: 1, role: "view", ownerName: "Leo" },
    ]);
    api.fetchConversation.mockResolvedValue({
      conversation: convo({ id: "s1", title: "Owner's chat", access: "view" }),
      messages: [apiMsg({ content: "loaded from shared" })],
    });
    renderView(ME_ADMIN);
    await userEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Shared with me" }));
    await userEvent.click(await screen.findByText("Owner's chat"));
    expect(await screen.findByText("loaded from shared")).toBeInTheDocument();
    expect(api.fetchConversation).toHaveBeenCalledWith("s1");
  });
});

describe("ChatView — global keyboard shortcuts", () => {
  test("Cmd/Ctrl+B toggles the sidebar collapse (and persists it)", async () => {
    renderView();
    await screen.findByPlaceholderText(/Message/);
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    await waitFor(() => expect(localStorage.getItem("a7t_chat_sidebar_collapsed")).toBe("1"));
  });

  test("Cmd/Ctrl+Shift+M opens the model picker", async () => {
    renderView();
    // Wait for models to load (the picker shows the active model's label).
    await screen.findByText("Qwen 3");
    expect(document.querySelector(".model-pop")).toBeNull();
    fireEvent.keyDown(window, { key: "m", metaKey: true, shiftKey: true });
    await waitFor(() => expect(document.querySelector(".model-pop")).not.toBeNull());
  });

  test("Cmd/Ctrl+Shift+J opens the next chat", async () => {
    api.fetchConversations.mockResolvedValue([
      convo({ id: "a", title: "Alpha" }),
      convo({ id: "b", title: "Bravo" }),
    ]);
    api.fetchConversation.mockResolvedValue({ conversation: convo({ id: "a", title: "Alpha" }), messages: [] });
    renderView();
    await userEvent.click(await screen.findByTitle("Alpha"));
    await waitFor(() => expect(api.fetchConversation).toHaveBeenCalledWith("a"));
    fireEvent.keyDown(window, { key: "j", metaKey: true, shiftKey: true });
    await waitFor(() => expect(api.fetchConversation).toHaveBeenCalledWith("b"));
  });

  test("Cmd/Ctrl+Shift+K wraps to the previous chat", async () => {
    api.fetchConversations.mockResolvedValue([
      convo({ id: "a", title: "Alpha" }),
      convo({ id: "b", title: "Bravo" }),
    ]);
    api.fetchConversation.mockResolvedValue({ conversation: convo({ id: "a", title: "Alpha" }), messages: [] });
    renderView();
    await userEvent.click(await screen.findByTitle("Alpha"));
    await waitFor(() => expect(api.fetchConversation).toHaveBeenCalledWith("a"));
    // From the first chat, prev wraps to the last.
    fireEvent.keyDown(window, { key: "k", metaKey: true, shiftKey: true });
    await waitFor(() => expect(api.fetchConversation).toHaveBeenCalledWith("b"));
  });

  test("Cmd/Ctrl+Shift+D deletes the current chat (confirmed)", async () => {
    api.fetchConversations.mockResolvedValue([convo({ id: "a", title: "Doomed" })]);
    api.fetchConversation.mockResolvedValue({ conversation: convo({ id: "a", title: "Doomed" }), messages: [] });
    renderView();
    await userEvent.click(await screen.findByTitle("Doomed"));
    await waitFor(() => expect(api.fetchConversation).toHaveBeenCalledWith("a"));
    fireEvent.keyDown(window, { key: "d", metaKey: true, shiftKey: true });
    await waitFor(() => expect(api.deleteConversation).toHaveBeenCalledWith("a"));
  });

  test("an unbound Cmd/Ctrl combo is left to the browser (no preventDefault)", async () => {
    renderView();
    await screen.findByPlaceholderText(/Message/);
    const e = new KeyboardEvent("keydown", { key: "c", metaKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("ChatView — attachments (drag-and-drop + attach button)", () => {
  // A minimal file drag dataTransfer; the real one is inert for files in jsdom.
  function fileDrag(files: File[]) {
    return { dataTransfer: { types: ["Files"], files, items: null } };
  }
  function textDrag() {
    return { dataTransfer: { types: ["text/plain"], files: [], items: null } };
  }
  function makeFile(name: string, type = "text/plain") {
    return new File(["abc"], name, { type });
  }

  test("dragging files over the composer shows the drop overlay; leaving hides it", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    fireEvent.dragEnter(wrap, fileDrag([makeFile("a.txt")]));
    expect(screen.getByText("Drop the files here")).toBeInTheDocument();
    fireEvent.dragLeave(wrap, fileDrag([makeFile("a.txt")]));
    expect(screen.queryByText("Drop the files here")).not.toBeInTheDocument();
  });

  test("a dragleave reporting empty types (browser quirk) still hides the overlay", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    fireEvent.dragEnter(wrap, fileDrag([makeFile("a.txt")]));
    expect(screen.getByText("Drop the files here")).toBeInTheDocument();
    // Some browsers strip dataTransfer.types on leave; the depth counter must still close it.
    fireEvent.dragLeave(wrap, { dataTransfer: { types: [], files: [], items: null } });
    expect(screen.queryByText("Drop the files here")).not.toBeInTheDocument();
  });

  test("a non-file (text) drag never shows the overlay", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    fireEvent.dragEnter(wrap, textDrag());
    expect(screen.queryByText("Drop the files here")).not.toBeInTheDocument();
    // A text-drag leave must be a no-op (never incremented depth) — no crash, still hidden.
    fireEvent.dragLeave(wrap, textDrag());
    expect(screen.queryByText("Drop the files here")).not.toBeInTheDocument();
  });

  test("dropping files uploads them and shows a gallery chip; the overlay clears", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    fireEvent.dragEnter(wrap, fileDrag([makeFile("photo.png", "image/png")]));
    fireEvent.drop(wrap, fileDrag([makeFile("photo.png", "image/png")]));
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalled());
    expect(await screen.findByText("photo.png")).toBeInTheDocument();
    expect(screen.queryByText("Drop the files here")).not.toBeInTheDocument();
  });

  test("the attach button uploads a picked file into the gallery; remove clears it", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    const input = wrap.querySelector(".composer-file-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile("notes.txt")] } });
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalled());
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  test("a rejected upload surfaces its error copy on the chip", async () => {
    api.uploadFile.mockResolvedValue({ ok: false, reason: "quota" });
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    fireEvent.drop(wrap, fileDrag([makeFile("big.bin")]));
    expect(await screen.findByText("You've reached your storage limit.")).toBeInTheDocument();
  });

  test("sending a message clears the attachment gallery", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    fireEvent.drop(wrap, fileDrag([makeFile("keep.txt")]));
    expect(await screen.findByText("keep.txt")).toBeInTheDocument();
    await userEvent.type(box, "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByText("keep.txt")).not.toBeInTheDocument());
  });

  test("no attach button or drop-zone when the files entitlement is off", async () => {
    renderView({ ...ME_GUEST, features: { files: false } });
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    fireEvent.dragEnter(wrap, fileDrag([makeFile("a.txt")]));
    expect(screen.queryByText("Drop the files here")).not.toBeInTheDocument();
    fireEvent.drop(wrap, fileDrag([makeFile("a.txt")]));
    expect(api.uploadFile).not.toHaveBeenCalled();
  });
});

describe("ChatView — attachments: Omni gate + per-message cap (#136)", () => {
  function fileDrag(files: File[]) {
    return { dataTransfer: { types: ["Files"], files, items: null } };
  }
  function makeFile(name: string, type = "text/plain") {
    return new File(["abc"], name, { type });
  }
  const UNSUPPORTED = "This model can't read files — switch to a multimodal model.";
  const BLOCKED = "This model can't read files — switch to a multimodal model or remove them to send.";

  // Open the model picker and select a model by its friendly label.
  async function switchModel(label: string) {
    await userEvent.click(await screen.findByRole("button", { name: "Select model" }));
    const list = screen.getByRole("listbox");
    await userEvent.click(within(list).getByText(label));
  }

  test("attach button is enabled on a multimodal model, disabled with a reason on a text model", async () => {
    renderView();
    // The default model (qwen) is multimodal in the catalog → the paperclip is enabled.
    await waitFor(() => expect(screen.getByRole("button", { name: "Attach files" })).toBeEnabled());
    // Switching to the text-only model disables it, and the reason rides the label.
    await switchModel("Llama 3");
    await waitFor(() => expect(screen.getByRole("button", { name: UNSUPPORTED })).toBeDisabled());
  });

  test("dragging over a text model shows a red 'not supported' overlay and rejects the drop", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    await switchModel("Llama 3");
    await waitFor(() => expect(screen.getByRole("button", { name: UNSUPPORTED })).toBeDisabled());
    fireEvent.dragEnter(wrap, fileDrag([makeFile("a.txt")]));
    expect(screen.getByText("Files aren't supported on this model")).toBeInTheDocument();
    expect(document.querySelector(".composer-dropzone")?.classList.contains("rejected")).toBe(true);
    fireEvent.drop(wrap, fileDrag([makeFile("a.txt")]));
    expect(api.uploadFile).not.toHaveBeenCalled();
  });

  test("switching to a text model after attaching shows a block notice and refuses the send", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    // Attach on the multimodal model; the upload lands (chip ready).
    fireEvent.drop(wrap, fileDrag([makeFile("keep.txt")]));
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalled());
    expect(await screen.findByText("keep.txt")).toBeInTheDocument();
    // Now switch to a text-only model: the block notice appears once the attachment is ready.
    await switchModel("Llama 3");
    expect(await screen.findByText(BLOCKED)).toBeInTheDocument();
    // A send is refused — the draft is kept, not cleared.
    await userEvent.type(box, "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(box).toHaveValue("hello");
    expect(screen.getByText("keep.txt")).toBeInTheDocument();
  });

  test("caps attachments at 10 per message with a visible notice", async () => {
    renderView();
    const box = await screen.findByPlaceholderText(/Message/);
    const wrap = box.closest(".composer-wrap") as HTMLElement;
    const eleven = Array.from({ length: 11 }, (_, i) => makeFile(`f${i}.txt`));
    fireEvent.drop(wrap, fileDrag(eleven));
    expect(await screen.findByText("Up to 10 files per message")).toBeInTheDocument();
    expect(wrap.querySelectorAll(".composer-attachment")).toHaveLength(10);
  });
});

// --- live dictation / streaming STT (#71) ------------------------------------------------
// The standalone mic button is hidden (DICTATION_MIC_ENABLED=false); live dictation is now driven
// only by its keyboard shortcut (mod+shift+u), which these tests fire.
describe("live dictation", () => {
  type Handlers = Parameters<typeof import("../lib/dictation").streamDictation>[0];
  function fireDictationShortcut() {
    fireEvent.keyDown(window, { key: "u", metaKey: true, shiftKey: true });
  }

  test("the shortcut streams partial transcripts into the composer live, then commits on stop", async () => {
    let handlers: Handlers | undefined;
    const stop = vi.fn(() => handlers?.onStop?.());
    dictation.streamDictation.mockImplementation(async (h: Handlers) => {
      handlers = h;
      return { stop };
    });

    renderView(ME_DICTATION);
    const box = (await screen.findByPlaceholderText(/Message/)) as HTMLTextAreaElement;
    // The shortcut opens the live stream when the server has a streaming backend.
    fireDictationShortcut();
    await waitFor(() => expect(dictation.streamDictation).toHaveBeenCalled());
    expect(await screen.findByText("Listening…")).toBeInTheDocument();

    // A partial streams in from a mid-stream (non-terminal) slice; a fuller partial REPLACES it
    // (mid-utterance correction), all via the real pure reconciler. The second arg is the
    // terminal-segment flag (#218) — false for these interim slices.
    await act(async () => handlers?.onEvent({ type: "partial", text: "I scream" }, false));
    expect(box).toHaveValue("I scream");
    await act(async () => handlers?.onEvent({ type: "partial", text: "ice cream" }, false));
    expect(box).toHaveValue("ice cream");

    // Firing the shortcut again stops → commits the trailing interim + hides the indicator.
    fireDictationShortcut();
    await waitFor(() => expect(stop).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Listening…")).not.toBeInTheDocument());
    expect(box).toHaveValue("ice cream");
  });

  test("the shortcut no-ops when streaming is dark (unavailable) — no batch surprise", async () => {
    renderView(ME_ADMIN); // no me.dictation.available → the shortcut deliberately does nothing
    await screen.findByPlaceholderText(/Message/);
    fireDictationShortcut();
    expect(dictation.streamDictation).not.toHaveBeenCalled();
  });

  test("the shortcut no-ops when the browser can't capture audio", async () => {
    dictation.dictationSupported.mockReturnValue(false);
    renderView(ME_DICTATION);
    await screen.findByPlaceholderText(/Message/);
    fireDictationShortcut();
    expect(dictation.streamDictation).not.toHaveBeenCalled();
  });
});

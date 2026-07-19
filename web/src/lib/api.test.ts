import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import {
  authHeaders,
  branchConversation,
  cancelGeneration,
  compactConversation,
  canEditContentIn,
  canPromptIn,
  clearToken,
  createShare,
  fetchSharedConversations,
  inviteCollaborator,
  listCollaborators,
  removeCollaborator,
  updateCollaboratorRole,
  deleteConversation,
  deleteFile,
  deleteShare,
  dismissRecap,
  fetchDirectory,
  fetchRecap,
  forceRecap,
  fileDownloadUrl,
  forgetAllMemory,
  forgetFact,
  listMemory,
  fetchSharedConversation,
  listFiles,
  uploadFile,
  toggleConversationTodo,
  toggleSharedTodo,
  getShare,
  fetchConversation,
  fetchConversations,
  fetchMe,
  fetchModelCatalog,
  fetchModels,
  generateConversationTitle,
  getToken,
  listAccounts,
  logout,
  renameConversation,
  revokeAccount,
  saveSettings,
  setHandle,
  selectVariant,
  setAccountPlan,
  setConversationStarred,
  setToken,
  transcribe,
  voteMessage,
} from "./api";

const TOKEN_KEY = "a7t_chat_token";

// Build a Response with the bits these helpers read (status, ok, json()). Defaults to a
// JSON body so `.json()` works; pass `ok:false`/`status` to drive the error branches.
function jsonRes(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installLocalStorage();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("token helpers", () => {
  test("set / get / clear round-trip via localStorage", () => {
    expect(getToken()).toBeNull();
    setToken("tok-123");
    expect(getToken()).toBe("tok-123");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok-123");
    clearToken();
    expect(getToken()).toBeNull();
  });
});

describe("authHeaders", () => {
  test("is empty when no token is stored", () => {
    expect(authHeaders()).toEqual({});
  });

  test("carries a bearer token when present", () => {
    setToken("abc");
    expect(authHeaders()).toEqual({ Authorization: "Bearer abc" });
  });
});

describe("fetchMe", () => {
  test("returns the Me payload on 200 and sends auth headers", async () => {
    setToken("t1");
    const me = { role: "admin", via: "owner", user: { id: "u", login: "leo", displayName: null }, key: null, theme: null, lang: null };
    fetchMock.mockResolvedValue(jsonRes(me));
    const out = await fetchMe();
    expect(out).toEqual(me);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/me");
    expect(init.headers).toEqual({ Authorization: "Bearer t1" });
  });

  test("returns null on 401 (the wall)", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 401 }));
    expect(await fetchMe()).toBeNull();
  });

  test("throws on a non-401 error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 500 }));
    await expect(fetchMe()).rejects.toThrow("/api/me -> 500");
  });
});

describe("fetchModels", () => {
  test("returns the models payload", async () => {
    const payload = { models: ["a"], labels: { a: "A" }, default: "a" };
    fetchMock.mockResolvedValue(jsonRes(payload));
    expect(await fetchModels()).toEqual(payload);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/models");
  });

  test("throws on error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 503 }));
    await expect(fetchModels()).rejects.toThrow("/api/models -> 503");
  });
});

describe("fetchModelCatalog", () => {
  test("returns the enriched catalog with per-model input modalities", async () => {
    const payload = { models: [{ id: "qwen-omni", displayName: "Qwen Omni", input: ["text", "image"] }], default: "qwen-chat" };
    fetchMock.mockResolvedValue(jsonRes(payload));
    expect(await fetchModelCatalog()).toEqual(payload);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/models/catalog");
  });

  test("throws on error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 500 }));
    await expect(fetchModelCatalog()).rejects.toThrow("/api/models/catalog -> 500");
  });
});

describe("fetchConversations", () => {
  test("unwraps the conversations array", async () => {
    fetchMock.mockResolvedValue(jsonRes({ conversations: [{ id: "c1" }] }));
    const out = await fetchConversations();
    expect(out).toEqual([{ id: "c1" }]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations");
  });

  test("throws on error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 500 }));
    await expect(fetchConversations()).rejects.toThrow("/api/conversations -> 500");
  });
});

describe("fetchConversation", () => {
  test("returns the conversation + messages by id", async () => {
    const payload = { conversation: { id: "c1" }, messages: [] };
    fetchMock.mockResolvedValue(jsonRes(payload));
    expect(await fetchConversation("c1")).toEqual(payload);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c1");
  });

  test("returns null on 404 (gone for this caller — deleted or another user's id)", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 404 }));
    expect(await fetchConversation("nope")).toBeNull();
  });

  test("throws with the id in the message on a non-404 error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 500 }));
    await expect(fetchConversation("oops")).rejects.toThrow("/api/conversations/oops -> 500");
  });
});

describe("compactConversation (#38)", () => {
  const ctx = { usedTokens: 900, windowTokens: 32768, ratio: 0.03, shouldPrompt: false, showMeter: false };

  test("POSTs to the compact endpoint and returns the new snapshot", async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, foldedCount: 4, context: ctx }));
    const result = await compactConversation("c1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c1/compact");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(result).toEqual({ foldedCount: 4, context: ctx });
  });

  test("returns null on a rejection (422 short thread / 502 / 404)", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "not enough conversation to compact yet" }, { status: 422 }));
    expect(await compactConversation("c1")).toBeNull();
  });

  test("returns null when the body carries no context", async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, foldedCount: 0 }));
    expect(await compactConversation("c1")).toBeNull();
  });

  test("returns null on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await compactConversation("c1")).toBeNull();
  });
});

describe("renameConversation", () => {
  test("PATCHes the title with json content-type + auth", async () => {
    setToken("t");
    fetchMock.mockResolvedValue(jsonRes({}));
    await renameConversation("c1", "New title");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer t" });
    expect(JSON.parse(init.body)).toEqual({ title: "New title" });
  });

  test("throws on error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 400 }));
    await expect(renameConversation("c1", "x")).rejects.toThrow("rename -> 400");
  });
});

describe("generateConversationTitle", () => {
  test("POSTs and returns the new title", async () => {
    fetchMock.mockResolvedValue(jsonRes({ title: "Auto Title" }));
    expect(await generateConversationTitle("c1")).toBe("Auto Title");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1/title");
    expect(init.method).toBe("POST");
  });

  test("returns empty string when the body has no title", async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    expect(await generateConversationTitle("c1")).toBe("");
  });

  test("throws on error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 500 }));
    await expect(generateConversationTitle("c1")).rejects.toThrow("title -> 500");
  });
});

describe("setConversationStarred", () => {
  test("PATCHes the starred flag", async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    await setConversationStarred("c1", true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ starred: true });
  });

  test("throws on error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 400 }));
    await expect(setConversationStarred("c1", false)).rejects.toThrow("star -> 400");
  });
});

describe("deleteConversation", () => {
  test("DELETEs the conversation", async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    await deleteConversation("c1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1");
    expect(init.method).toBe("DELETE");
  });

  test("throws on error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 500 }));
    await expect(deleteConversation("c1")).rejects.toThrow("delete -> 500");
  });
});

describe("branchConversation (#72)", () => {
  test("POSTs the fork point with auth + returns the new conversation meta", async () => {
    setToken("t9");
    const conv = { id: "c2", title: "Trip", model: "qwen", starred: false, updatedAt: 0 };
    fetchMock.mockResolvedValue(jsonRes({ conversation: conv }));
    const out = await branchConversation("c1", "m1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1/branch");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ messageId: "m1" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t9");
    expect(out).toEqual(conv);
  });

  test("returns null on a non-ok response (foreign/stale conversation)", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "not found" }, { status: 404 }));
    expect(await branchConversation("c1", "m1")).toBeNull();
  });

  test("returns null on a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await branchConversation("c1", "m1")).toBeNull();
  });

  test("returns null when the response omits the conversation", async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    expect(await branchConversation("c1", "m1")).toBeNull();
  });
});

describe("fetchRecap (#37)", () => {
  const recap = { topic: "T", progress: ["a", "b"], whereItEnded: "e", nextStep: "n" };

  test("GETs the recap endpoint with auth + returns the recap", async () => {
    setToken("tk");
    fetchMock.mockResolvedValue(jsonRes({ recap }));
    const out = await fetchRecap("c1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1/recap");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tk");
    expect(out).toEqual(recap);
  });

  test("returns null when the server has nothing to show (recap:null)", async () => {
    fetchMock.mockResolvedValue(jsonRes({ recap: null }));
    expect(await fetchRecap("c1")).toBeNull();
  });

  test("returns null on a 404 (stranger/unknown id)", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "not found" }, { status: 404 }));
    expect(await fetchRecap("c1")).toBeNull();
  });

  test("returns null on a network failure (best-effort surface)", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await fetchRecap("c1")).toBeNull();
  });
});

describe("forceRecap (#37) - the /recap command", () => {
  const recap = { topic: "T", progress: ["a", "b"], whereItEnded: "e", nextStep: "n" };

  test("GETs the recap endpoint with ?force=1 + auth and returns the recap", async () => {
    setToken("tk");
    fetchMock.mockResolvedValue(jsonRes({ recap }));
    const out = await forceRecap("c1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1/recap?force=1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tk");
    expect(out).toEqual(recap);
  });

  test("returns null when the thread is too thin to recap (recap:null)", async () => {
    fetchMock.mockResolvedValue(jsonRes({ recap: null }));
    expect(await forceRecap("c1")).toBeNull();
  });

  test("returns null on a 404 (stranger/unknown id)", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "not found" }, { status: 404 }));
    expect(await forceRecap("c1")).toBeNull();
  });

  test("returns null on a network failure (best-effort surface)", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await forceRecap("c1")).toBeNull();
  });
});

describe("dismissRecap (#37)", () => {
  test("POSTs the dismiss endpoint with auth", async () => {
    setToken("tk");
    fetchMock.mockResolvedValue(jsonRes({ ok: true }));
    await dismissRecap("c1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1/recap/dismiss");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tk");
  });

  test("swallows a network failure (the card hides optimistically anyway)", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(dismissRecap("c1")).resolves.toBeUndefined();
  });
});

describe("saveSettings", () => {
  test("PUTs the patch (does not throw on non-ok — fire-and-forget)", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 500 }));
    await saveSettings({ theme: "nord", lang: "en" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ theme: "nord", lang: "en" });
  });
});

describe("setHandle (#189)", () => {
  test("PUTs to /api/settings/handle and returns the server-normalized handle on success", async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true, handle: "leo_42" }));
    const res = await setHandle("Leo_42");
    expect(res).toEqual({ ok: true, handle: "leo_42" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings/handle");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ handle: "Leo_42" });
  });

  test("maps a 409 collision to the typed `taken` error", async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: false, error: "taken" }, { status: 409 }));
    expect(await setHandle("dup")).toEqual({ ok: false, error: "taken" });
  });

  test("maps a 400 charset/length reject to its typed error", async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: false, error: "charset" }, { status: 400 }));
    expect(await setHandle("no good")).toEqual({ ok: false, error: "charset" });
  });

  test("an unknown error shape / network failure degrades to a generic error", async () => {
    fetchMock.mockResolvedValue(jsonRes({}, { status: 500 }));
    expect(await setHandle("leo")).toEqual({ ok: false, error: "error" });
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await setHandle("leo")).toEqual({ ok: false, error: "error" });
  });
});

describe("fetchDirectory (#190)", () => {
  test("GETs /api/users with no query string when the search is blank, returns the users", async () => {
    const users = [{ id: "u1", handle: "alice", name: "Alice A" }];
    fetchMock.mockResolvedValue(jsonRes({ users }));
    expect(await fetchDirectory()).toEqual(users);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/users");
  });

  test("appends an encoded, trimmed ?q= when searching", async () => {
    fetchMock.mockResolvedValue(jsonRes({ users: [] }));
    await fetchDirectory("  Leo & Co  ");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/users?q=Leo%20%26%20Co");
  });

  test("omits ?q= for a whitespace-only query", async () => {
    fetchMock.mockResolvedValue(jsonRes({ users: [] }));
    await fetchDirectory("   ");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/users");
  });

  test("throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue(jsonRes({}, { status: 500 }));
    await expect(fetchDirectory()).rejects.toThrow(/\/api\/users/);
  });
});

describe("transcribe", () => {
  test("POSTs a multipart form and returns the transcript text", async () => {
    fetchMock.mockResolvedValue(jsonRes({ text: "hello world" }));
    const blob = new Blob(["x"], { type: "audio/webm" });
    expect(await transcribe(blob)).toBe("hello world");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/transcribe");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBeInstanceOf(Blob);
  });

  test("returns empty string when the response has no text", async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    expect(await transcribe(new Blob(["x"]))).toBe("");
  });

  test("throws on error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 500 }));
    await expect(transcribe(new Blob(["x"]))).rejects.toThrow("transcribe -> 500");
  });
});

describe("voteMessage", () => {
  test("POSTs the vote value", async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    await voteMessage("m1", 1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/messages/m1/vote");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ vote: 1 });
  });
});

describe("selectVariant", () => {
  test("POSTs to the select endpoint", async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    await selectVariant("m1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/messages/m1/select");
    expect(init.method).toBe("POST");
  });
});

describe("cancelGeneration", () => {
  test("POSTs to the stop endpoint", async () => {
    fetchMock.mockResolvedValue(jsonRes({}));
    await cancelGeneration("c1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1/stop");
    expect(init.method).toBe("POST");
  });
});

describe("fetchMe (credentials)", () => {
  test("sends credentials:'include' so the session cookie flows", async () => {
    fetchMock.mockResolvedValue(jsonRes({ role: "account", via: "session", user: { id: "u", login: "acct_x", email: "a@b.co" }, key: null, theme: null, lang: null, accessGranted: true }));
    await fetchMe();
    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  });
});

describe("logout", () => {
  test("POSTs to logout with credentials and swallows failures", async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true }));
    await logout();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });

  test("does not throw when the request rejects", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(logout()).resolves.toBeUndefined();
  });
});

describe("listAccounts", () => {
  test("unwraps the accounts array, sending auth + credentials (no secrets in the row)", async () => {
    setToken("t");
    const rows = [
      {
        id: "u1",
        email: "leo@example.com",
        login: "acct_x",
        accessGrantedAt: 100,
        plan: "ultra",
        createdAt: 1,
        usageTokens: 250,
        lastSeenAt: 200,
      },
    ];
    fetchMock.mockResolvedValue(jsonRes({ accounts: rows }));
    expect(await listAccounts()).toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/accounts");
    expect(init.credentials).toBe("include");
    expect(init.headers).toEqual({ Authorization: "Bearer t" });
  });

  test("throws on error", async () => {
    fetchMock.mockResolvedValue(jsonRes(undefined, { status: 500 }));
    await expect(listAccounts()).rejects.toThrow("/api/admin/accounts -> 500");
  });
});

describe("revokeAccount", () => {
  test("POSTs to the revoke endpoint with auth + credentials", async () => {
    setToken("t");
    fetchMock.mockResolvedValue(jsonRes({ ok: true }));
    await revokeAccount("u1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/accounts/u1/revoke");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers).toEqual({ Authorization: "Bearer t" });
  });

  test("throws on error (e.g. a 404 for an unknown id)", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "not found" }, { status: 404 }));
    await expect(revokeAccount("nope")).rejects.toThrow("revoke-account -> 404");
  });
});

describe("setAccountPlan", () => {
  test("POSTs the plan and returns the refreshed row", async () => {
    setToken("t");
    const account = { id: "u1", email: null, login: "acct", accessGrantedAt: 1, plan: "pro", createdAt: 1, usageTokens: 0, lastSeenAt: null };
    fetchMock.mockResolvedValue(jsonRes({ account }));
    const out = await setAccountPlan("u1", "pro");
    expect(out).toEqual(account);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/accounts/u1/plan");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body)).toEqual({ plan: "pro" });
  });

  test("throws the server error message on failure", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "invalid plan" }, { status: 400 }));
    await expect(setAccountPlan("u1", "pro")).rejects.toThrow("invalid plan");
  });
});

describe("share endpoints", () => {
  test("getShare returns the share info", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ shared: true, slug: "abc", url: "https://a7t.chat/s/abc" }));
    const info = await getShare("c1");
    expect(info).toMatchObject({ shared: true, slug: "abc" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c1/share");
  });

  test("getShare throws on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "nope" }, { status: 404 }));
    await expect(getShare("c1")).rejects.toThrow();
  });

  test("createShare POSTs and returns the link", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ shared: true, slug: "xy", url: "https://a7t.chat/s/xy" }));
    const info = await createShare("c2");
    expect(info.url).toContain("/s/xy");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  test("createShare throws on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 404 }));
    await expect(createShare("c2")).rejects.toThrow();
  });

  test("deleteShare DELETEs", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, shared: false }));
    await deleteShare("c3");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c3/share");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });

  test("deleteShare throws on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 500 }));
    await expect(deleteShare("c3")).rejects.toThrow();
  });

  test("fetchSharedConversation returns the public snapshot (no auth header)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ conversation: { id: "c4", title: "Hello" }, messages: [{ id: "m1", role: "user", content: "hi", model: null, createdAt: 1 }] }),
    );
    const snap = await fetchSharedConversation("slugy");
    expect(snap?.conversation.title).toBe("Hello");
    expect(snap?.messages).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/share/slugy");
    // public read — no Authorization header passed
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
  });

  test("fetchSharedConversation encodes the slug", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ conversation: { id: "c", title: null }, messages: [] }));
    await fetchSharedConversation("a/b");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/share/a%2Fb");
  });

  test("fetchSharedConversation returns null on 404 (revoked/unknown)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "not found" }, { status: 404 }));
    expect(await fetchSharedConversation("gone")).toBeNull();
  });

  test("fetchSharedConversation throws on a non-404 error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "boom" }, { status: 500 }));
    await expect(fetchSharedConversation("x")).rejects.toThrow();
  });

  test("toggleSharedTodo POSTs the token in a header + returns the server content", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, content: "- [x] eggs" }));
    const out = await toggleSharedTodo("slugy", "wt1", "m2", 0, true);
    expect(out).toBe("- [x] eggs");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/share/slugy/todo");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-a7t-share-write"]).toBe("wt1");
    expect(JSON.parse(init.body as string)).toEqual({ messageId: "m2", index: 0, done: true });
  });

  test("toggleSharedTodo encodes the slug in the path", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, content: "x" }));
    await toggleSharedTodo("a/b", "wt1", "m2", 0, true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/share/a%2Fb/todo");
  });

  test("toggleSharedTodo returns null on any rejection (so the caller reverts)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "invalid token" }, { status: 401 }));
    expect(await toggleSharedTodo("slugy", "bad", "m2", 0, true)).toBeNull();
  });
});

describe("owner-side TODO toggle (#131)", () => {
  test("toggleConversationTodo POSTs the item to the owner endpoint with auth + returns the server content", async () => {
    setToken("t9");
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, content: "- [x] eggs" }));
    const out = await toggleConversationTodo("c9", "m9", 1, true);
    expect(out).toBe("- [x] eggs");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c9/todo");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    // The write is authorized by the ambient credential (auth header), not a share token.
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t9");
    expect((init.headers as Record<string, string>)["x-a7t-share-write"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ messageId: "m9", index: 1, done: true });
  });

  test("toggleConversationTodo returns null on a rejection (403/404) so the caller reverts", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "not found" }, { status: 404 }));
    expect(await toggleConversationTodo("c9", "m9", 0, true)).toBeNull();
  });

  test("toggleConversationTodo returns null on a network failure (never throws)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await toggleConversationTodo("c9", "m9", 0, false)).toBeNull();
  });

  test("canEditContentIn allows owner/undefined and the edit/prompt collaborator roles", () => {
    expect(canEditContentIn(undefined)).toBe(true);
    expect(canEditContentIn("owner")).toBe(true);
    expect(canEditContentIn("edit")).toBe(true);
    expect(canEditContentIn("prompt")).toBe(true);
    // Read-only tiers keep checkboxes disabled.
    expect(canEditContentIn("view")).toBe(false);
    expect(canEditContentIn("suggest")).toBe(false);
  });
});

describe("Share primitive — collaborators", () => {
  test("canPromptIn allows owner/undefined and the 'prompt' collaborator role (#46)", () => {
    expect(canPromptIn(undefined)).toBe(true);
    expect(canPromptIn("owner")).toBe(true);
    // The `prompt` role opens the collaborative send path (POST /chat authorizes it server-side).
    expect(canPromptIn("prompt")).toBe(true);
    // Lower collaborator roles stay read + live-watch only — no composer.
    expect(canPromptIn("view")).toBe(false);
    expect(canPromptIn("suggest")).toBe(false);
    expect(canPromptIn("edit")).toBe(false);
  });

  test("listCollaborators returns the array and sends auth headers", async () => {
    setToken("t1");
    fetchMock.mockResolvedValueOnce(jsonRes({ collaborators: [{ userId: "u", handle: "alice", displayName: null, role: "view", createdAt: 1 }] }));
    const out = await listCollaborators("c1");
    expect(out).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c1/collaborators");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer t1" });
  });

  test("listCollaborators throws on error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 404 }));
    await expect(listCollaborators("c1")).rejects.toThrow();
  });

  test("inviteCollaborator posts handle + role and returns ok", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, collaborator: { userId: "u", role: "edit" } }));
    const out = await inviteCollaborator("c1", "alice", "edit");
    expect(out).toEqual({ ok: true, collaborator: { userId: "u", role: "edit" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1/collaborators");
    expect(init.method).toBe("POST");
    // The invite carries a HANDLE (not an email) — email never leaves the client for this call.
    expect(JSON.parse(init.body)).toEqual({ handle: "alice", role: "edit" });
  });

  test("inviteCollaborator surfaces the typed reason (no_account / self)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "x", reason: "no_account" }, { status: 404 }));
    expect(await inviteCollaborator("c1", "ghost", "view")).toEqual({ ok: false, reason: "no_account" });
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "x", reason: "self" }, { status: 400 }));
    expect(await inviteCollaborator("c1", "me", "view")).toEqual({ ok: false, reason: "self" });
  });

  test("inviteCollaborator maps an unknown failure to 'error'", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "nope" }, { status: 500 }));
    expect(await inviteCollaborator("c1", "alice", "view")).toEqual({ ok: false, reason: "error" });
  });

  test("updateCollaboratorRole PATCHes the role", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, role: "prompt" }));
    await updateCollaboratorRole("c1", "u9", "prompt");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1/collaborators/u9");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ role: "prompt" });
  });

  test("updateCollaboratorRole throws on error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 404 }));
    await expect(updateCollaboratorRole("c1", "u9", "view")).rejects.toThrow();
  });

  test("removeCollaborator DELETEs the grant", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await removeCollaborator("c1", "u9");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/conversations/c1/collaborators/u9");
    expect(init.method).toBe("DELETE");
  });

  test("removeCollaborator throws on error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 404 }));
    await expect(removeCollaborator("c1", "u9")).rejects.toThrow();
  });

  test("fetchSharedConversations returns the shared list", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ conversations: [{ id: "c", title: "T", model: null, updatedAt: 1, role: "view", ownerName: "Leo" }] }));
    const out = await fetchSharedConversations();
    expect(out).toHaveLength(1);
    expect(out[0]!.ownerName).toBe("Leo");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/shared-conversations");
  });

  test("fetchSharedConversations throws on error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 500 }));
    await expect(fetchSharedConversations()).rejects.toThrow();
  });
});

describe("attachments / file manager (#15)", () => {
  test("listFiles returns the listing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ files: [{ id: "f1", filename: "a.txt", contentType: "text/plain", size: 3, createdAt: 1 }], usage: { count: 1, totalBytes: 3 }, limits: { maxFileBytes: 10, maxTotalBytes: 100, maxCount: 5 } }),
    );
    const out = await listFiles();
    expect(out.files).toHaveLength(1);
    expect(out.usage.count).toBe(1);
    expect(out.limits.maxCount).toBe(5);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/files");
  });

  test("listFiles throws on error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 500 }));
    await expect(listFiles()).rejects.toThrow();
  });

  test("uploadFile posts multipart and returns the stored metadata", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, file: { id: "f1", filename: "a.txt", contentType: "text/plain", size: 2, createdAt: 1 } }, { status: 201 }));
    const res = await uploadFile(new File(["hi"], "a.txt", { type: "text/plain" }));
    expect(res).toEqual({ ok: true, file: { id: "f1", filename: "a.txt", contentType: "text/plain", size: 2, createdAt: 1 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/files");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  test("uploadFile maps a 413 quota error to reason=quota", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "storage quota exceeded" }, { status: 413 }));
    expect(await uploadFile(new File(["x"], "x"))).toEqual({ ok: false, reason: "quota" });
  });

  test("uploadFile maps a 413 size error to reason=too_large", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "file too large" }, { status: 413 }));
    expect(await uploadFile(new File(["x"], "x"))).toEqual({ ok: false, reason: "too_large" });
  });

  test("uploadFile maps any other failure to reason=error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "bad" }, { status: 400 }));
    expect(await uploadFile(new File(["x"], "x"))).toEqual({ ok: false, reason: "error" });
  });

  test("deleteFile calls DELETE and resolves", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await deleteFile("f 1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/files/f%201"); // id is URL-encoded
    expect((init as RequestInit).method).toBe("DELETE");
  });

  test("deleteFile throws on error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 404 }));
    await expect(deleteFile("f1")).rejects.toThrow();
  });

  test("fileDownloadUrl builds an encoded URL", () => {
    expect(fileDownloadUrl("f1")).toBe("/api/files/f1");
    expect(fileDownloadUrl("a b")).toBe("/api/files/a%20b");
  });
});

describe("archivist memory (#27)", () => {
  test("listMemory returns the enabled flag + facts", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ enabled: true, facts: [{ id: "m1", content: "likes tea", createdAt: "2026-01-01" }] }));
    const out = await listMemory();
    expect(out.enabled).toBe(true);
    expect(out.facts).toEqual([{ id: "m1", content: "likes tea", createdAt: "2026-01-01" }]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/memory");
  });

  test("listMemory throws on error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 500 }));
    await expect(listMemory()).rejects.toThrow();
  });

  test("forgetFact calls DELETE with the encoded id", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    await forgetFact("m 1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/memory/m%201");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  test("forgetFact treats a 404 as success (already gone)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "not found" }, { status: 404 }));
    await expect(forgetFact("gone")).resolves.toBeUndefined();
  });

  test("forgetFact throws on a non-404 error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "boom" }, { status: 500 }));
    await expect(forgetFact("m1")).rejects.toThrow();
  });

  test("forgetAllMemory DELETEs the collection and returns the cleared count", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, cleared: 3 }));
    expect(await forgetAllMemory()).toBe(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/memory");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  test("forgetAllMemory defaults to 0 when the body omits the count", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }));
    expect(await forgetAllMemory()).toBe(0);
  });

  test("forgetAllMemory throws on error", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "no" }, { status: 500 }));
    await expect(forgetAllMemory()).rejects.toThrow();
  });
});


// Client API helpers. Guests carry a bearer token (saved locally); admins are
// auto-authenticated by the Tailscale identity header, so no token is needed.

import type { Preferences } from "./preferences";

const TOKEN_KEY = "a7t_chat_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// The account subscription ladder (#13): the local-taste floor → BYOK → the flat paid rung. The
// admin/owner is "owner", ABOVE the ladder. Kept in sync with the server catalog (plans.ts).
export type AccountPlanId = "free" | "plus" | "pro" | "ultra";
export type PlanId = "owner" | AccountPlanId;

export interface Me {
  // "account" = passkey sign-up (#169); admins are Tailscale-authed. `guest` is legacy. An account
  // reaches ChatView once accessGranted is true (passkey sign-up grants it directly).
  role: "admin" | "guest" | "account";
  via: string;
  // `handle` (#189) is the user-chosen public identifier — null until set. The client's display
  // precedence prefers it (see lib/identity.ts) so a passkey account's synthetic `acct_<uuid>` login
  // is never shown. Optional for shape stability with older responses (treated as unset).
  user: { id: string; login: string; displayName: string | null; email?: string | null; handle?: string | null };
  key: { id: string; label: string } | null;
  // Whether this caller may use the app. Always true for admin; for an account it's true after a
  // passkey sign-up and only false for a legacy never-granted / owner-revoked row.
  accessGranted?: boolean;
  // Self-service profile (#12): the caller's plan. `plan` is "owner" (admin, above the ladder) or
  // the account's subscription rung (#13: "free" | "plus" | "pro" | "ultra"). Optional for shape
  // stability with older responses — the ProfilePanel falls back to "free" when absent. The usage
  // meter was dropped (#186).
  plan?: PlanId;
  theme: string | null;
  lang: string | null;
  // Account-synced customization (#11): persona/behavior/visual/accessibility. Always the
  // normalized shape from the server (defaults when unset). Optional for shape stability with
  // older responses — the client re-normalizes on read regardless.
  preferences?: Preferences;
  // Deployment environment ("production" | "staging"); the UI shows a badge when not prod.
  env?: string;
  // Web search ("Research"): present + available when this caller may use it (a provider
  // is configured and they're entitled). The composer shows the toggle only when so.
  search?: { available: boolean };
  // Passkey (WebAuthn) sign-in (#20): whether the server has passkeys configured (WEBAUTHN_RP_ID
  // set). Drives the in-app passkey manager entry; the pre-auth login button reads the public
  // /api/auth/passkey/available probe instead. Absent on older responses (treated as unavailable).
  passkeys?: { available: boolean };
  // Live dictation / streaming STT (#71): whether the server has a streaming ASR backend
  // configured (STREAMING_STT_URL set). When available the composer offers the live "text as you
  // speak" mic; when absent/false it shows only the existing batch Whisper mic. The /api/dictate
  // route re-checks this server-side. Absent on older responses (treated as unavailable).
  dictation?: { available: boolean };
  // Bring-your-own-key (#14): whether the server has BYOK configured (BYOK_ENCRYPTION_KEY set) and —
  // only for an entitled caller — which providers they've connected (provider ids; the "Keys" panel
  // fetches the full masked list from GET /api/byok). `features.byok` carries the pure entitlement.
  // Absent on older responses (treated as unavailable → the panel shows the dark empty state).
  byok?: { available: boolean; providers: string[] };
  // Per-feature entitlements for this caller (e.g. `chat.voice`, `conversations.write`,
  // `admin.keys`). A hint for showing/hiding entry points — the server re-checks on every
  // call. See src/entitlements/. `features.research` is pure tier entitlement; use
  // `search.available` for the composer toggle (it also requires a configured provider).
  features?: Partial<Record<string, boolean>>;
  // Capability suggestion engine (#22): the caller's ACTIVE contextual-nudge set — enabled +
  // entitled capabilities that declare a suggestion. The client matches these against the latest
  // exchange locally (content-free) and surfaces a dismissible chip. Absent on older responses.
  suggestions?: SuggestionHint[];
}

// One capability's contextual nudge (#22), as shipped by the server (src/capabilities/suggest.ts).
// `id` is the capability's marker id, so the client can suppress the nudge when the reply already
// used that marker. `triggers` are keywords matched (word-boundary, case-insensitive) client-side.
export interface SuggestionHint {
  id: string;
  title: string;
  body: string;
  triggers: string[];
}

// A cited web source returned by the search step (citations [n] in the answer map here).
export interface Source {
  n: number;
  title: string;
  url: string;
  domain: string;
}

// Context-window usage snapshot (#38) — the EFFECTIVE prompt size vs the active model's window,
// computed server-side (the pure token logic lives in src/chat/compaction.ts). Drives the composer's
// subtle usage meter and, near the limit, the "Compact" nudge. `ratio` is clamped [0,1] for display;
// `shouldPrompt` fires at >=75%; `showMeter` keeps the affordance hidden until the thread is long.
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
  shouldPrompt: boolean;
  showMeter: boolean;
}

export interface ConversationMeta {
  id: string;
  title: string | null;
  model: string | null;
  starred: boolean;
  updatedAt: number;
  // True while a turn is still streaming server-side (survives a page refresh).
  generating?: boolean;
  // The caller's role on this object — "owner" for their own chats, else the collaborator role
  // granted via the Share primitive. Present on the single-conversation read, absent on the list.
  access?: ConversationAccessRole;
  // Context-window usage (#38). Present on the single-conversation read; absent on the list.
  context?: ContextUsage;
}

// The caller's access role on a conversation: "owner" or one of the four collaborator tiers.
export type CollaboratorRole = "view" | "suggest" | "edit" | "prompt";
export type ConversationAccessRole = "owner" | CollaboratorRole;

// May the caller send a turn in this conversation? The owner always can; a collaborator can
// only when their granted role includes `prompt` — the Share primitive's collaborative-send
// tier (#46), which POST /chat authorizes server-side. Lower collaborator roles
// (view/suggest/edit) stay read + live-watch only (the primitive's floor), so the composer
// stays a read-only banner for them. `undefined` = an own/new/ghost thread (no shared access
// resolved). The server re-checks on every send, so this is only which control to show.
export function canPromptIn(access: ConversationAccessRole | undefined): boolean {
  return access === undefined || access === "owner" || access === "prompt";
}

// May the caller EDIT this conversation's content — today, tick a shared TODO checkbox (#131)?
// The owner always can; a collaborator only when their role includes `edit` (edit/prompt). Lower
// roles (view/suggest) keep checkboxes read-only. `undefined` = an own/new/ghost thread (owner).
// The server re-checks on every toggle, so this only decides whether to render an interactive box.
export function canEditContentIn(access: ConversationAccessRole | undefined): boolean {
  return access === undefined || access === "owner" || access === "edit" || access === "prompt";
}

// One regenerated alternative of an assistant answer (the original counts as one).
export interface ApiVariant {
  id: string;
  content: string;
  vote: number;
  model: string | null;
  // The variant's persisted model thinking (#68); null for a non-reasoning model's reply.
  reasoning?: string | null;
}

// Metadata for a file a user message carried into its turn (files-to-prompt, #128). Never the
// bytes — just enough to render a chip in the transcript. Mirrors the server's MessageAttachment.
export interface MessageAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

export interface ApiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  // The model's persisted thinking (#68) for an assistant reply; null/absent otherwise. Rendered
  // as a collapsed "Reasoning" section, kept out of `content` so the answer stays clean.
  reasoning?: string | null;
  model: string | null;
  vote: number;
  createdAt: number;
  // Present only on assistant answers that have been regenerated (>1 variant).
  variants?: ApiVariant[];
  activeIndex?: number;
  // Present only on user messages sent with attachments (files-to-prompt, #128).
  attachments?: MessageAttachment[];
}

export async function fetchMe(): Promise<Me | null> {
  // Send the session cookie too (account login), alongside any guest bearer token.
  const res = await fetch("/api/me", { headers: authHeaders(), credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/me -> ${res.status}`);
  return (await res.json()) as Me;
}

// ---------------------------------------------------------------------------
// Account auth (/api/auth/*, #169). Passkeys are the only account credential (email OTP + invites
// were removed); the passkey ceremonies live in ./webauthn.ts. Every call sends
// `credentials:"include"` so the httpOnly session cookie flows. Wire contracts: src/auth/routes.ts.
// ---------------------------------------------------------------------------

// End an account session (destroys it server-side + clears the cookie). Best-effort.
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Accounts admin (#169): the minimal management surface — list passkey accounts, revoke one (kick
// out + clear access), and set its plan. The invite + per-account guardrail settings were removed.
// Every response is the secret-free AccountListing. Admin-only at the route layer (`admin.accounts`).
// Wire contracts: src/admin/routes.ts + src/auth/account.service.ts. Date fields come back as epoch ms.
// ---------------------------------------------------------------------------

// One account as listed for the admin. Mirrors the server's AccountListing: `usageTokens` is the
// live usage meter, `lastSeenAt` the max session presence. No secrets, no guardrail settings.
export interface AccountRow {
  id: string;
  email: string | null; // legacy — null for a passkey account
  login: string;
  accessGrantedAt: number | null; // null = access revoked / never granted ("no access")
  plan: AccountPlanId; // subscription plan (#13)
  createdAt: number;
  usageTokens: number; // tokens spent (the live usage meter)
  lastSeenAt: number | null; // most recent session presence across the account's sessions
}

export async function listAccounts(): Promise<AccountRow[]> {
  const res = await fetch("/api/admin/accounts", { headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error(`/api/admin/accounts -> ${res.status}`);
  return ((await res.json()) as { accounts: AccountRow[] }).accounts;
}

// Revoke an account: clears its access AND kills every live session server-side (kicks it out
// immediately + walls it). The owner-only account reset lever (#169). Idempotent; unknown id → 404.
export async function revokeAccount(id: string): Promise<void> {
  const res = await fetch(`/api/admin/accounts/${id}/revoke`, {
    method: "POST",
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`revoke-account -> ${res.status}`);
}

// Admin: set an account's subscription plan (#13) — the manual counterpart of the billing
// webhook. Returns the refreshed account row. A bad plan is a 400; an unknown/non-account id 404.
export async function setAccountPlan(id: string, plan: AccountPlanId): Promise<AccountRow> {
  const res = await fetch(`/api/admin/accounts/${id}/plan`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    credentials: "include",
    body: JSON.stringify({ plan }),
  });
  const data = (await res.json().catch(() => ({}))) as { account?: AccountRow; error?: string };
  if (!res.ok) throw new Error(data.error ?? `set-account-plan -> ${res.status}`);
  return data.account!;
}

// Plans / billing (#13) stays as dormant server scaffolding (src/billing/, GET /api/billing) for a
// possible future hosted tier, but the OSS build has NO paywall (#166): the pricing/checkout UI and
// its API client are removed. Every account is `ultra` (the whole console), so there's nothing to
// upgrade. The admin plan control (`setAccountPlan`, above) is the only remaining plan surface.

export async function fetchModels(): Promise<{ models: string[]; labels: Record<string, string>; default: string }> {
  const res = await fetch("/api/models", { headers: authHeaders() });
  if (!res.ok) throw new Error(`/api/models -> ${res.status}`);
  return res.json() as Promise<{ models: string[]; labels: Record<string, string>; default: string }>;
}

// A model's IN modalities, the same union the server catalog uses (`src/models/types.ts`).
export type ModelModality = "text" | "image" | "audio" | "video" | "document";

// The subset of the enriched catalog (#63) the client reads. `input` drives the composer's attach
// gate (#136 — which modalities the active model reads); `tier`/`byokOnly`/`provider`/`recommendedFor`
// feed the richer picker (#17 — the $ tier badge, the BYOK tag, and search/filter facets). These all
// ride the SAME payload the server already returns (`MergedModel`), so widening this type reads more
// of the response, never a new request. Every field is OPTIONAL-safe on the picker side (a model with
// no catalog row degrades to conservative defaults), so the shape stays back-compatible.
export interface CatalogModel {
  id: string;
  displayName: string;
  input: ModelModality[];
  tier: AccountPlanId; // the plan rung this model sits behind (mirrors the server catalog `tier`)
  byokOnly: boolean; // only reachable via the caller's own key (never on the shared box)
  provider: string; // qwen | openai | anthropic | local | ... (search + display)
  recommendedFor: string[]; // coding | vision | long-docs | ... (search keywords)
}

// The enriched model catalog (GET /api/models/catalog), scoped server-side to the caller's
// allowed models. Carries per-model `input` modalities; a failure is the caller's to handle
// (the composer degrades to "attachments allowed" until it loads).
export async function fetchModelCatalog(): Promise<{ models: CatalogModel[]; default: string }> {
  const res = await fetch("/api/models/catalog", { headers: authHeaders() });
  if (!res.ok) throw new Error(`/api/models/catalog -> ${res.status}`);
  return res.json() as Promise<{ models: CatalogModel[]; default: string }>;
}

export async function fetchConversations(): Promise<ConversationMeta[]> {
  const res = await fetch("/api/conversations", { headers: authHeaders() });
  if (!res.ok) throw new Error(`/api/conversations -> ${res.status}`);
  const data = (await res.json()) as { conversations: ConversationMeta[] };
  return data.conversations;
}

// Returns null on 404 — the conversation isn't visible to THIS caller (deleted, or its
// id belongs to another user; every query is scoped `WHERE id=? AND user_id=<caller>`).
// The UI treats that as "go home" rather than stranding the user on a dead thread.
export async function fetchConversation(
  id: string,
): Promise<{ conversation: ConversationMeta; messages: ApiMessage[] } | null> {
  const res = await fetch(`/api/conversations/${id}`, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/conversations/${id} -> ${res.status}`);
  return res.json() as Promise<{ conversation: ConversationMeta; messages: ApiMessage[] }>;
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const res = await fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`rename -> ${res.status}`);
}

// (Re)generate a conversation's title from its first exchange — backs the "Generate
// title" menu action when the automatic post-turn titling didn't take. Returns the new
// title so the caller can swap it into the sidebar.
export async function generateConversationTitle(id: string): Promise<string> {
  const res = await fetch(`/api/conversations/${id}/title`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`title -> ${res.status}`);
  const data = (await res.json()) as { title?: string };
  return data.title ?? "";
}

export async function setConversationStarred(id: string, starred: boolean): Promise<void> {
  const res = await fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ starred }),
  });
  if (!res.ok) throw new Error(`star -> ${res.status}`);
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/conversations/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`delete -> ${res.status}`);
}

// Branch a conversation at a message into a new chat (#72) — fork the thread there, carrying the
// context up to that point into a fresh chat the caller owns. Resolves to the new conversation's
// meta (the caller navigates to it) or null on any rejection (an unknown/foreign conversation, a
// stale fork point, a network error) so the caller can show a brief failure notice instead of
// stranding the user. The server copies the active thread up to and including `messageId`.
export async function branchConversation(id: string, messageId: string): Promise<ConversationMeta | null> {
  const res = await fetch(`/api/conversations/${id}/branch`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ messageId }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { conversation?: ConversationMeta };
  return data.conversation ?? null;
}

// Tick/untick a TODO checkbox on a message in the caller's own (or a collaborated) conversation
// (#131) — the owner-side counterpart of the public share toggle. Authorized by the normal auth
// gate + the caller's role on the conversation (owner / edit / prompt). Resolves to the server's
// authoritative message content on success, or null on any rejection (403/404/network) so the
// caller reverts its optimistic update. The 0-based `index` is the checkbox ordinal within the message.
export async function toggleConversationTodo(
  conversationId: string,
  messageId: string,
  index: number,
  done: boolean,
): Promise<string | null> {
  const res = await fetch(`/api/conversations/${conversationId}/todo`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ messageId, index, done }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { content?: string };
  return data.content ?? null;
}

// Compact a conversation (#38): fold its older turns into the rolling summary so the thread fits the
// active model's context window — WITHOUT deleting a message (the transcript stays intact; the server
// only stamps a boundary the model prompt reads). Owner-only server-side. Resolves to the new
// context snapshot (so the composer meter + nudge update in place) or null on any rejection (a short
// thread's 422, a summarizer 502, a 404, a network error) so the caller can leave the UI untouched.
export async function compactConversation(
  id: string,
): Promise<{ foldedCount: number; context: ContextUsage } | null> {
  const res = await fetch(`/api/conversations/${id}/compact`, {
    method: "POST",
    headers: authHeaders(),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { foldedCount?: number; context?: ContextUsage };
  if (!data.context) return null;
  return { foldedCount: data.foldedCount ?? 0, context: data.context };
}

// Archivist: conversation recap on return (#37), "where you left off". The structured recap the
// server returns ONLY when the open conversation is stale (>=24h since its last message) and
// substantial (>=4 messages) and hasn't been dismissed; otherwise the field is null and no card
// renders. Derived from the conversation's own messages + rolling summary (never durable memory),
// so it reads identically for the owner and a collaborator.
export interface Recap {
  topic: string;
  progress: string[];
  whereItEnded: string;
  nextStep?: string;
}

// The recap to show for a conversation, or null when there's nothing to show (ineligible, already
// dismissed, or the model degraded). Best-effort: any error (incl. a 404 for a stranger's/unknown
// id) resolves to null so the thread always renders normally.
export async function fetchRecap(id: string): Promise<Recap | null> {
  const res = await fetch(`/api/conversations/${id}/recap`, { headers: authHeaders() }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { recap?: Recap | null };
  return data.recap ?? null;
}

// Force-generate the recap for a conversation on demand (the `/recap` command, #37). Hits the same
// GET endpoint + auth as fetchRecap with `?force=1`, which bypasses ONLY the 24h staleness gate
// server-side (never the auth/owner-memory scoping). Returns null when the thread is too thin to
// recap or the model degraded - the caller surfaces a subtle "nothing to recap yet" note, not an
// error. A 404 (stranger/unknown id) also resolves to null.
export async function forceRecap(id: string): Promise<Recap | null> {
  const res = await fetch(`/api/conversations/${id}/recap?force=1`, { headers: authHeaders() }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { recap?: Recap | null };
  return data.recap ?? null;
}

// Dismiss the recap for a conversation's current last message; remembered server-side until new
// activity mints a fresh one. Best-effort (the card hides optimistically regardless).
export async function dismissRecap(id: string): Promise<void> {
  await fetch(`/api/conversations/${id}/recap/dismiss`, { method: "POST", headers: authHeaders() }).catch(() => {});
}

// Account-synced UI preferences. Persisting them server-side is what propagates a
// choice to the user's other instances (each reads it back from /api/me on load). The
// `preferences` bag (#11) is merged + normalized server-side, so a partial is safe.
export async function saveSettings(patch: { theme?: string; lang?: string; preferences?: Preferences }): Promise<void> {
  await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(patch),
  });
}

// Why setting a handle failed (#189), in a form the UI can localize. Mirrors the server's typed
// error: charset/length are a 400, a name collision (`taken`) a 409. The server is authoritative —
// these client-side messages are only UX.
export type HandleError = "charset" | "length" | "taken" | "error";

// Set (or change) the caller's public handle. Resolves to the server-normalized (lowercased) handle
// on success, or a typed reason the UI maps to a friendly message. Scoped server-side to the caller.
export async function setHandle(handle: string): Promise<{ ok: true; handle: string } | { ok: false; error: HandleError }> {
  const res = await fetch("/api/settings/handle", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    credentials: "include",
    body: JSON.stringify({ handle }),
  }).catch(() => null);
  if (!res) return { ok: false, error: "error" };
  const data = (await res.json().catch(() => ({}))) as { handle?: string; error?: string };
  if (res.ok && typeof data.handle === "string") return { ok: true, handle: data.handle };
  if (data.error === "charset" || data.error === "length" || data.error === "taken") {
    return { ok: false, error: data.error };
  }
  return { ok: false, error: "error" };
}

// ---------------------------------------------------------------------------
// User directory (#190). "Find each other on this instance": any authenticated caller can browse the
// accounts that opted in by setting a handle (#189), optionally searching over handle + display name.
// The server returns ONLY public identity fields (id + handle + display name) — never email, the
// synthetic acct_<uuid> login, plan, or any private data. Feeds the collaboration invite picker
// (#177). Wire contract: GET /api/users (+ ?q=) in src/server.ts / src/settings/directory.ts.
// ---------------------------------------------------------------------------

// One directory row — the caller only ever sees these three public fields. `id` is the stable user
// id (what an invite binds to), `handle` the opted-in public handle, `name` the public display name
// (the user's display name if set, else their handle — never an email/login).
export interface DirectoryUser {
  id: string;
  handle: string;
  name: string;
}

// Browse the instance directory, optionally filtered by a handle/name search. Results are bounded
// server-side (search + a hard cap) and exclude the caller. A blank query lists everyone (capped).
export async function fetchDirectory(q?: string): Promise<DirectoryUser[]> {
  const qs = q && q.trim().length > 0 ? `?q=${encodeURIComponent(q.trim())}` : "";
  const res = await fetch(`/api/users${qs}`, { headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error(`/api/users -> ${res.status}`);
  return ((await res.json()) as { users: DirectoryUser[] }).users;
}

// ---------------------------------------------------------------------------
// Shareable-live-collab. Owner-side share management (gated) + the public, no-login watch
// read. A conversation is private until the owner opts in; the share endpoint returns a
// stable `/s/{slug}` link anyone can watch build live. Unsharing kills the link.
// ---------------------------------------------------------------------------

export interface ShareInfo {
  shared: boolean;
  slug: string | null;
  url: string | null;
}

// Current share status for a conversation the caller owns.
export async function getShare(conversationId: string): Promise<ShareInfo> {
  const res = await fetch(`/api/conversations/${conversationId}/share`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`get-share -> ${res.status}`);
  return (await res.json()) as ShareInfo;
}

// Opt in to sharing (idempotent — returns the same stable link on repeat).
export async function createShare(conversationId: string): Promise<ShareInfo> {
  const res = await fetch(`/api/conversations/${conversationId}/share`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(`create-share -> ${res.status}`);
  return (await res.json()) as ShareInfo;
}

// Stop sharing — the old link dies immediately.
export async function deleteShare(conversationId: string): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}/share`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`delete-share -> ${res.status}`);
}

// One message in the public watch snapshot — read-only, no owner identity or votes.
export interface SharedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model: string | null;
  createdAt: number;
}

export interface SharedConversation {
  conversation: { id: string; title: string | null };
  messages: SharedMessage[];
  // A temporary, write-scoped token minted with the snapshot (#45). It authorizes the one
  // write the public page allows — ticking a TODO checkbox — and expires; the page refreshes
  // it on each snapshot poll. Absent only from older responses (treated as "can't toggle").
  writeToken?: string | null;
  writeTokenExpiresAt?: number;
}

// The public, no-login snapshot of a shared conversation. No auth headers — the slug is the
// capability. Returns null on 404 (unknown/revoked link) so the watch page shows "not found"
// rather than throwing.
export async function fetchSharedConversation(slug: string): Promise<SharedConversation | null> {
  const res = await fetch(`/api/share/${encodeURIComponent(slug)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/share/${slug} -> ${res.status}`);
  return (await res.json()) as SharedConversation;
}

// Tick/untick a TODO checkbox on a shared page (#45). The write token (from the snapshot) is
// the capability — sent in a custom header, never a cookie, so there's no ambient-credential
// (CSRF) surface. Resolves to the server's authoritative message content on success, or null
// on any rejection (missing/expired token, rate limit, revoked link) so the caller reverts its
// optimistic update and lets the next poll reconcile.
export async function toggleSharedTodo(
  slug: string,
  writeToken: string,
  messageId: string,
  index: number,
  done: boolean,
): Promise<string | null> {
  const res = await fetch(`/api/share/${encodeURIComponent(slug)}/todo`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-a7t-share-write": writeToken },
    body: JSON.stringify({ messageId, index, done }),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { content?: string };
  return data.content ?? null;
}

// ---------------------------------------------------------------------------
// Share PRIMITIVE — identity-bound collaboration. Distinct from the public watch link above:
// the owner invites a SPECIFIC account (by its public handle, #189) to collaborate on the SAME
// conversation, and it surfaces in the invitee's own app ("shared with me"). A revocable grant,
// never a link.
// Wire contracts: src/chat/collaborators.ts + the /api/conversations/:id/collaborators routes.
// ---------------------------------------------------------------------------

// One collaborator on a conversation the caller owns (the owner's "manage people" view). Carries
// the invitee's public handle (#189) + display name — the identity the owner invited them by —
// but NEVER an email (passkey accounts have none; collaboration is handle-bound, not email-bound).
export interface Collaborator {
  userId: string;
  handle: string | null;
  displayName: string | null;
  role: CollaboratorRole;
  createdAt: number;
}

// A conversation shared WITH the caller — the invitee's "shared with me" row. Carries the
// owner's display name + the caller's role, never the owner's email or other accounts.
export interface SharedConversationMeta {
  id: string;
  title: string | null;
  model: string | null;
  updatedAt: number;
  role: CollaboratorRole;
  ownerName: string;
  generating?: boolean;
}

// The collaborators the caller has invited to a conversation they own.
export async function listCollaborators(conversationId: string): Promise<Collaborator[]> {
  const res = await fetch(`/api/conversations/${conversationId}/collaborators`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`list-collaborators -> ${res.status}`);
  return ((await res.json()) as { collaborators: Collaborator[] }).collaborators;
}

// Why an invite failed, in a form the UI can localize. `error` is a transport/unknown failure.
export type InviteFailure = "no_account" | "self" | "error";

// Invite an existing account (by its public handle, #189) at a role. Resolves to ok, or a typed
// reason the UI maps to a friendly message (no account with that handle / you already own this /
// generic). Resolving by handle (not email) is what lets passkey accounts be invited (#177).
export async function inviteCollaborator(
  conversationId: string,
  handle: string,
  role: CollaboratorRole,
): Promise<{ ok: true; collaborator: { userId: string; role: CollaboratorRole } } | { ok: false; reason: InviteFailure }> {
  const res = await fetch(`/api/conversations/${conversationId}/collaborators`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ handle, role }),
  });
  if (res.ok) {
    const data = (await res.json()) as { collaborator: { userId: string; role: CollaboratorRole } };
    return { ok: true, collaborator: data.collaborator };
  }
  const data = (await res.json().catch(() => ({}))) as { reason?: string };
  if (data.reason === "no_account" || data.reason === "self") return { ok: false, reason: data.reason };
  return { ok: false, reason: "error" };
}

// Change a collaborator's role (owner-only).
export async function updateCollaboratorRole(conversationId: string, userId: string, role: CollaboratorRole): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}/collaborators/${userId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(`update-collaborator -> ${res.status}`);
}

// Revoke a collaborator (owner-only) — their access dies on the next request.
export async function removeCollaborator(conversationId: string, userId: string): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}/collaborators/${userId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`remove-collaborator -> ${res.status}`);
}

// Conversations shared WITH the caller (the "shared with me" list in their own app).
export async function fetchSharedConversations(): Promise<SharedConversationMeta[]> {
  const res = await fetch("/api/shared-conversations", { headers: authHeaders() });
  if (!res.ok) throw new Error(`/api/shared-conversations -> ${res.status}`);
  return ((await res.json()) as { conversations: SharedConversationMeta[] }).conversations;
}

// ---------------------------------------------------------------------------
// Attachments / file manager (#15). Per-account uploaded files: list / upload / download / delete.
// The bytes live server-side (local storage today, cloud later); these helpers move only metadata
// plus the raw upload. Every call is scoped to the caller server-side. Wire: src/files/routes.ts.
// ---------------------------------------------------------------------------

export interface FileMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number; // epoch ms
}

export interface FilesListing {
  files: FileMeta[];
  usage: { count: number; totalBytes: number };
  limits: { maxFileBytes: number; maxTotalBytes: number; maxCount: number };
}

export async function listFiles(): Promise<FilesListing> {
  const res = await fetch("/api/files", { headers: authHeaders() });
  if (!res.ok) throw new Error(`/api/files -> ${res.status}`);
  return (await res.json()) as FilesListing;
}

// Why an upload failed, in a form the UI can localize. The server enforces the real limits — this
// is UX, not the guard: `too_large` (over the per-file cap) and `quota` (per-account footprint/count)
// both arrive as a 413 distinguished by the error message; anything else is a generic failure.
export type UploadResult = { ok: true; file: FileMeta } | { ok: false; reason: "too_large" | "quota" | "error" };

export async function uploadFile(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/files", { method: "POST", headers: authHeaders(), body: form });
  if (res.ok) {
    const data = (await res.json()) as { file: FileMeta };
    return { ok: true, file: data.file };
  }
  if (res.status === 413) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, reason: data.error?.includes("quota") ? "quota" : "too_large" };
  }
  return { ok: false, reason: "error" };
}

export async function deleteFile(id: string): Promise<void> {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`delete-file -> ${res.status}`);
}

// The direct URL for downloading a stored file. The browser navigates to it (an <a download>), so
// the ambient credential — the account's session cookie, or the admin's Tailscale header injected
// at the origin — authenticates it; the server serves it as a forced attachment.
export function fileDownloadUrl(id: string): string {
  return `/api/files/${encodeURIComponent(id)}`;
}

// ---- Archivist memory (#27) ------------------------------------------------
// A durable fact a7t.chat remembers about the caller (createdAt = when it was learned).
export interface RememberedFact {
  id: string;
  content: string;
  createdAt: string;
}
export interface MemoryListing {
  enabled: boolean;
  facts: RememberedFact[];
}

export async function listMemory(): Promise<MemoryListing> {
  const res = await fetch("/api/memory", { headers: authHeaders() });
  if (!res.ok) throw new Error(`/api/memory -> ${res.status}`);
  return (await res.json()) as MemoryListing;
}

// Forget one remembered fact. A 404 (already gone / not the caller's) is treated as success —
// the fact is not there, which is the caller's intent.
export async function forgetFact(id: string): Promise<void> {
  const res = await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok && res.status !== 404) throw new Error(`forget-fact -> ${res.status}`);
}

// Forget everything a7t.chat has learned (facts + summaries + embeddings). Returns how many facts
// were cleared, for the UI to confirm.
export async function forgetAllMemory(): Promise<number> {
  const res = await fetch("/api/memory", { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(`forget-all-memory -> ${res.status}`);
  return ((await res.json()) as { cleared?: number }).cleared ?? 0;
}

// ---------------------------------------------------------------------------
// Bring-your-own-key (#14). Per-account frontier-provider API keys: list the catalog + the caller's
// configured (masked) keys, store/replace one, remove one. The plaintext key leaves the browser only
// on `setByokKey` and is NEVER returned — every read is masked to `provider` + `last4`. The whole
// surface is scoped to the caller server-side and walled by the `byok` entitlement (a 402 for a
// non-entitled caller). Wire contracts: src/byok/routes.ts.
// ---------------------------------------------------------------------------

// One provider the BYOK catalog offers: its id, display label, and the placeholder key hint.
export interface ByokProvider {
  id: string;
  label: string;
  keyHint: string;
}

// A configured key as the client ever sees it — the provider + a masking hint, NEVER the secret.
export interface ByokKey {
  provider: string;
  last4: string;
  updatedAt: string; // ISO timestamp (the server's Date, JSON-serialized)
}

// The caller's BYOK state: whether the server has it configured (an encryption key is set), the
// provider catalog to offer, and the caller's own already-configured keys (masked).
export interface ByokListing {
  available: boolean;
  providers: ByokProvider[];
  keys: ByokKey[];
}

export async function listByok(): Promise<ByokListing> {
  const res = await fetch("/api/byok", { headers: authHeaders(), credentials: "include" });
  if (!res.ok) throw new Error(`/api/byok -> ${res.status}`);
  return (await res.json()) as ByokListing;
}

// Store (or replace) the caller's key for a provider. The plaintext leaves the browser here and
// never comes back — the response is the masked view (provider + last4). A bad key/provider is a
// 400, a server without BYOK configured a 503; both surface as a thrown error the panel localizes.
export async function setByokKey(provider: string, key: string): Promise<ByokKey> {
  const res = await fetch(`/api/byok/${encodeURIComponent(provider)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    credentials: "include",
    body: JSON.stringify({ key }),
  });
  const data = (await res.json().catch(() => ({}))) as { key?: ByokKey; error?: string };
  if (!res.ok) throw new Error(data.error ?? `set-byok-key -> ${res.status}`);
  return data.key!;
}

// Remove the caller's key for a provider. Idempotent server-side (removing an absent key is `ok`).
export async function deleteByokKey(provider: string): Promise<void> {
  const res = await fetch(`/api/byok/${encodeURIComponent(provider)}`, {
    method: "DELETE",
    headers: authHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`delete-byok-key -> ${res.status}`);
}

export async function transcribe(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", blob, "audio.webm");
  const res = await fetch("/api/transcribe", { method: "POST", headers: authHeaders(), body: form });
  if (!res.ok) throw new Error(`transcribe -> ${res.status}`);
  const data = (await res.json()) as { text?: string };
  return data.text ?? "";
}

export async function voteMessage(id: string, vote: number): Promise<void> {
  await fetch(`/api/messages/${id}/vote`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ vote }),
  });
}

// Mark a regenerated variant as the active one (persists the comparison choice).
export async function selectVariant(id: string): Promise<void> {
  await fetch(`/api/messages/${id}/select`, { method: "POST", headers: authHeaders() });
}

// Stop the in-progress turn for a conversation (the Stop button). The turn runs
// server-side independent of this client, so aborting the local stream alone won't
// halt it — this is what actually cancels the generation.
export async function cancelGeneration(id: string): Promise<void> {
  await fetch(`/api/conversations/${id}/stop`, { method: "POST", headers: authHeaders() });
}


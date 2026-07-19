import { sql } from "drizzle-orm";
import { blob, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Drizzle schema — SQLite today, Postgres-portable later (the product seam).
// Memory is intentionally TWO-TIER:
//   - messages   = RAW verbatim source of truth (lossless, never compacted away)
//   - facts/summaries = DERIVED, compacted working memory (injected into context)
//   - memory_chunks   = units to embed for v1.1 semantic recall (sqlite-vec)

const pk = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () => ts("created_at").notNull().$defaultFn(() => new Date());

// A person behind one or more keys. admin = Tailscale identity; guest = generated.
export const users = sqliteTable(
  "users",
  {
  id: pk(),
  login: text("login").notNull().unique(), // tailscale login (admin) or account slug
  // User-chosen, unique, CHANGEABLE public handle (#189) — the human identity a passkey account gets
  // on top of its synthetic `acct_<uuid>` login (which is never shown). Nullable: stays null until the
  // user sets one, so every existing row keeps working. Stored lowercased + charset/length-bounded by
  // src/settings/handle.ts. Uniqueness is CASE-INSENSITIVE — enforced by the `lower(handle)` unique
  // index below AND by always writing the canonical lowercase form; SQLite lets the many null-handle
  // rows coexist (NULLs never collide in a unique index). The foundation for the user directory (#190)
  // and identity-bound collaboration invites (#177).
  handle: text("handle"),
  displayName: text("display_name"),
  // admin = Tailscale owner · account = passkey sign-up (#169). `guest` is a LEGACY enum member: no
  // longer produced (the guest-key/Bearer path was retired), kept only so pre-existing guest rows
  // stay readable. Default stays `guest` for schema/DB parity (a table rebuild to flip it would trip
  // SQLite's add-column-during-rebuild footgun); it is moot anyway — every code path sets `role`
  // explicitly (admin/account).
  role: text("role", { enum: ["admin", "guest", "account"] }).notNull().default("guest"),
  // LEGACY email columns. Email OTP login was removed (#169) — accounts now sign up with a passkey and
  // carry no email — but the columns are LEFT IN PLACE (nullable, unique) so pre-existing rows that
  // linked an email stay readable. Nothing writes them anymore.
  email: text("email").unique(),
  emailVerifiedAt: ts("email_verified_at"),
  // Set the moment access is granted — passkey sign-up stamps it to now() directly (no invite step
  // anymore). null = a legacy never-granted row; the gate keys off it (see auth/middleware.ts).
  accessGrantedAt: ts("access_granted_at"),
  // Per-account guardrails. The invite/admin machinery that used to SET these was removed (#169), so
  // for a passkey account they stay null and the chat path resolves them to the config.freeTier
  // defaults at read time. Kept on the row (not dropped) so any legacy snapshotted value still
  // applies, and so a future admin tool could re-introduce per-account bounds without a migration.
  // null = "fall back to the freeTier default" (so an account is NEVER unbounded like admin).
  modelAllowlist: text("model_allowlist"), // CSV/JSON of allowed model ids; null = freeTier default
  tokenBudget: integer("token_budget"), // total token cap (summed from usage_events); null = freeTier default
  maxConcurrency: integer("max_concurrency"), // in-flight generations; null = freeTier default
  // Legacy account "top-up" lever (usage summed from usage_events only from this instant onward).
  // The admin reset tool was removed (#169); null = count from the beginning of time.
  usageResetAt: ts("usage_reset_at"),
  theme: text("theme"), // account-synced UI theme id (null = client default)
  lang: text("lang"), // account-synced UI language (null = client default 'en')
  // Account-synced customization (persona + behavior + visual + accessibility), a single JSON
  // blob normalized/bounded by src/settings/preferences.ts. null = client defaults. Scoped to
  // the account today; moves onto the active profile when Profiles (#34) land. (#11)
  preferences: text("preferences"),
  // Subscription plan — the ladder is kept as inert scaffolding for a possible future hosted tier
  // (#13: `free` → `plus` → `pro` → `ultra`), but the OSS build has NO paywall (#166): every account
  // defaults to `ultra`, the top rung that unlocks the whole console. The entitlement seam still
  // derives premium access from this column (see src/entitlements/plans.ts), so the machinery stays
  // live — it just resolves to "everything" for everyone. Admins are the owner tier ("owner"), ABOVE
  // this ladder. A legacy/unknown value also degrades to `ultra` at read (accountPlanOf).
  plan: text("plan", { enum: ["free", "plus", "pro", "ultra"] }).notNull().default("ultra"),
  createdAt: createdAt(),
  },
  (t) => ({
    // CASE-INSENSITIVE unique handle (#189): one identity per handle regardless of case, indexed on
    // lower(handle) so "Leo" and "leo" are the same claim. NULL handles never collide in a SQLite
    // unique index, so all the legacy null-handle rows coexist without a partial-index clause.
    byHandle: uniqueIndex("users_handle_idx").on(sql`lower(${t.handle})`),
  }),
);

// Web sessions — the cookie's opaque token, hashed at rest (only the hash is stored;
// the raw token lives in the httpOnly cookie). Expiry is enforced on every validate;
// lastSeenAt is bumped so we can show/active-prune idle sessions.
export const sessions = sqliteTable(
  "sessions",
  {
    id: pk(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(), // SHA-256 hex of the session token
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => ({ byUser: index("sessions_user_idx").on(t.userId) }),
);

// WebAuthn passkey sign-in (#20) — phishing-resistant, passwordless credentials layered on top
// of email OTP login. A passkey is a public keypair the authenticator (Touch ID / Windows Hello /
// a security key) holds; we store ONLY the PUBLIC key (never a secret), scoped to the owning
// account. Login resolves the account from the credential id, then verifies an assertion signed by
// the private key that never leaves the device. The feature is DARK unless WEBAUTHN_RP_ID is
// configured (see src/auth/webauthn/config.ts). Rows cascade-delete with the account.
export const webauthnCredentials = sqliteTable(
  "webauthn_credentials",
  {
    id: pk(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // The credential id the authenticator returns, base64url. GLOBALLY unique: one credential
    // belongs to exactly one account, and passkey login resolves the account by this id.
    credentialId: text("credential_id").notNull().unique(),
    // The credential's PUBLIC key as a JWK JSON string (EC2 P-256 / ES256). NEVER a secret — a
    // public key can only VERIFY assertions, so storing it in the clear is safe by design.
    publicKey: text("public_key").notNull(),
    // Signature counter — the clone-detection signal. Enforced monotonic when non-zero; platform
    // passkeys (Touch ID/iCloud Keychain) legitimately report 0 forever, so 0↔0 is accepted.
    signCount: integer("sign_count").notNull().default(0),
    transports: text("transports"), // JSON array hint (usb/nfc/ble/internal); untrusted, display only
    label: text("label"), // friendly name for the manager UI ("MacBook Touch ID")
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at"), // bumped on each successful assertion
  },
  (t) => ({ byUser: index("webauthn_credentials_user_idx").on(t.userId) }),
);

// Short-lived, SINGLE-USE WebAuthn ceremony challenges (register + authenticate). The random
// challenge is the replay defense — the authenticator signs it, and we consume the row on use, so
// an assertion can never be replayed (crucial for platform passkeys whose sign counter stays 0).
// `userId` is set for a registration ceremony (bound to the logged-in account) and null for
// authentication (usernameless / discoverable credentials). `ip` bounds per-IP ceremony starts.
// Rows expire fast and are pruned on each create; a null-user row survives its owner's deletion by
// design (it's anonymous) but still expires.
export const webauthnChallenges = sqliteTable(
  "webauthn_challenges",
  {
    id: pk(),
    challenge: text("challenge").notNull().unique(), // base64url random nonce (the signed value)
    purpose: text("purpose", { enum: ["register", "authenticate"] }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    ip: text("ip"), // trusted client IP at ceremony start (per-IP rate limiting)
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    byExpires: index("webauthn_challenges_expires_idx").on(t.expiresAt),
    byIp: index("webauthn_challenges_ip_idx").on(t.ip),
  }),
);

// A credential. DORMANT (legacy): the guest-key/Bearer auth path was retired — invites now
// carry the guardrails (model allowlist / budget / concurrency / expiry), snapshotted onto the
// account at redemption. Nothing mints keys or authenticates via Bearer anymore. The table is
// LEFT IN PLACE (not dropped) so historical rows + usage_events.key_id references stay intact.
export const keys = sqliteTable(
  "keys",
  {
    id: pk(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(), // SHA-256 of the opaque token
    tokenBudget: integer("token_budget"), // null = unlimited
    tokensUsed: integer("tokens_used").notNull().default(0),
    modelAllowlist: text("model_allowlist", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`), // enforced in the app, NOT in Jano
    maxConcurrency: integer("max_concurrency").notNull().default(1), // 1 in-flight gen/key
    expiresAt: ts("expires_at"), // null = no expiry
    revokedAt: ts("revoked_at"), // revocation = one row update
    lastUsedAt: ts("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => ({ byUser: index("keys_user_idx").on(t.userId) }),
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: pk(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    model: text("model"), // current model for this conversation (/model switches it)
    starred: integer("starred", { mode: "boolean" }).notNull().default(false), // favorited (pinned in the sidebar)
    // Compaction boundary (#38): the id of the last message FOLDED into the rolling summary. When
    // set, building the model prompt drops every turn up to and including this one and leans on the
    // conversation summary to represent them — a CONTEXT-WINDOW construct that keeps the transcript
    // (the `messages` rows) fully intact (compaction never deletes a message). null = never
    // compacted; a later compaction moves it forward. Deliberately NOT a foreign key: it names a
    // message that still exists (messages are never individually deleted, only via the conversation
    // cascade), and a stale/absent id degrades fail-safe to "send the whole thread" (svc.history).
    compactedThroughMessageId: text("compacted_through_message_id"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({ byUser: index("conversations_user_idx").on(t.userId) }),
);

// Shareable-live-collab primitive. A conversation is PRIVATE to its owner by default; a
// share is the explicit, opt-in grant that makes it watchable by anyone holding the link —
// the no-login "watch it build in real time" wedge, and the substrate both share modes and
// recipes ride on. The `slug` is an unguessable, public URL token (NOT a secret — it's the
// capability itself, deliberately re-displayable to the owner so they can copy the link
// again). Unsharing DELETES the row, so a revoked link dies immediately (the slug is gone).
// At most one active share per conversation (unique conversationId) — re-sharing after an
// unshare mints a fresh slug, never resurrecting the old one.
export const shares = sqliteTable(
  "shares",
  {
    id: pk(),
    conversationId: text("conversation_id")
      .notNull()
      .unique()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), // the owner who shared
    slug: text("slug").notNull().unique(), // public, unguessable URL token (read-only watch link)
    createdAt: createdAt(),
  },
  (t) => ({ bySlug: index("shares_slug_idx").on(t.slug) }),
);

// Share primitive — the IDENTITY-BOUND collaboration grant (distinct from `shares`, which is
// the public, no-login, link-based PUBLISH primitive). A collaborator row is an explicit,
// revocable grant that lets ANOTHER authenticated user reach the SAME private conversation as
// the owner — it surfaces in the invitee's own app and is keyed to their account, never a
// link. The pair (conversationId, userId) is unique: one grant per (conversation, person),
// re-inviting updates the role in place. `role` is the permission tier — today `view`
// (read + watch live) is the wired path; `suggest`/`edit`/`prompt` are reserved for the
// collaborative-chat layer (#46) that builds on this primitive. `invitedBy` records the owner
// who granted it (set-null if that account is ever deleted). Both the conversation and the
// collaborator user cascade-delete, so a removed conversation or account drops its grants.
export const conversationCollaborators = sqliteTable(
  "conversation_collaborators",
  {
    id: pk(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id") // the invited collaborator (identity-bound grant)
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["view", "suggest", "edit", "prompt"] }).notNull().default("view"),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }), // the owner who shared
    createdAt: createdAt(),
  },
  (t) => ({
    // One grant per (conversation, person) — re-inviting updates the role, never duplicates.
    byPair: uniqueIndex("conversation_collaborators_pair_idx").on(t.conversationId, t.userId),
    byConversation: index("conversation_collaborators_conversation_idx").on(t.conversationId),
    byUser: index("conversation_collaborators_user_idx").on(t.userId), // "shared with me" lookup
  }),
);

// Bring-your-own-key (BYOK, #14) — a paid account's own frontier-provider API key, stored
// ENCRYPTED at rest so a turn can run on the user's own key/cost instead of the shared local
// router. One row per (user, provider); re-setting a provider updates it in place. The secret is
// NEVER stored in plaintext: `ciphertext` is an AES-256-GCM package (see src/byok/crypto.ts),
// decryptable only with the server's BYOK_ENCRYPTION_KEY. `last4` is a non-sensitive display hint
// (the key's last 4 chars) so the UI can show "sk-…abcd" without ever surfacing the key. The row
// cascade-deletes with the account. Storing is gated by the `byok` entitlement (paywall).
export const providerKeys = sqliteTable(
  "provider_keys",
  {
    id: pk(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // a fixed id from the BYOK provider catalog (never a URL)
    ciphertext: text("ciphertext").notNull(), // AES-256-GCM package (iv.tag.ct, base64) — never plaintext
    last4: text("last4").notNull(), // masked display hint (the key's last 4 chars)
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({
    // One key per (user, provider) — re-setting a provider's key updates the row, never duplicates.
    byUserProvider: uniqueIndex("provider_keys_user_provider_idx").on(t.userId, t.provider),
  }),
);

// Attachments / file manager (#15) — per-user uploaded files. Each row is ONE file an account
// uploaded, scoped to that user (userId, cascade-deleted with the account). The BYTES live on a
// pluggable storage backend (local disk today, cloud later — see src/files/storage.ts); the row
// keeps only metadata plus the backend-relative `storageKey`. The key is SERVER-generated
// (`<userId>/<id>`, both UUIDs), never derived from the user's filename, so there is no
// path-traversal surface. `filename` is the sanitized DISPLAY name (kept for download);
// `contentType` is a bounded, UNTRUSTED MIME hint — downloads are always served as an attachment
// with nosniff, so an HTML/SVG upload can never render inline on the app origin. Deleting a row
// also unlinks its bytes (the service layer).
export const files = sqliteTable(
  "files",
  {
    id: pk(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(), // sanitized display name (never used as a path)
    contentType: text("content_type").notNull(), // bounded MIME hint; untrusted, served as attachment
    size: integer("size").notNull(), // byte length on the storage backend
    storageKey: text("storage_key").notNull().unique(), // backend-relative key, server-generated (`<userId>/<id>`)
    createdAt: createdAt(),
  },
  (t) => ({ byUser: index("files_user_idx").on(t.userId) }),
);

// RAW verbatim log — the source of truth. Never compress-and-discard.
export const messages = sqliteTable(
  "messages",
  {
    id: pk(),
    conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }), // scoping
    role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    // The model's thinking / chain-of-thought for an assistant reply (#68), peeled out of the
    // answer stream (a `reasoning_content` channel or inline <think>…</think>). Rendered in a
    // collapsed "Reasoning" section, kept OUT of `content` so the answer stays clean. null for
    // user messages and for replies from a non-reasoning model (graceful degradation → no section).
    reasoning: text("reasoning"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    vote: integer("vote").notNull().default(0), // -1 down, 0 none, 1 up
    // Regeneration variants ("retry an answer"): a regenerated assistant reply is a
    // SIBLING of the original — same slot, different content. variantOf points at the
    // root (original) message's id; the root and plain messages keep null. Exactly one
    // variant per slot is active (the selected one — used in history + shown in the UI).
    variantOf: text("variant_of"),
    variantActive: integer("variant_active", { mode: "boolean" }).notNull().default(true),
    // files-to-prompt (#128): the attachments a user message carried into its turn — a JSON array
    // of `{id,name,contentType,size}` metadata (NEVER the bytes), so the transcript can show what
    // was attached after a reload. null for messages sent without attachments (and every assistant
    // reply). The actual file text is inlined into the model context at send time, not stored here.
    attachments: text("attachments"),
    createdAt: createdAt(),
  },
  (t) => ({
    byConversation: index("messages_conversation_idx").on(t.conversationId),
    byUser: index("messages_user_idx").on(t.userId),
    byVariant: index("messages_variant_idx").on(t.variantOf),
  }),
);

// DERIVED tier: extracted structured facts (high-signal, re-derivable, injected).
export const facts = sqliteTable(
  "facts",
  {
    id: pk(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    sourceMessageId: text("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    confidence: real("confidence"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({ byUser: index("facts_user_idx").on(t.userId) }),
);

// DERIVED tier: rolling summary, per-user or per-conversation.
export const summaries = sqliteTable(
  "summaries",
  {
    id: pk(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["user", "conversation"] }).notNull(),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (t) => ({ byUser: index("summaries_user_idx").on(t.userId) }),
);

// Archivist recap cache (#37): the "where you left off" surface. ONE cached recap per
// conversation, keyed to the id of the conversation's LAST message: when the last-message id
// moves on (a new turn, a regeneration), the cache is stale and the recap is regenerated once.
// `payload` is the structured recap as JSON ({ topic, progress[], whereItEnded, nextStep? }):
// DERIVED and re-derivable from the conversation's own messages + its rolling summary, so it is
// safe to drop and rebuild anytime, and it never carries the owner's durable memory. It is
// CONVERSATION-scoped (not per-user): it reads identically for the owner and any collaborator,
// so the `dismissed` flag is remembered per conversation too (reset when new activity mints a
// fresh recap). Cascade-deletes with the conversation.
export const conversationRecaps = sqliteTable("conversation_recaps", {
  id: pk(),
  conversationId: text("conversation_id")
    .notNull()
    .unique()
    .references(() => conversations.id, { onDelete: "cascade" }),
  lastMessageId: text("last_message_id").notNull(), // cache key: the conversation's last message at generation time
  payload: text("payload").notNull(), // JSON: { topic, progress[], whereItEnded, nextStep? }
  dismissed: integer("dismissed", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().$defaultFn(() => new Date()),
});

// Units to embed for semantic recall (v1.1). The sqlite-vec vec0 ANN index is added
// alongside the recall iteration once the embed service is up.
export const memoryChunks = sqliteTable(
  "memory_chunks",
  {
    id: pk(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    embedding: blob("embedding"), // F32 bytes; null until embedded
    embeddingModel: text("embedding_model"),
    embeddedAt: ts("embedded_at"),
    createdAt: createdAt(),
  },
  (t) => ({ byUser: index("memory_chunks_user_idx").on(t.userId) }),
);

// Geocoding cache for the maps capability: place query -> coordinates. The cache is the
// cost control — a repeated place is resolved without ever re-hitting Nominatim. `query`
// is the lowercased lookup string (primary key); bbox is JSON [s,n,w,e] or null.
export const geocache = sqliteTable("geocache", {
  query: text("query").primaryKey(),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  bbox: text("bbox"),
  displayName: text("display_name").notNull(),
  createdAt: createdAt(),
});

// Per-key usage history — powers budget enforcement + per-user telemetry.
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: pk(),
    keyId: text("key_id").references(() => keys.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    model: text("model"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => ({ byUser: index("usage_events_user_idx").on(t.userId) }),
);

// First-party telemetry — feature usage + errors, kept LOCAL (never leaves the box). Fuels
// the autonomous discovery + bug finder (and dashboards). NO message content is ever stored,
// only event types + small safe metadata. (Generation/billing telemetry lives in
// usage_events; this covers everything else: capability usage, errors, feature events.)
export const events = sqliteTable(
  "events",
  {
    id: pk(),
    type: text("type").notNull(), // e.g. "capability.maps", "capability.research", "error"
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    meta: text("meta"), // JSON string — safe metadata only, NEVER message content
    createdAt: createdAt(),
  },
  (t) => ({
    byType: index("events_type_idx").on(t.type),
    byCreated: index("events_created_idx").on(t.createdAt),
  }),
);

// Telemetry trend snapshots (Jano stats + app counters), written periodically.
export const statSnapshots = sqliteTable("stat_snapshots", {
  id: pk(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

export type User = typeof users.$inferSelect;
export type Key = typeof keys.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Fact = typeof facts.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type ProviderKey = typeof providerKeys.$inferSelect;
export type Collaborator = typeof conversationCollaborators.$inferSelect;
export type CollaboratorRole = Collaborator["role"];
export type ConversationRecap = typeof conversationRecaps.$inferSelect;
export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;
// `File` is a DOM/Web global, so the row type is named `FileRecord` to avoid shadowing it.
export type FileRecord = typeof files.$inferSelect;

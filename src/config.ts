// Centralized, validated runtime config. Bun auto-loads .env.

import { randomBytes } from "node:crypto";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  // Host: 127.0.0.1 (the load-bearing control — only Tailscale Serve + cloudflared
  // reach the app, so the identity header can't be forged). Container: 0.0.0.0,
  // published on host loopback by compose.
  bindHost: process.env.BIND_HOST ?? "127.0.0.1",
  dataDir: process.env.DATA_DIR ?? "./data",
  dbPath: process.env.DB_PATH ?? "./data/chat.db",

  // Backends. Chat is a CLIENT of the existing host Jano; there is no second Jano.
  janoUrl: process.env.JANO_URL ?? "http://127.0.0.1:8082",
  embedUrl: process.env.EMBED_URL ?? "http://127.0.0.1:8083",
  whisperUrl: process.env.WHISPER_URL ?? "http://127.0.0.1:8084",
  defaultModel: process.env.DEFAULT_MODEL ?? "qwen-chat",
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 20), // per guest key; admins get 6x
  // Per-caller fairness cap for the PUBLIC (no-login) geocode proxy `/api/cap/map/geo` (the shared
  // page's map pins). Keyed by trusted client IP; <=0 disables the cap. This is a per-IP fairness
  // limit, NOT the primary abuse guard — the outbound Nominatim surface is bounded independently by
  // geocode()'s >=1s serialized chain + MAX_PENDING_GEOCODES, so this can be generous without any
  // relay/DoS risk. Set high enough that legit interaction never trips it: one map open geocodes
  // every pin at once (~20), and the drawer re-geocodes on each reopen, so 30 was too tight for a
  // couple of opens in a minute. <=0 disables.
  geoRateLimitPerMin: Number(process.env.GEO_RATE_LIMIT_PER_MIN ?? 60),

  // Free-tier (account user) defaults. Account users authenticate by email and carry NO
  // per-key row, so the bounds a guest gets from its key come from here instead. The
  // security requirement is only that an account is NEVER treated as admin (no unbounded
  // model list, no skipped budget, no 6x rate / pool concurrency). The privilege split is
  // by TIER (tierOf), not by `role !== "guest"`.
  // PRODUCT: the exact free-tier model list + token budget are a knob for Leo to confirm
  // (defaults are deliberately conservative — same default model the picker offers, a
  // finite monthly-ish budget, normal rate, single in-flight generation). These will move
  // behind a real subscription/plan lookup when paid tiers land.
  freeTier: {
    // Model allowlist for account users. Empty env → just the default model. NEVER the
    // unbounded live model list (that's admin-only).
    models: (process.env.FREE_TIER_MODELS ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m.length > 0),
    // Token budget for an account user (null = unlimited is intentionally NOT the default;
    // a finite cap is the conservative, fail-closed choice). 0 or empty disables the budget.
    tokenBudget: Math.max(0, Number(process.env.FREE_TIER_TOKEN_BUDGET ?? 200_000)),
    // One in-flight generation per account user (same conservative default as a guest key).
    maxConcurrency: Math.max(1, Number(process.env.FREE_TIER_MAX_CONCURRENCY ?? 1)),
  },

  // Global generation queue: one machine, so serialize generations (1) — the rest wait
  // in line with a reported position. Raise only if the box can truly run N at once.
  queueConcurrency: Math.max(1, Number(process.env.QUEUE_CONCURRENCY ?? 1)),

  // Web search ("Research") — the premium "search the web" capability. Before a turn the
  // app retrieves current web context and injects it, so ANY model answers from fresh,
  // cited sources (no dependency on the model's own tool-calling). A provider must be
  // configured (a key, or a self-hosted SearXNG URL) for the feature to light up; until
  // then `available` is false everywhere and the toggle stays hidden. See `src/search/`.
  search: {
    enabled: (process.env.WEB_SEARCH_ENABLED ?? "true") === "true",
    // Which backend to use. "auto" picks the first configured of Tavily → Brave → SearXNG.
    provider: (process.env.WEB_SEARCH_PROVIDER ?? "auto") as "auto" | "tavily" | "brave" | "searxng",
    tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY ?? "",
    searxngUrl: process.env.SEARXNG_URL ?? "", // e.g. http://127.0.0.1:8888 (self-hosted, no key)
    // Premium gate seam: admins (the owner) always have it; guests only when this is on.
    // A subscription check replaces this branch later (see search/index.ts).
    guestsAllowed: (process.env.WEB_SEARCH_GUESTS ?? "false") === "true",
    maxResults: Math.max(1, Number(process.env.WEB_SEARCH_MAX_RESULTS ?? 6)), // sources kept per turn
    maxFetch: Math.max(1, Number(process.env.WEB_SEARCH_MAX_FETCH ?? 4)), // pages to fetch+extract when the provider returns snippets only
  },

  // Bring-your-own-key (BYOK, #14) — a paid account plugs in its own frontier-provider API key
  // so a turn can run on the user's own key/cost (their model, their bill) instead of the shared
  // local router. `encryptionKey` encrypts stored keys at rest (AES-256-GCM); it MUST be a stable
  // 32-byte hex string (64 hex chars — `openssl rand -hex 32`). Empty/invalid → BYOK is DISABLED
  // (keys can't be stored; the feature stays dark), and it must NEVER be an ephemeral per-boot
  // value: rotating it makes already-stored keys undecryptable. `guestsAllowed` opens the paywall
  // to non-owner accounts while there are no paid plans (mirrors the web-search guest flag) — a
  // subscription check replaces it later, in one place (src/entitlements/).
  byok: {
    encryptionKey: process.env.BYOK_ENCRYPTION_KEY ?? "",
    guestsAllowed: (process.env.BYOK_GUESTS ?? "false") === "true",
  },

  // Billing / plans (#13) — the paid-ladder seam. Self-hosted-first: this is DARK by default
  // (no provider) and every premium feature still works via the entitlement plan/config flags, so
  // an owner who never wires billing loses nothing. When a provider is set, an account can start a
  // hosted checkout for a paid plan; the provider then POSTs a signed webhook that flips the
  // account's `plan`. Like BYOK/search, a subscription check lives behind ONE seam (plans.ts), so
  // wiring a real provider never touches route code.
  //   provider       — "" (dark) | a label like "polar". Non-empty ⇒ self-serve checkout is offered.
  //   webhookSecret  — HMAC-SHA256 secret the provider (or a thin relay) signs the webhook body with.
  //                    UNSET ⇒ the webhook fails closed (503, before any DB access): no plan can flip.
  //   checkoutUrls   — the provider's HOSTED checkout link per PURCHASABLE plan (a fixed URL the user
  //                    is sent to; no user-controlled URL, so no SSRF surface). Empty ⇒ that plan
  //                    isn't self-serve purchasable (falls back to "contact the owner").
  billing: {
    provider: process.env.BILLING_PROVIDER ?? "",
    webhookSecret: process.env.BILLING_WEBHOOK_SECRET ?? "",
    checkoutUrls: {
      plus: process.env.BILLING_CHECKOUT_URL_PLUS ?? "",
      pro: process.env.BILLING_CHECKOUT_URL_PRO ?? "",
      ultra: process.env.BILLING_CHECKOUT_URL_ULTRA ?? "",
    } as Record<string, string>,
  },

  // Attachments / file manager (#15) — per-user uploaded files. The bytes live on a pluggable
  // storage backend (local disk today; `dir` is created under the writable data dir, cloud later).
  // The three limits are the abuse guard, all enforced server-side BEFORE a byte is written:
  // `maxFileBytes` caps a single upload (kept UNDER the 30MB global body limit so oversize is a
  // clear feature-level 413, not a truncated stream), `maxTotalBytes` the per-account footprint,
  // `maxCount` the per-account file count.
  files: {
    dir: process.env.FILES_DIR ?? `${process.env.DATA_DIR ?? "./data"}/files`,
    maxFileBytes: Math.max(1, Number(process.env.FILES_MAX_FILE_BYTES ?? 25 * 1024 * 1024)),
    maxTotalBytes: Math.max(1, Number(process.env.FILES_MAX_TOTAL_BYTES ?? 200 * 1024 * 1024)),
    maxCount: Math.max(1, Number(process.env.FILES_MAX_COUNT ?? 200)),
  },

  // Live dictation / streaming STT (#71) — the "text streams into the composer AS YOU SPEAK"
  // path, distinct from and ALONGSIDE the batch Whisper `/transcribe` fallback (whisperUrl
  // above, never touched). DARK by default: with STREAMING_STT_URL unset the feature reports
  // unavailable, `/api/dictate` 503s, and the client shows only the existing batch mic — nothing
  // changes. The owner sets STREAMING_STT_URL to a streaming ASR service (NVIDIA Nemotron-3.5-ASR
  // is the candidate under separate validation, or a thin Whisper-streaming shim) AFTER validating
  // a model, and it lights up. Backend-agnostic: the app speaks a small documented contract (post
  // audio -> receive partial/final events, see src/stt/), so ANY streaming ASR can sit behind it.
  // The URL is operator-configured env (never user-supplied) ⇒ no SSRF surface, like the fixed
  // BYOK provider bases.
  dictation: {
    streamingUrl: process.env.STREAMING_STT_URL ?? "",
  },

  // First-party telemetry (the `events` table). LOCAL only — nothing leaves the box. Fuels
  // the autonomous discovery + bug finder. No message content is ever recorded.
  telemetry: {
    enabled: (process.env.TELEMETRY_ENABLED ?? "true") === "true",
  },

  // Deployment environment label, surfaced in /api/me so the UI can flag non-prod
  // (e.g. a "staging" badge). Defaults to production.
  appEnv: process.env.APP_ENV ?? "production",

  // Public base URL. Used to derive the expected WebAuthn origin (src/auth/webauthn/config.ts) and to
  // build absolute shareable-live-collab watch links (`<APP_URL>/s/<slug>`).
  appUrl: process.env.APP_URL ?? "https://a7t.chat",

  // Shared-page TODO completions (#45). The public watch link is read-only except for ticking
  // a TODO checkbox; that single write is gated by a temporary, slug-bound HMAC token (see
  // src/share/write-token.ts). `writeSecret` signs those tokens: set SHARE_WRITE_SECRET to keep
  // already-issued tokens valid across restarts; unset, we generate an ephemeral per-boot secret
  // (fine — the watch page re-fetches a fresh token every few seconds). `writeRateLimitPerMin`
  // caps toggles per token so a holder (or a leaked token) cannot spam the endpoint.
  share: {
    writeSecret: process.env.SHARE_WRITE_SECRET || randomBytes(32).toString("hex"),
    writeRateLimitPerMin: Math.max(1, Number(process.env.SHARE_WRITE_RATE_LIMIT_PER_MIN ?? 30)),
  },

  cloudflare: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  },

  // Auth model (#191). Everyone authenticates by passkey sign-up/sign-in (#169); there is NO blanket
  // tailnet auto-admin anymore (the `TRUST_TAILSCALE_HEADER` path was REMOVED). Admin (the single
  // "owner") is conferred by SIGN-UP, not config: the FIRST passkey account created via the PRIVATE
  // (non-edge) path is stored `role='admin'` (see src/auth/webauthn/routes.ts) — so a public visitor
  // can never claim it and a later self-service sign-up can never self-promote. `devAdminLogin` is a
  // LOCAL-only break-glass bootstrap (a fresh instance, or owner-passkey recovery); it fires ONLY when
  // the request did NOT arrive via the public edge. The edge marker is the hard non-admin
  // discriminator: a request that arrived via cloudflared (`cf-connecting-ip`, or a configured edge
  // marker) is NEVER admin and can never claim the owner slot. The 127.0.0.1 bind makes any of this safe.
  auth: {
    edgeMarkerHeader: (process.env.EDGE_MARKER_HEADER ?? "x-a7t-edge").toLowerCase(),
    edgeMarkerSecret: process.env.EDGE_MARKER_SECRET ?? "",
    // LOCAL-only break-glass bootstrap: makes a non-edge request admin so a fresh instance can get in,
    // or so the owner can recover if they lose their passkey. Never honored via the public edge. Leave
    // empty in production once the owner has signed up.
    devAdminLogin: process.env.DEV_ADMIN_LOGIN ?? "",
  },
} as const;

export type Config = typeof config;

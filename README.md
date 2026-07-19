<p align="center">
  <img src="assets/hero.png" alt="a7t.chat: the AI chat for everyone in your house" width="720">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-horizontal-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="brand/lockup-horizontal-light.png">
    <img alt="a7t.chat" src="brand/lockup-horizontal-light.png" width="360">
  </picture>
</p>

<p align="center">
  A fast, tasteful, self-hostable AI console. Local-first, passkey auth, shareable live sessions.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-black.svg"></a>
  <img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-black.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-black.svg">
</p>

---

**a7t.chat** is a self-hostable, multi-model chat console you actually want to live in. It streams
fast, it looks good, and it runs entirely on your own machine by default: point it at any
OpenAI-compatible model and nothing leaves the box. When you want more, it grows with you, with
passkey accounts, bring-your-own frontier keys, file uploads, and live shareable sessions.

The design bet is simple: speed and taste first, then depth. Instead of racing to match every
feature the big labs ship, a7t.chat focuses on being genuinely nicer to use, and on the one thing
the giants do poorly, live no-login collaboration.

## Highlights

- **Streaming multi-model chat.** Rich markdown, model switching with `/model`, and generations
  that survive a client disconnect (they run on a server-side queue, not the HTTP request).
- **Capabilities.** Focused, in-chat tools rather than separate apps:
  - **Maps** for places and directions.
  - **Recipes** that format a dish as a shopping checklist plus timed steps, with self-contained
    countdown timers that chime when they finish.
  - **Research**, web search that fetches live, cited context before a turn so any model answers
    from fresh sources.
- **Local-first.** Talk to a local, OpenAI-compatible model through `JANO_URL`. In this mode
  nothing leaves your machine.
- **Bring your own key (optional).** Plug in your own frontier-provider API keys and run turns on
  your own key and cost. Keys are encrypted at rest and never leave the box except into a turn.
- **File uploads.** Per-account attachments delivered into the prompt, with per-file and
  per-account quotas.
- **Shareable live sessions.** Conversations are private by default. Opt in and mint an
  unguessable link that anyone can watch build in real time with no sign-up, or invite another
  account into a live collaborative session.
- **Passkey auth.** Passwordless, phishing-resistant WebAuthn sign-up and sign-in.

## Self-host quickstart (fully local)

The default posture is fully local: you run a local OpenAI-compatible model, the app talks to it,
and nothing is sent to any third party. You need [Bun](https://bun.sh) and any OpenAI-compatible
model endpoint (for example [Jano](https://github.com/a7t-ai/jano), llama.cpp's `llama-server`,
Ollama, or vLLM).

1. **Install Bun** (if you don't have it): `curl -fsSL https://bun.sh/install | bash`
2. **Install dependencies:** `bun install`
3. **Create your env file:** `cp .env.example .env`
4. **Point at your model:** set `JANO_URL` to your local OpenAI-compatible endpoint (default
   `http://127.0.0.1:8082`) and `DEFAULT_MODEL` to a model id that endpoint exposes via
   `/v1/models`.
5. **Create the database:** `bun run db:migrate` (migrations also auto-apply on boot).
6. **Start the backend as the owner:** `DEV_ADMIN_LOGIN=you@example.com bun run dev` (serves on
   `http://127.0.0.1:8787`). `DEV_ADMIN_LOGIN` makes you the owner locally, no account needed.
7. **Start the frontend:** `cd web && bun install && bun run dev` (on `http://localhost:5173`,
   proxying the API to `8787`).

Open `http://localhost:5173` and start chatting. That's the whole loop, entirely on your machine.

To let other people sign up with a passkey, set `WEBAUTHN_RP_ID` (the registrable domain the app is
served from) and `APP_URL` to your real origin. Passkeys are dark until `WEBAUTHN_RP_ID` is set, so
until then only the owner (via `DEV_ADMIN_LOGIN`, or a private network such as Tailscale) can reach
the app.

## Configuration

Everything is configured through `.env` (see `.env.example` for the full, commented list). The
essentials for a local self-host:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | App port. |
| `BIND_HOST` | `127.0.0.1` | Host bind. Loopback-only is a load-bearing security control. |
| `JANO_URL` | `http://127.0.0.1:8082` | Your local OpenAI-compatible model endpoint. The app is a client. |
| `DEFAULT_MODEL` | `qwen-chat` | Default model id (must match what your endpoint exposes). |
| `DEV_ADMIN_LOGIN` | | Local-only: become the owner without an account. Dev / self-host convenience. |
| `WEBAUTHN_RP_ID` | | Registrable domain for passkeys. Unset keeps passkey sign-up dark (owner-only). |
| `APP_URL` | | Public origin. Used to derive the passkey origin and to build share links. |

Optional features have their own blocks in `.env.example`:

- **Research (web search):** pick a provider (Tavily, Brave, or self-hosted SearXNG) and set its
  key or URL. The toggle stays hidden until a provider is configured.
- **BYOK (bring your own key):** set the BYOK encryption key to enable storing frontier-provider
  keys encrypted at rest. Left unset, the feature stays dark.
- **File uploads:** the storage directory and per-file / per-account quotas.

## Architecture

- **Backend:** [Bun](https://bun.sh) + [Hono](https://hono.dev) + `bun:sqlite` with
  [Drizzle ORM](https://orm.drizzle.team). Entry point `src/server.ts`, which binds `127.0.0.1`.
  The app is a *client* of your model endpoint, never a second router.
- **Frontend:** [Vite](https://vitejs.dev) + React + [streamdown](https://github.com/vercel/streamdown)
  for streaming markdown, in `web/`.
- **Capabilities** are a clean seam (`src/capabilities/`, `web/src/capabilities/`): each is a small
  marker plus a server and client entry, so adding one touches only the two registries, never the
  core chat route. Maps and Research are the examples to copy.
- **Auth** is a two-tier gate (`src/auth/`): the owner (over a private network such as Tailscale,
  or `DEV_ADMIN_LOGIN` locally) and passkey accounts. Everyone else hits a friendly wall.
- **Storage:** SQLite via Drizzle, migrations auto-applied on boot. The `db`, model-client, and
  `auth` boundaries are deliberate swap seams.

See `src/README.md` for the module map.

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev setup, the test and
coverage bar, and the branch-to-PR flow, and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for the
community expectations. To report a security issue, use GitHub's private security advisories.

## License

[MIT](LICENSE) (c) Leo Cardoso

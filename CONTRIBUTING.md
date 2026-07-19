# Contributing to a7t.chat

Thanks for your interest in improving a7t.chat. This guide covers the dev setup, the test and
coverage bar, and how changes land. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Dev setup

The whole stack is [Bun](https://bun.sh). There is no pnpm, turbo, or Docker in the dev loop.

1. **Install Bun:** `curl -fsSL https://bun.sh/install | bash`
2. **Install dependencies:** `bun install` (root) and `cd web && bun install` (frontend).
3. **Create your env file:** `cp .env.example .env` and set `JANO_URL` to a local
   OpenAI-compatible model endpoint (see the [README quickstart](README.md#self-host-quickstart-fully-local)).
4. **Run the app:** `DEV_ADMIN_LOGIN=you@example.com bun run dev` (backend on `:8787`) and, in
   another shell, `cd web && bun run dev` (frontend on `:5173`).

Repo layout:

- `src/` is the Bun + Hono backend (see `src/README.md` for the module map).
- `web/` is the Vite + React frontend.

## The gate

Every change must keep the full gate green before it can merge. Run it locally:

```bash
bun run typecheck        # tsc --noEmit (backend)
cd web && bun run build  # tsc --noEmit && vite build (frontend)
bun test                 # backend tests
cd web && bun run test:cov  # frontend tests + coverage
```

### Coverage bar

Tests are the behavior gate, and coverage cannot regress:

- **Backend** (`bun test --coverage`, thresholds in `bunfig.toml`): **at least 80%** lines,
  functions, and statements. Bun only counts files a run loads, so **every module needs at least
  one `*.test.ts` beside it** or it will not count.
- **Web** (`cd web && bun run test:cov`, thresholds in `web/vitest.config.ts`): **at least 80%**
  lines, functions, and statements, and **at least 70%** branches.

Guidelines:

- Tests must be fast and deterministic. Never hit real network services (the model endpoint, search
  providers, geocoding). Stub them. Backend tests use an isolated temp DB (`src/__tests__/setup.ts`).
- Favor pure functions. When a security-critical or regression-prone bit is hard to test, refactor
  the sharp edge into a pure helper and test that.
- Always test security logic (auth, the SSRF URL guard), the capability marker parser, the
  generation queue, and anything that has broken once before.

## Branch and PR flow

1. Fork the repo (or branch, if you have write access) off `develop`.
2. Make your change with tests that keep the coverage bar green.
3. Run the full gate locally.
4. Open a pull request against `develop` with a clear description: what it changes, how it is
   built, and why. Reference any related issue.
5. CI runs the same gate on your PR. Keep it green.

Keep PRs focused. One logical change per PR is much easier to review and land.

## Code style

- Match the surrounding code. Comment the *why* for non-obvious decisions and keep it tight.
- American English.
- No new dependencies without a real need.
- Never commit secrets. `.env` is gitignored; document any new env var in `.env.example` with a
  placeholder and a short comment.

## Reporting bugs and requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For security issues, do **not** open a
public issue; report it privately through GitHub's security advisories.

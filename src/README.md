# `src/` module layout

The chat is **capability #1** of a modular AI console. Each module has one job, and
the boundaries are the seams that keep the product swappable later.

| Module | Responsibility |
|---|---|
| `server.ts` | Hono entry. Binds `127.0.0.1` on host (`0.0.0.0` only inside the container). |
| `config.ts` | Validated runtime config from env. |
| `auth/` | The auth gate: passkey session → owner-admin (handle == `OWNER_HANDLE`, #191) or account · local bootstrap → admin · neither → wall. |
| `db/` | Drizzle schema + migrations (SQLite now; Postgres-portable). |
| `jano/` | **Client** for the existing host Jano router (behind a swappable interface). |
| `embed/` | **Client** for the embedding service (llama-server --embedding, off Jano). |
| `memory/` | Two-tier memory: raw verbatim log → derived facts + rolling summary → semantic recall. |
| `chat/` | SSE streaming + `/model` command parsing. |
| `capabilities/` | Capability registry. Chat registers as #1; a companion service/a companion service slot in later. |
| `telemetry/` | `/stats` endpoint sourced from the Jano client + app counters. |

**Swap seams (keep these clean):** `db/` (Drizzle), `jano/` + `embed/` (client interfaces),
`auth/` (provider interface). Don't hardwire across them.

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

// Ensure the (only writable) data dir exists, then open SQLite in WAL mode:
// readers never block the single writer — right for bursty, low-concurrency chat.
mkdirSync(dirname(config.dbPath), { recursive: true });

const sqlite = new Database(config.dbPath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec("PRAGMA busy_timeout = 5000;");

export const db = drizzle(sqlite, { schema });

// Apply any pending migrations on startup so the running schema is never behind the
// code. The deploy image (`bun run src/server.ts`) has no separate migrate step, so a
// feature that adds a column (e.g. answer-regeneration variants) would otherwise hit a
// DB missing it — and SQLite silently treats the unknown column name as a string
// literal rather than erroring, corrupting reads. The migrator is idempotent: it only
// runs migrations not yet recorded in `__drizzle_migrations`. Path is resolved from this
// module so it works regardless of the process's cwd. Fail fast — a bad schema must not
// serve traffic. The standalone `bun run db:migrate` remains for manual/CI use.
migrate(db, { migrationsFolder: join(import.meta.dir, "migrations") });

export { schema };
export type DB = typeof db;

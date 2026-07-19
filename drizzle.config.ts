import { defineConfig } from "drizzle-kit";

// Drizzle is the SQLite<->Postgres portability seam (product-later). Today: SQLite.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DB_PATH ?? "./data/chat.db",
  },
});

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./index.ts";

// Apply all generated migrations. Run with `bun run db:migrate`.
migrate(db, { migrationsFolder: "./src/db/migrations" });
console.log("migrations applied");

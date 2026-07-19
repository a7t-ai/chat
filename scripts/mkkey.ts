import { eq } from "drizzle-orm";
import { generateToken } from "../src/auth/tokens.ts";
import { db } from "../src/db/index.ts";
import { keys, users } from "../src/db/schema.ts";

// Minimal admin CLI to mint a guest key (the command-line counterpart of the admin UI
// that lands later). Prints the raw token to stdout ONCE; summary goes to stderr.
//
//   bun run mkkey --login alice --label laptop --models qwen-chat,qwen-coder --budget 1000000 --days 30
//   (omit --budget for unlimited, omit --days for no expiry)

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const login = arg("login");
if (!login) {
  console.error("usage: bun run mkkey --login <login> [--name N] [--label L] [--models a,b] [--budget N] [--days N]");
  process.exit(1);
}

const label = arg("label") ?? "key";
const models = (arg("models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const budget = arg("budget") ? Number(arg("budget")) : null; // null = unlimited
const days = arg("days");
const expiresAt = days ? new Date(Date.now() + Number(days) * 86_400_000) : null;

let user = db.select().from(users).where(eq(users.login, login)).get();
if (!user) {
  user = db.insert(users).values({ login, displayName: arg("name") ?? null, role: "guest" }).returning().get();
}
if (!user) throw new Error("failed to resolve user");

const { token, hash } = generateToken();
const key = db
  .insert(keys)
  .values({ userId: user.id, label, tokenHash: hash, modelAllowlist: models, tokenBudget: budget, expiresAt })
  .returning()
  .get();

console.error(
  `minted key ${key?.id} for ${login} — models=[${models.join(", ")}] ` +
    `budget=${budget ?? "unlimited"} expires=${expiresAt?.toISOString() ?? "never"}`,
);
console.log(token);

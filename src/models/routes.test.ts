import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SESSION_COOKIE } from "../auth/cookie.ts";
import { createSession } from "../auth/session.service.ts";
import { clearByokModelsCache } from "../byok/models.ts";
import { setProviderKey } from "../byok/service.ts";
import { DEFAULT_MODEL } from "../chat/service.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { providerKeys, users } from "../db/schema.ts";
import { backend } from "../jano/client.ts";
import server from "../server.ts";
import type { MergedModel } from "./types.ts";

type CatalogBody = { models: MergedModel[]; default: string };

function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(server.fetch(new Request(`http://localhost${path}`, init)));
}
// Admin = the LOCAL break-glass bootstrap (#191 removed the Tailscale-header admin path). Setting
// DEV_ADMIN_LOGIN admits a credential-less, non-edge request as that login-keyed admin. Returns `{}`;
// the side effect is the grant. beforeEach clears it so account-cookie tests aren't preempted.
function adminHeaders(login = `cat-admin-${Math.random()}`): Record<string, string> {
  (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = login;
  return {};
}
function seedAccount(modelAllowlist?: string[]): { cookie: string } {
  const u = db
    .insert(users)
    .values({
      login: `cat-acct-${Math.random()}`,
      email: `${Math.random()}@a7t.test`,
      role: "account",
      plan: "free",
      accessGrantedAt: new Date(),
      modelAllowlist: modelAllowlist ? JSON.stringify(modelAllowlist) : null,
    })
    .returning()
    .get()!;
  return { cookie: `${SESSION_COOKIE}=${createSession({ userId: u.id }).token}` };
}

// House pattern (see admin/routes.test.ts): swap the Jano client method directly, restore after.
const realListModels = backend.listModels;
function stubLive(models: { id: string; label?: string }[]): void {
  backend.listModels = (async () => models) as typeof backend.listModels;
}
function stubJanoDown(): void {
  backend.listModels = (async () => {
    throw new Error("jano down");
  }) as typeof backend.listModels;
}

// Seed an admin ROW (getOrCreateAdmin matches by login), so a stored BYOK key lands under the SAME id
// the request authenticates as, then arm the dev bootstrap for that login. Returns the id + `{}`
// headers (the admin grant is the devAdminLogin side effect).
function seedAdminWithKey(provider: string, login = `byok-admin-${Math.random()}`): { id: string; headers: Record<string, string> } {
  const u = db.insert(users).values({ login, role: "admin", displayName: "Leo" }).returning().get()!;
  setProviderKey(u.id, provider, "sk-live-abcd");
  (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = login;
  return { id: u.id, headers: {} };
}

// Stub the global fetch each provider `${base}/models` call rides. `ok:false` makes that provider's
// /models error (the graceful-failure path).
const realFetch = globalThis.fetch;
function stubProviderModels(data: { id: string; label?: string }[], ok = true): void {
  globalThis.fetch = (async () =>
    ok ? new Response(JSON.stringify({ data }), { status: 200 }) : new Response("nope", { status: 500 })) as unknown as typeof fetch;
}

beforeEach(() => {
  const a = config.auth as unknown as { devAdminLogin: string; edgeMarkerSecret: string };
  a.devAdminLogin = "";
  a.edgeMarkerSecret = "";
});
afterEach(() => {
  backend.listModels = realListModels;
  globalThis.fetch = realFetch;
  clearByokModelsCache();
  db.delete(providerKeys).run();
  db.delete(users).run();
});

describe("GET /api/models/catalog", () => {
  test("401 without a credential", async () => {
    stubLive([{ id: "qwen-chat" }]);
    expect((await fetchApp("/api/models/catalog")).status).toBe(401);
  });

  test("admin sees the whole live list merged — cataloged enriched, uncataloged defaulted", async () => {
    stubLive([
      { id: "qwen-chat", label: "Qwen3.6 35B" },
      { id: "mystery-model", label: "Mystery" },
    ]);
    const res = await fetchApp("/api/models/catalog", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogBody;
    expect(body.default).toBe(DEFAULT_MODEL);
    const byId = Object.fromEntries(body.models.map((m) => [m.id, m]));
    // Cataloged: enriched with real metadata + the Jano label.
    expect(byId["qwen-chat"]!.provider).toBe("qwen");
    expect(byId["qwen-chat"]!.displayName).toBe("Qwen3.6 35B");
    expect(byId["qwen-chat"]!.input).toContain("text");
    // Uncataloged: shown (never hidden) with conservative defaults.
    expect(byId["mystery-model"]!.provider).toBe("local");
    expect(byId["mystery-model"]!.displayName).toBe("Mystery");
    expect(byId["mystery-model"]!.cost).toEqual({ local: true });
  });

  test("an account is SCOPED to its allowlist — never handed Jano's unbounded live list", async () => {
    stubLive([{ id: "qwen-chat" }, { id: "qwen-code" }, { id: "qwen-omni" }]);
    const { cookie } = seedAccount(["qwen-code", "qwen-omni"]);
    const res = await fetchApp("/api/models/catalog", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogBody;
    // Only the two allowlisted models come back — qwen-chat is filtered out despite being live.
    expect(body.models.map((m) => m.id)).toEqual(["qwen-code", "qwen-omni"]);
  });

  test("an account with no allowlist falls back to the default model only", async () => {
    stubLive([{ id: "qwen-chat" }, { id: "qwen-code" }]);
    const { cookie } = seedAccount();
    const res = await fetchApp("/api/models/catalog", { headers: { cookie } });
    const body = (await res.json()) as CatalogBody;
    expect(body.models.map((m) => m.id)).toEqual([DEFAULT_MODEL]);
  });

  test("degrades to an empty list when Jano is down (never a 500)", async () => {
    stubJanoDown();
    const res = await fetchApp("/api/models/catalog", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogBody;
    expect(body.models).toEqual([]);
    expect(body.default).toBe(DEFAULT_MODEL);
  });

  // #185: the caller's configured-BYOK-provider models join the local list.
  test("folds the caller's BYOK models in after the local ones — prefixed + byokOnly", async () => {
    stubLive([{ id: "qwen-chat", label: "Qwen Chat" }]);
    const { headers } = seedAdminWithKey("openai");
    stubProviderModels([{ id: "gpt-4o", label: "GPT-4o" }]);
    const res = await fetchApp("/api/models/catalog", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogBody;
    // Local first, then BYOK.
    expect(body.models.map((m) => m.id)).toEqual(["qwen-chat", "openai/gpt-4o"]);
    const byok = body.models.find((m) => m.id === "openai/gpt-4o")!;
    expect(byok.byokOnly).toBe(true);
    expect(byok.provider).toBe("openai");
    expect(byok.displayName).toBe("GPT-4o");
    // The local model stays a plain, non-BYOK row.
    expect(body.models.find((m) => m.id === "qwen-chat")!.byokOnly).toBe(false);
  });

  // GRACEFUL: a provider whose /models errors must never drop the local models or 500.
  test("keeps the local models (200) when a BYOK provider's /models errors", async () => {
    stubLive([{ id: "qwen-chat" }, { id: "qwen-code" }]);
    const { headers } = seedAdminWithKey("openai");
    stubProviderModels([], false); // openai /models -> 500
    const res = await fetchApp("/api/models/catalog", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogBody;
    expect(body.models.map((m) => m.id)).toEqual(["qwen-chat", "qwen-code"]); // local intact, no BYOK
  });
});

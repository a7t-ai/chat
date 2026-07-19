import { afterEach, describe, expect, test } from "bun:test";
import type { AuthContext } from "../auth/middleware.ts";
import { db } from "../db/index.ts";
import { providerKeys, users } from "../db/schema.ts";
import { byokModelsFor, clearByokModelsCache } from "./models.ts";
import { setProviderKey } from "./service.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearByokModelsCache();
  db.delete(providerKeys).run();
  db.delete(users).run();
});

// A default-plan account is `ultra` (#166) → BYOK-entitled. Pass `plan: "free"` for the dormant
// paywall path (a non-entitled caller must never round-trip a provider).
function makeUser(role: "admin" | "account", plan?: "free" | "ultra"): AuthContext {
  const u = db
    .insert(users)
    .values({ login: `byok-models-${Math.random()}`, role, ...(plan ? { plan } : {}) })
    .returning()
    .get()!;
  return { role, via: role === "admin" ? "tailscale" : "session", user: u, key: null } as unknown as AuthContext;
}

// Stub the global fetch each provider's `${base}/models` call rides. Routes by URL host so a test
// can make one provider succeed and another fail. `count` tallies calls so cache tests can assert
// no extra round-trips. A url whose host isn't mapped 500s (an unexpected call is a visible failure).
function stubModelsFetch(byHost: Record<string, { status?: number; data?: { id: string; label?: string }[] }>): { count: () => number } {
  let n = 0;
  globalThis.fetch = (async (url: string) => {
    n++;
    const host = new URL(url).host;
    const spec = byHost[host];
    if (!spec || spec.status === undefined || spec.status >= 400) {
      return new Response("nope", { status: spec?.status ?? 500 });
    }
    return new Response(JSON.stringify({ data: spec.data ?? [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { count: () => n };
}

describe("byokModelsFor", () => {
  test("a non-entitled caller gets [] and never round-trips a provider", async () => {
    const acct = makeUser("account", "free"); // free → BYOK paywall closed
    setProviderKey(acct.user.id, "openai", "sk-live-abcd");
    const probe = stubModelsFetch({ "api.openai.com": { status: 200, data: [{ id: "gpt-4o" }] } });
    expect(await byokModelsFor(acct)).toEqual([]);
    expect(probe.count()).toBe(0); // fail-closed before any fetch
  });

  test("an entitled caller with no keys gets [] (no providers to fetch)", async () => {
    const admin = makeUser("admin");
    const probe = stubModelsFetch({});
    expect(await byokModelsFor(admin)).toEqual([]);
    expect(probe.count()).toBe(0);
  });

  test("surfaces each configured provider's models — prefixed `provider/`, marked byokOnly", async () => {
    const admin = makeUser("admin");
    setProviderKey(admin.user.id, "openai", "sk-live-abcd");
    stubModelsFetch({
      "api.openai.com": { status: 200, data: [{ id: "gpt-4o", label: "GPT-4o" }, { id: "gpt-4o-mini" }] },
    });
    const out = await byokModelsFor(admin);
    expect(out.map((m) => m.id)).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
    const gpt4o = out.find((m) => m.id === "openai/gpt-4o")!;
    expect(gpt4o.byokOnly).toBe(true);
    expect(gpt4o.provider).toBe("openai");
    expect(gpt4o.available).toBe(true);
    expect(gpt4o.displayName).toBe("GPT-4o"); // provider label wins
    // No label → the bare upstream id is the display name.
    expect(out.find((m) => m.id === "openai/gpt-4o-mini")!.displayName).toBe("gpt-4o-mini");
  });

  test("de-dupes a repeated id within a provider (first wins) and skips a blank id", async () => {
    const admin = makeUser("admin");
    setProviderKey(admin.user.id, "openai", "sk-live-abcd");
    stubModelsFetch({
      "api.openai.com": { status: 200, data: [{ id: "gpt-4o", label: "First" }, { id: "gpt-4o", label: "Dup" }, { id: "" }] },
    });
    const out = await byokModelsFor(admin);
    expect(out.map((m) => m.id)).toEqual(["openai/gpt-4o"]);
    expect(out[0]!.displayName).toBe("First");
  });

  test("GRACEFUL: a provider whose /models errors is skipped — the others still surface", async () => {
    const admin = makeUser("admin");
    setProviderKey(admin.user.id, "openai", "sk-live-openai");
    setProviderKey(admin.user.id, "anthropic", "sk-ant-live-bad");
    stubModelsFetch({
      "api.openai.com": { status: 200, data: [{ id: "gpt-4o" }] },
      "api.anthropic.com": { status: 500 }, // this provider's /models errors
    });
    const out = await byokModelsFor(admin);
    // Never throws; the failed provider is simply absent, the healthy one is present.
    expect(out.map((m) => m.id)).toEqual(["openai/gpt-4o"]);
  });

  test("GRACEFUL: every provider failing yields [] (never throws)", async () => {
    const admin = makeUser("admin");
    setProviderKey(admin.user.id, "openai", "sk-live-solo");
    stubModelsFetch({ "api.openai.com": { status: 503 } });
    expect(await byokModelsFor(admin)).toEqual([]);
  });

  test("caches per caller; clearByokModelsCache forces a re-fetch", async () => {
    const admin = makeUser("admin");
    setProviderKey(admin.user.id, "openai", "sk-live-solo");
    const probe = stubModelsFetch({ "api.openai.com": { status: 200, data: [{ id: "gpt-4o" }] } });
    await byokModelsFor(admin);
    await byokModelsFor(admin); // served from cache — no second round trip
    expect(probe.count()).toBe(1);
    clearByokModelsCache();
    await byokModelsFor(admin); // cache dropped → fetches again
    expect(probe.count()).toBe(2);
  });
});

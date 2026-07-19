import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SESSION_COOKIE } from "../auth/cookie.ts";
import { createSession } from "../auth/session.service.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { providerKeys, users } from "../db/schema.ts";
import server from "../server.ts";

function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(server.fetch(new Request(`http://localhost${path}`, init)));
}
// Admin in these route tests = the LOCAL break-glass bootstrap (#191 removed the Tailscale-header
// admin path). Setting DEV_ADMIN_LOGIN makes a subsequent credential-less, non-edge request
// authenticate as that admin login (a distinct admin row per login via getOrCreateAdmin) — the
// per-request stand-in for the old identity header. Returns `{}` (no headers needed); the side effect
// is the admin grant. beforeEach clears it so account-session tests aren't preempted.
function adminHeaders(login = `byok-admin-${Math.random()}`): Record<string, string> {
  (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = login;
  return {};
}
function accountSession(): string {
  // Pin the plan to `free` so this account is genuinely NON-entitled for the BYOK gate. The OSS
  // build now defaults new accounts to `ultra` (#166), so the paywall-still-gates tests below must
  // set a non-unlocking plan explicitly — the dormant BYOK entitlement seam is what's under test.
  const u = db
    .insert(users)
    .values({ login: `byok-acct-${Math.random()}`, email: `${Math.random()}@a7t.test`, role: "account", accessGrantedAt: new Date(), plan: "free" })
    .returning()
    .get()!;
  return createSession({ userId: u.id }).token;
}
// A default-plan (ultra, #166) account — BYOK-entitled — with a live session. Returns the Cookie value.
function entitledAccountCookie(): string {
  const u = db
    .insert(users)
    .values({ login: `byok-ent-${Math.random()}`, email: `${Math.random()}@a7t.test`, role: "account", accessGrantedAt: new Date() })
    .returning()
    .get()!;
  return `${SESSION_COOKIE}=${createSession({ userId: u.id }).token}`;
}

beforeEach(() => {
  const a = config.auth as unknown as { devAdminLogin: string; edgeMarkerSecret: string };
  a.devAdminLogin = "";
  a.edgeMarkerSecret = "";
});
afterEach(() => {
  db.delete(providerKeys).run();
  (config.byok as unknown as { encryptionKey: string; guestsAllowed: boolean }).encryptionKey =
    process.env.BYOK_ENCRYPTION_KEY ?? "";
  (config.byok as unknown as { guestsAllowed: boolean }).guestsAllowed = false;
});

const json = (extra: Record<string, string>) => ({ "content-type": "application/json", ...extra });

describe("/api/byok", () => {
  test("401 without a credential", async () => {
    expect((await fetchApp("/api/byok")).status).toBe(401);
  });

  test("a non-entitled account is walled by the paywall (402)", async () => {
    const token = accountSession();
    const res = await fetchApp("/api/byok", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(402);
    expect((await res.json()) as { gate: string }).toMatchObject({ gate: "paywall", feature: "byok" });
  });

  test("admin: GET shows availability + catalog, PUT stores (masked), GET reflects it, DELETE removes", async () => {
    const h = adminHeaders("byok-flow@github");
    // seed the user row
    await fetchApp("/api/me", { headers: h });

    let res = await fetchApp("/api/byok", { headers: h });
    expect(res.status).toBe(200);
    let body = (await res.json()) as { available: boolean; providers: { id: string }[]; keys: unknown[] };
    expect(body.available).toBe(true);
    expect(body.providers.some((p) => p.id === "openai")).toBe(true);
    expect(body.keys).toHaveLength(0);

    res = await fetchApp("/api/byok/openai", { method: "PUT", headers: json(h), body: JSON.stringify({ key: "sk-secret-1234" }) });
    expect(res.status).toBe(200);
    expect((await res.json()) as { key: { last4: string } }).toMatchObject({ ok: true, key: { provider: "openai", last4: "1234" } });

    res = await fetchApp("/api/byok", { headers: h });
    body = (await res.json()) as { available: boolean; providers: { id: string }[]; keys: { provider: string; last4: string }[] };
    expect(body.keys).toEqual([{ provider: "openai", last4: "1234", updatedAt: expect.anything() }]);
    // the plaintext never rides in the response
    expect(JSON.stringify(body)).not.toContain("sk-secret");

    res = await fetchApp("/api/byok/openai", { method: "DELETE", headers: h });
    expect((await res.json()) as { removed: boolean }).toMatchObject({ ok: true, removed: true });
    res = await fetchApp("/api/byok", { headers: h });
    expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(0);
  });

  test("PUT rejects a missing key (400) and an unknown provider (400)", async () => {
    const h = adminHeaders("byok-bad@github");
    await fetchApp("/api/me", { headers: h });
    let res = await fetchApp("/api/byok/openai", { method: "PUT", headers: json(h), body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    res = await fetchApp("/api/byok/acme", { method: "PUT", headers: json(h), body: JSON.stringify({ key: "sk-secret-1234" }) });
    expect(res.status).toBe(400);
  });

  test("PUT returns 503 when BYOK isn't configured on the server", async () => {
    const h = adminHeaders("byok-dark@github");
    await fetchApp("/api/me", { headers: h });
    (config.byok as unknown as { encryptionKey: string }).encryptionKey = "";
    const res = await fetchApp("/api/byok/openai", { method: "PUT", headers: json(h), body: JSON.stringify({ key: "sk-secret-1234" }) });
    expect(res.status).toBe(503);
    // GET still works so the UI can show "not configured"
    const get = await fetchApp("/api/byok", { headers: h });
    expect(((await get.json()) as { available: boolean }).available).toBe(false);
  });

  test("keys are per-caller — a second caller never sees the first's keys", async () => {
    // The single owner-admin model (#191) makes "two admins" impossible, so per-caller key isolation
    // is exercised with two distinct entitled accounts — the realistic multi-user shape. Keys are
    // scoped by user id regardless of role.
    const a = entitledAccountCookie();
    const b = entitledAccountCookie();
    await fetchApp("/api/byok/openai", { method: "PUT", headers: json({ cookie: a }), body: JSON.stringify({ key: "sk-a-key-1111" }) });
    const res = await fetchApp("/api/byok", { headers: { cookie: b } });
    expect(((await res.json()) as { keys: unknown[] }).keys).toHaveLength(0);
  });
});

describe("/api/me byok block", () => {
  test("admin sees available true and their configured providers", async () => {
    const h = adminHeaders("byok-me@github");
    await fetchApp("/api/me", { headers: h });
    await fetchApp("/api/byok/openai", { method: "PUT", headers: json(h), body: JSON.stringify({ key: "sk-me-key-2222" }) });
    const res = await fetchApp("/api/me", { headers: h });
    const body = (await res.json()) as { byok: { available: boolean; providers: string[] }; features: Record<string, boolean> };
    expect(body.byok.available).toBe(true);
    expect(body.byok.providers).toEqual(["openai"]);
    expect(body.features.byok).toBe(true);
  });

  test("a non-entitled account gets an empty providers list and features.byok false", async () => {
    const token = accountSession();
    const res = await fetchApp("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    const body = (await res.json()) as { byok: { providers: string[] }; features: Record<string, boolean> };
    expect(body.byok.providers).toEqual([]);
    expect(body.features.byok).toBe(false);
  });
});

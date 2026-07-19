import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { SESSION_COOKIE } from "../auth/cookie.ts";
import { createSession } from "../auth/session.service.ts";
import server from "../server.ts";

// /api/me + PUT /api/settings live inline in server.ts (excluded from the coverage
// denominator but still part of the API surface). We drive the assembled app end-to-end
// through its real `fetch` — including the real authMiddleware — as admin (the LOCAL break-glass
// bootstrap; #191 removed the Tailscale-header admin path) or as an account (a session cookie). The
// guest-key/Bearer tier was retired. No network: the only thing these two routes touch is the (temp) DB.

function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(server.fetch(new Request(`http://localhost${path}`, init)));
}

beforeEach(() => {
  // The middleware tests mutate these knobs; restore clean defaults. Admin here is the dev bootstrap
  // (set per-request by adminHeaders); the owner is otherwise a stored role='admin' account.
  const a = config.auth as unknown as { devAdminLogin: string; edgeMarkerSecret: string };
  a.devAdminLogin = "";
  a.edgeMarkerSecret = "";
});

// Admin = the LOCAL break-glass bootstrap (#191). Setting DEV_ADMIN_LOGIN makes a subsequent
// credential-less, non-edge request authenticate as that admin login (a distinct login-keyed admin
// row via getOrCreateAdmin). Returns `{}`; the side effect is the grant. beforeEach clears it so the
// account-session tests aren't preempted.
function adminHeaders(login = `srv-admin-${Math.random()}`): Record<string, string> {
  (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = login;
  return {};
}

// An access-granted account user with a live session cookie (the only non-admin tier now).
function makeAccountSession(): { token: string; userId: string } {
  const u = db
    .insert(users)
    .values({ login: `srv-acct-${Math.random()}`, email: `srv-${Math.random()}@a7t.test`, role: "account", emailVerifiedAt: new Date(), accessGrantedAt: new Date() })
    .returning()
    .get();
  const { token } = createSession({ userId: u.id });
  return { token, userId: u.id };
}

describe("GET /api/me", () => {
  test("401 without any credential (the wall)", async () => {
    const res = await fetchApp("/api/me");
    expect(res.status).toBe(401);
  });

  test("admin (dev bootstrap) → role admin, the user block, and a feature map", async () => {
    const res = await fetchApp("/api/me", { headers: adminHeaders("me-admin@github") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      role: string;
      via: string;
      user: { login: string; displayName: string | null };
      key: unknown;
      search: { available: boolean };
      features: Record<string, boolean>;
    };
    expect(body.role).toBe("admin");
    expect(body.via).toBe("dev");
    expect(body.user.login).toBe("me-admin@github");
    expect(body.key).toBeNull();
    // owner-only features are on for an admin
    expect(body.features["admin.accounts"]).toBe(true);
    expect(body.features["chat.send"]).toBe(true);
    expect(typeof body.search.available).toBe("boolean");
  });

  // Capability suggestion engine (#22): /api/me carries the caller's active contextual-nudge set.
  test("carries the capability suggestion hints (maps + timer), copy + triggers only", async () => {
    const res = await fetchApp("/api/me", { headers: adminHeaders("me-suggest-admin@github") });
    const body = (await res.json()) as { suggestions: { id: string; title: string; body: string; triggers: string[] }[] };
    expect(Array.isArray(body.suggestions)).toBe(true);
    const ids = body.suggestions.map((s) => s.id);
    expect(ids).toContain("map");
    expect(ids).toContain("timer");
    const map = body.suggestions.find((s) => s.id === "map")!;
    expect(map.title.length).toBeGreaterThan(0);
    expect(map.triggers.length).toBeGreaterThan(0);
  });

  test("account (session cookie) → role account, accessGranted, key null, owner-only walled", async () => {
    const { token, userId } = makeAccountSession();
    const res = await fetchApp("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; via: string; user: { id: string }; key: unknown; accessGranted: boolean; features: Record<string, boolean> };
    expect(body.role).toBe("account");
    expect(body.via).toBe("session");
    expect(body.user.id).toBe(userId);
    expect(body.key).toBeNull(); // keys are retired — no account carries one
    expect(body.accessGranted).toBe(true);
    expect(body.features["admin.accounts"]).toBe(false); // owner-only, walled for an account
  });

  test("a Bearer token is no longer a credential → 401 (the guest tier is retired)", async () => {
    const res = await fetchApp("/api/me", { headers: { authorization: "Bearer a7t_anything" } });
    expect(res.status).toBe(401);
  });

  // Profile card (#12): /api/me carries the caller's own plan. The usage meter was dropped (#186).
  test("admin → plan owner", async () => {
    const res = await fetchApp("/api/me", { headers: adminHeaders("me-plan-admin@github") });
    const body = (await res.json()) as { plan: string; usage?: unknown };
    expect(body.plan).toBe("owner");
    expect(body.usage).toBeUndefined(); // meter removed (#186)
  });

  test("account → plan ultra (OSS default, #166)", async () => {
    const { token } = makeAccountSession();
    const res = await fetchApp("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    const body = (await res.json()) as { plan: string; usage?: unknown };
    // Every account is `ultra` by default in the OSS build (the paywall is removed).
    expect(body.plan).toBe("ultra");
    expect(body.usage).toBeUndefined(); // meter removed (#186)
  });
});

// Owner designation (#191) — end-to-end through the real gate. The owner is the account with a STORED
// role='admin' (the first passkey account created via the private path); its session resolves to admin
// at auth time (role/plan/features all reflect it). A plain account can never self-promote, and the
// stored owner is NEVER admin over the public edge. Distinct rows per test since this file keeps its
// user rows (no per-test cleanup).
describe("owner designation (#191)", () => {
  function accountRow(role: "admin" | "account"): string {
    const u = db
      .insert(users)
      .values({ login: `owner-e2e-${Math.random()}`, role, accessGrantedAt: new Date() })
      .returning()
      .get();
    return createSession({ userId: u.id }).token;
  }
  const me = (token: string, extra: Record<string, string> = {}) =>
    fetchApp("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${token}`, ...extra } });

  test("the stored-admin owner resolves to admin (role admin, via owner, plan owner, owner-feature on)", async () => {
    const token = accountRow("admin");
    const body = (await (await me(token)).json()) as { role: string; via: string; plan: string; features: Record<string, boolean> };
    expect(body.role).toBe("admin");
    expect(body.via).toBe("owner");
    expect(body.plan).toBe("owner");
    expect(body.features["admin.accounts"]).toBe(true);
  });

  test("a plain account stays an account — no self-promotion", async () => {
    const token = accountRow("account");
    const body = (await (await me(token)).json()) as { role: string; via: string; features: Record<string, boolean> };
    expect(body.role).toBe("account");
    expect(body.via).toBe("session");
    expect(body.features["admin.accounts"]).toBe(false);
  });

  test("the stored owner is NEVER admin via the public edge (cf-connecting-ip) — a public request can't be admin", async () => {
    const token = accountRow("admin");
    const body = (await (await me(token, { "cf-connecting-ip": "203.0.113.5" })).json()) as { role: string; via: string };
    expect(body.role).toBe("account"); // stored admin, but the edge forces non-admin
    expect(body.via).toBe("session");
  });
});

describe("PUT /api/settings", () => {
  test("persists theme + lang on the user row", async () => {
    const login = "settings-admin@github";
    // Establish the user via a /api/me call (get-or-create), then update settings.
    await fetchApp("/api/me", { headers: adminHeaders(login) });
    const res = await fetchApp("/api/settings", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({ theme: "midnight", lang: "pt" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });

    const row = db.select().from(users).where(eq(users.login, login)).get();
    expect(row?.theme).toBe("midnight");
    expect(row?.lang).toBe("pt");
  });

  test("an empty body is a no-op that still returns ok", async () => {
    const login = "settings-noop@github";
    await fetchApp("/api/me", { headers: adminHeaders(login) });
    const res = await fetchApp("/api/settings", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const row = db.select().from(users).where(eq(users.login, login)).get();
    expect(row?.theme ?? null).toBeNull();
    expect(row?.lang ?? null).toBeNull();
  });

  test("only the provided field is updated; the malformed-json path falls back to {}", async () => {
    const login = "settings-partial@github";
    await fetchApp("/api/me", { headers: adminHeaders(login) });
    // theme only
    await fetchApp("/api/settings", { method: "PUT", headers: { ...adminHeaders(login), "content-type": "application/json" }, body: JSON.stringify({ theme: "solar" }) });
    expect(db.select().from(users).where(eq(users.login, login)).get()?.theme).toBe("solar");
    // malformed json → c.req.json().catch(() => ({})) → no patch, still ok
    const res = await fetchApp("/api/settings", { method: "PUT", headers: { ...adminHeaders(login), "content-type": "application/json" }, body: "{bad" });
    expect(res.status).toBe(200);
    expect(db.select().from(users).where(eq(users.login, login)).get()?.theme).toBe("solar"); // unchanged
  });

  test("401 without a credential", async () => {
    const res = await fetchApp("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: "x" }) });
    expect(res.status).toBe(401);
  });

  test("persists normalized preferences and merges partial patches (#11)", async () => {
    const login = "settings-prefs@github";
    await fetchApp("/api/me", { headers: adminHeaders(login) });

    // First write: a persona name + a visual density, plus a hostile oversized field.
    await fetchApp("/api/settings", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({
        preferences: { persona: { name: "  Leo  ", extra: "z".repeat(5000) }, visual: { density: "compact" } },
      }),
    });
    let stored = JSON.parse(db.select().from(users).where(eq(users.login, login)).get()!.preferences!);
    expect(stored.persona.name).toBe("Leo"); // trimmed
    expect(stored.persona.extra.length).toBe(600); // capped
    expect(stored.visual.density).toBe("compact");

    // Second write: only patch behavior — the earlier persona/visual must survive the merge.
    await fetchApp("/api/settings", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({ preferences: { behavior: { enterToSend: false } } }),
    });
    stored = JSON.parse(db.select().from(users).where(eq(users.login, login)).get()!.preferences!);
    expect(stored.persona.name).toBe("Leo"); // preserved across the partial merge
    expect(stored.visual.density).toBe("compact"); // preserved
    expect(stored.behavior.enterToSend).toBe(false); // applied
  });

  test("unknown enum / bad types in preferences degrade to defaults, never stored raw", async () => {
    const login = "settings-prefs-junk@github";
    await fetchApp("/api/me", { headers: adminHeaders(login) });
    await fetchApp("/api/settings", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({ preferences: { visual: { mainFont: "wingdings" }, accessibility: { fontScale: 999 } } }),
    });
    const stored = JSON.parse(db.select().from(users).where(eq(users.login, login)).get()!.preferences!);
    expect(stored.visual.mainFont).toBe("sans"); // fell back
    expect(stored.accessibility.fontScale).toBe(1.4); // clamped to max
  });
});

describe("GET /api/me preferences (#11)", () => {
  test("returns normalized defaults when the column is null", async () => {
    const res = await fetchApp("/api/me", { headers: adminHeaders("me-prefs-default@github") });
    const body = (await res.json()) as { preferences: { visual: { mainFont: string }; behavior: { enterToSend: boolean } } };
    expect(body.preferences.visual.mainFont).toBe("sans");
    expect(body.preferences.behavior.enterToSend).toBe(true);
  });

  test("reflects a stored preference", async () => {
    const login = "me-prefs-stored@github";
    await fetchApp("/api/me", { headers: adminHeaders(login) });
    await fetchApp("/api/settings", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({ preferences: { persona: { name: "Leo" } } }),
    });
    const res = await fetchApp("/api/me", { headers: adminHeaders(login) });
    const body = (await res.json()) as { preferences: { persona: { name: string } } };
    expect(body.preferences.persona.name).toBe("Leo");
  });
});

// Account handles (#189) — the dedicated set/change route (returns real HTTP codes) + the /api/me
// exposure. `setHandle`'s validation/uniqueness logic is unit-tested in settings/handle.test.ts;
// these cover the HTTP wiring end-to-end through the real auth gate.
describe("PUT /api/settings/handle", () => {
  test("sets a valid handle (lowercased) and echoes it back", async () => {
    const login = "handle-set@github";
    await fetchApp("/api/me", { headers: adminHeaders(login) });
    const res = await fetchApp("/api/settings/handle", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({ handle: "Leo_42" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; handle: string }).toEqual({ ok: true, handle: "leo_42" });
    expect(db.select().from(users).where(eq(users.login, login)).get()?.handle).toBe("leo_42");
  });

  test("a bad charset / length is a 400 with the typed error, and no write", async () => {
    const login = "handle-bad@github";
    await fetchApp("/api/me", { headers: adminHeaders(login) });
    const charset = await fetchApp("/api/settings/handle", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({ handle: "no spaces" }),
    });
    expect(charset.status).toBe(400);
    expect((await charset.json()) as { ok: boolean; error: string }).toEqual({ ok: false, error: "charset" });
    const short = await fetchApp("/api/settings/handle", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({ handle: "ab" }),
    });
    expect(short.status).toBe(400);
    expect((await short.json()) as { ok: boolean; error: string }).toEqual({ ok: false, error: "length" });
    expect(db.select().from(users).where(eq(users.login, login)).get()?.handle ?? null).toBeNull();
  });

  test("a collision with another account is a 409 `taken`", async () => {
    // Account A claims "shared".
    const { token: tokenA } = makeAccountSession();
    await fetchApp("/api/settings/handle", {
      method: "PUT",
      headers: { cookie: `${SESSION_COOKIE}=${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ handle: "shared" }),
    });
    // Account B tries the same handle (different case) → conflict.
    const { token: tokenB, userId: userB } = makeAccountSession();
    const res = await fetchApp("/api/settings/handle", {
      method: "PUT",
      headers: { cookie: `${SESSION_COOKIE}=${tokenB}`, "content-type": "application/json" },
      body: JSON.stringify({ handle: "SHARED" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { ok: boolean; error: string }).toEqual({ ok: false, error: "taken" });
    expect(db.select().from(users).where(eq(users.id, userB)).get()?.handle ?? null).toBeNull();
  });

  test("401 without a credential", async () => {
    const res = await fetchApp("/api/settings/handle", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "leo" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/me handle (#189)", () => {
  test("carries the handle (null until set, then the stored value)", async () => {
    const login = "me-handle@github";
    let res = await fetchApp("/api/me", { headers: adminHeaders(login) });
    let body = (await res.json()) as { user: { handle: string | null } };
    expect(body.user.handle).toBeNull();
    await fetchApp("/api/settings/handle", {
      method: "PUT",
      headers: { ...adminHeaders(login), "content-type": "application/json" },
      body: JSON.stringify({ handle: "leo" }),
    });
    res = await fetchApp("/api/me", { headers: adminHeaders(login) });
    body = (await res.json()) as { user: { handle: string | null } };
    expect(body.user.handle).toBe("leo");
  });
});

// User directory (#190) — GET /api/users. The query/shape logic is unit-tested in
// settings/directory.test.ts; these cover the HTTP wiring end-to-end through the real auth gate:
// authed-only, public-fields-only (never email/login/plan), the ?q= search, and self-exclusion.
describe("GET /api/users (directory)", () => {
  // Insert an account row with a handle (+ optional display name) so it shows up in the directory.
  function seedAccount(handle: string, over: { displayName?: string | null; email?: string | null } = {}): string {
    const u = db
      .insert(users)
      .values({
        login: `acct_${crypto.randomUUID()}`,
        role: "account",
        handle,
        displayName: over.displayName ?? null,
        email: over.email ?? null,
        accessGrantedAt: new Date(),
      })
      .returning()
      .get();
    return u.id;
  }

  test("401 without a credential (authed-only)", async () => {
    const res = await fetchApp("/api/users");
    expect(res.status).toBe(401);
  });

  test("lists handle-set accounts (public fields only), excluding the caller", async () => {
    const { token, userId } = makeAccountSession();
    db.update(users).set({ handle: "caller_self" }).where(eq(users.id, userId)).run();
    seedAccount("alice", { displayName: "Alice A" });
    seedAccount("bob");

    const res = await fetchApp("/api/users", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { id: string; handle: string; name: string }[] };
    const handles = body.users.map((u) => u.handle);
    expect(handles).toContain("alice");
    expect(handles).toContain("bob");
    expect(handles).not.toContain("caller_self"); // self-excluded
    // Each row carries EXACTLY id + handle + name — nothing private.
    for (const u of body.users) {
      expect(Object.keys(u).sort()).toEqual(["handle", "id", "name"]);
    }
    const alice = body.users.find((u) => u.handle === "alice")!;
    expect(alice.name).toBe("Alice A"); // display-name precedence
  });

  test("NEVER leaks email / login / plan / private fields", async () => {
    const { token, userId } = makeAccountSession();
    db.update(users).set({ handle: "caller" }).where(eq(users.id, userId)).run();
    seedAccount("secretive", { displayName: "Public Name", email: "private@secret.test" });

    const res = await fetchApp("/api/users", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    const raw = await res.text();
    // The whole serialized response must contain none of the private identifiers.
    expect(raw).not.toContain("@secret.test");
    expect(raw).not.toContain("acct_"); // the synthetic login slug
    expect(raw).not.toContain("plan");
    expect(raw).not.toContain("email");
    expect(raw).not.toContain("login");
  });

  test("?q= filters over handle + display name, case-insensitively", async () => {
    const { token, userId } = makeAccountSession();
    db.update(users).set({ handle: "caller2" }).where(eq(users.id, userId)).run();
    // Distinctive needle so leftover rows from earlier tests in this shared DB can't collide.
    seedAccount("wobbler_dev");
    seedAccount("someone_x", { displayName: "Wobbler Prime" });
    seedAccount("unrelated_x", { displayName: "Nobody" });

    const res = await fetchApp("/api/users?q=WOBBLER", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    const body = (await res.json()) as { users: { handle: string }[] };
    const handles = body.users.map((u) => u.handle).sort();
    expect(handles).toEqual(["someone_x", "wobbler_dev"]); // handle hit + display-name hit
    expect(handles).not.toContain("unrelated_x");
  });
});

describe("GET /health (public probe)", () => {
  test("returns ok without any credential", async () => {
    const res = await fetchApp("/health");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; service: string }).toMatchObject({ ok: true, service: "a7t-chat" });
  });
});


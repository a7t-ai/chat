import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Context, Next } from "hono";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import type { AuthContext } from "./middleware.ts";
import { authMiddleware } from "./middleware.ts";
import { SESSION_COOKIE } from "./cookie.ts";
import { createSession, SESSION_TTL_DAYS } from "./session.service.ts";

// SECURITY-CRITICAL: the auth gate (#191). The blanket Tailscale-header auto-admin was REMOVED —
// everyone authenticates by passkey (#169) and admin is conferred ONLY two ways: the owner account —
// the FIRST passkey account created via the private path, which STORED `role='admin'` at sign-up,
// resolved on its session — or the LOCAL break-glass bootstrap (DEV_ADMIN_LOGIN). BOTH admin paths are
// gated on the public-edge discriminator: a request that arrived via the public edge (cloudflared
// injects `cf-connecting-ip` / a configured edge marker) can NEVER be admin. These tests pin: no
// self-promotion to owner, the discriminator stays byte-for-byte sound, a now-inert Tailscale header
// grants nothing, and the Bearer/guest tier (RETIRED) is not a credential (→ 401).

const TS = "tailscale-user-login"; // a now-INERT header — the trusted-header admin path was removed (#191)
const EDGE_HEADER = config.auth.edgeMarkerHeader; // "x-a7t-edge"

// A minimal fake Hono Context: authMiddleware only touches c.req.header / c.set / c.json.
type FakeResult = {
  auth: AuthContext | null;
  nextCalled: boolean;
  response: { body: unknown; status: number } | null;
};

async function run(headers: Record<string, string>, path = "/api/me", method = "GET"): Promise<FakeResult> {
  // Header lookups in Hono are case-insensitive; normalize keys to lowercase so callers
  // can pass any casing (mirrors how a real proxy/client would).
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const result: FakeResult = { auth: null, nextCalled: false, response: null };
  const next: Next = (async () => {
    result.nextCalled = true;
  }) as unknown as Next;

  // hono/cookie's getCookie reads c.req.raw.headers, so back the fake context with a real
  // Request carrying the same headers (the Cookie header in particular).
  const raw = new Request(`http://127.0.0.1${path}`, { headers: lower, method });

  const c = {
    req: {
      path,
      raw,
      method,
      header: (name: string): string | undefined => lower[name.toLowerCase()],
    },
    set: (key: string, value: unknown) => {
      if (key === "auth") result.auth = value as AuthContext;
    },
    json: (body: unknown, status: number) => {
      result.response = { body, status };
      return { __isResponse: true } as unknown as Response;
    },
  } as unknown as Context;

  const ret = await authMiddleware(c, next);
  // When the gate rejects, authMiddleware returns the Response from c.json (and never
  // calls next). When it admits, it returns next()'s result (void) after calling next.
  if (ret && !result.nextCalled) {
    // already captured via the json() spy
  }
  return result;
}

beforeEach(() => {
  // Each test controls config knobs explicitly. config is `as const`, so cast to mutate.
  const a = config.auth as unknown as {
    devAdminLogin: string;
    edgeMarkerSecret: string;
  };
  a.devAdminLogin = "";
  a.edgeMarkerSecret = "";
});

// The removed Tailscale-header path (#191) — a `tailscale-user-login` header now grants NOTHING. No
// admin, no user row created; it falls straight through to the wall like any unknown header.
describe("REMOVED — the Tailscale identity header is inert", () => {
  test("a tailscale-user-login header alone → the wall (401), no user created", async () => {
    const r = await run({ [TS]: "leo@github", "tailscale-user-name": "Leo Cardoso" });
    expect(r.nextCalled).toBe(false);
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
    expect(db.select().from(users).where(eq(users.login, "leo@github")).get()).toBeUndefined();
  });

  test("even from the authentic (non-edge) path, the header is not trusted as admin", async () => {
    // No cf-connecting-ip (the old 'authentic Serve' case) — still the wall, because there is no
    // header-trust path anymore. Admin is only the stored-admin owner or the dev bootstrap.
    const r = await run({ [TS]: "someone@github" });
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
  });
});

describe("public share carve-out — the no-login watch path", () => {
  test("GET /api/share/:slug is admitted with NO credential (and sets no auth)", async () => {
    const r = await run({}, "/api/share/some-slug", "GET");
    expect(r.nextCalled).toBe(true);
    expect(r.response).toBeNull();
    expect(r.auth).toBeNull(); // public path: handlers must not read auth
  });

  test("GET /api/share/:slug/stream is admitted too", async () => {
    const r = await run({}, "/api/share/some-slug/stream", "GET");
    expect(r.nextCalled).toBe(true);
    expect(r.response).toBeNull();
  });

  test("a NON-GET under /api/share is NOT carved out (stays walled)", async () => {
    const r = await run({}, "/api/share/some-slug", "POST");
    expect(r.nextCalled).toBe(false);
    expect(r.response?.status).toBe(401);
  });

  test("the carve-out does not bleed past the /api/share/ prefix", async () => {
    // A look-alike path that merely contains the segment must still hit the wall.
    const r = await run({}, "/api/shares-secret", "GET");
    expect(r.nextCalled).toBe(false);
    expect(r.response?.status).toBe(401);
  });

  test("a forged Tailscale header on the share path is irrelevant — admitted as public, never admin", async () => {
    const r = await run({ [TS]: "attacker@evil", "cf-connecting-ip": "203.0.113.9" }, "/api/share/x", "GET");
    expect(r.nextCalled).toBe(true);
    expect(r.auth).toBeNull(); // public read, not an admin grant
  });

  test("POST /api/share/:slug/todo IS carved out (the one public write) with no auth", async () => {
    const r = await run({}, "/api/share/some-slug/todo", "POST");
    expect(r.nextCalled).toBe(true);
    expect(r.response).toBeNull();
    expect(r.auth).toBeNull(); // public write path: the route enforces the write token, not auth
  });

  test("the todo write carve-out is tightly bounded — sibling POST paths stay walled", async () => {
    // Only the exact /todo suffix is writable; anything else under a slug hits the wall.
    for (const path of ["/api/share/x/todo/extra", "/api/share/x/nottodo", "/api/share/x/stream"]) {
      const r = await run({}, path, "POST");
      expect(r.nextCalled).toBe(false);
      expect(r.response?.status).toBe(401);
    }
  });

  test("a forged Tailscale header on the todo write path is irrelevant — admitted as public, never admin", async () => {
    const r = await run({ [TS]: "attacker@evil", "cf-connecting-ip": "203.0.113.9" }, "/api/share/x/todo", "POST");
    expect(r.nextCalled).toBe(true);
    expect(r.auth).toBeNull();
  });
});

describe("public map read carve-out — the no-login shared-page map", () => {
  const MAP_GET_PATHS = ["/api/cap/map/geo", "/api/cap/map/basemap-status", "/api/cap/map/basemap.pmtiles"];

  test("the three read-only map GET routes are admitted with NO credential (and set no auth)", async () => {
    for (const path of MAP_GET_PATHS) {
      const r = await run({}, path, "GET");
      expect(r.nextCalled).toBe(true);
      expect(r.response).toBeNull();
      expect(r.auth).toBeNull(); // public path: handlers must not read auth
    }
  });

  test("a NON-GET on a carved-out map route stays walled (read-only)", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await run({}, "/api/cap/map/geo", method);
      expect(r.nextCalled).toBe(false);
      expect(r.response?.status).toBe(401);
    }
  });

  test("any OTHER /api/cap/* route stays walled — the carve-out is not a blanket capability opening", async () => {
    for (const path of ["/api/cap/map", "/api/cap/map/basemap", "/api/cap/research/search", "/api/cap/map/geo/extra"]) {
      const r = await run({}, path, "GET");
      expect(r.nextCalled).toBe(false);
      expect(r.response?.status).toBe(401);
    }
  });

  test("a forged Tailscale header on a map read path is irrelevant — admitted as public, never admin", async () => {
    const r = await run({ [TS]: "attacker@evil", "cf-connecting-ip": "203.0.113.9" }, "/api/cap/map/geo", "GET");
    expect(r.nextCalled).toBe(true);
    expect(r.auth).toBeNull(); // public read, not an admin grant
  });
});

describe("public billing webhook carve-out (#13)", () => {
  test("POST /api/billing/webhook is admitted with NO credential (and sets no auth)", async () => {
    const r = await run({}, "/api/billing/webhook", "POST");
    expect(r.nextCalled).toBe(true);
    expect(r.response).toBeNull();
    expect(r.auth).toBeNull(); // public path: the route enforces the HMAC signature, not auth
  });

  test("a GET on the webhook path is NOT carved out (webhook is POST-only) → walled", async () => {
    const r = await run({}, "/api/billing/webhook", "GET");
    expect(r.nextCalled).toBe(false);
    expect(r.response?.status).toBe(401);
  });

  test("the rest of /api/billing stays gated (only the exact webhook path is public)", async () => {
    for (const path of ["/api/billing", "/api/billing/checkout", "/api/billing/webhook/extra"]) {
      const r = await run({}, path, "POST");
      expect(r.nextCalled).toBe(false);
      expect(r.response?.status).toBe(401);
    }
  });

  test("a forged Tailscale header on the webhook path is irrelevant — admitted as public, never admin", async () => {
    const r = await run({ [TS]: "attacker@evil", "cf-connecting-ip": "203.0.113.9" }, "/api/billing/webhook", "POST");
    expect(r.nextCalled).toBe(true);
    expect(r.auth).toBeNull();
  });
});

// The public-edge discriminator is the hard non-admin rule for BOTH admin paths. We probe it here
// through the dev bootstrap (the simplest admin trigger); the owner path is probed the same way in
// the owner describe below. `viaEdge` = cf-connecting-ip present OR a matching edge marker.
describe("EDGE-FORGERY DEFENSE — the discriminator (bootstrap admin)", () => {
  test("dev bootstrap + cf-connecting-ip → NOT admin (falls to the wall)", async () => {
    (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = "dev@local";
    const r = await run({ "cf-connecting-ip": "203.0.113.7" });
    expect(r.auth).toBeNull(); // a public-edge request can never be admin
    expect(r.nextCalled).toBe(false);
    expect(r.response?.status).toBe(401);
    // and the bootstrap did not create its admin row from the edge
    expect(db.select().from(users).where(eq(users.login, "dev@local")).get()).toBeUndefined();
  });

  test("dev bootstrap + explicit matching edge marker → NOT admin", async () => {
    (config.auth as unknown as { devAdminLogin: string; edgeMarkerSecret: string }).devAdminLogin = "dev@local";
    (config.auth as unknown as { edgeMarkerSecret: string }).edgeMarkerSecret = "s3cr3t";
    const r = await run({ [EDGE_HEADER]: "s3cr3t" });
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
  });

  test("edge marker present but WRONG value (and no cf-ip) → NOT via edge → dev bootstrap admin", async () => {
    // The marker only disqualifies when it MATCHES the configured secret. A wrong value is treated
    // as "not via edge" (a misconfigured/attacker-supplied marker can't lock out the private path).
    (config.auth as unknown as { devAdminLogin: string; edgeMarkerSecret: string }).devAdminLogin = "dev@local";
    (config.auth as unknown as { edgeMarkerSecret: string }).edgeMarkerSecret = "s3cr3t";
    const r = await run({ [EDGE_HEADER]: "wrong" });
    expect(r.auth?.role).toBe("admin");
  });

  test("edge marker present but secret NOT configured (empty) → marker ignored → dev bootstrap admin", async () => {
    // edgeMarkerSecret defaults to "" → the `length > 0` guard means a stray marker header can never
    // flip the viaEdge bit. Only cf-connecting-ip does in the default config.
    (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = "dev@local";
    const r = await run({ [EDGE_HEADER]: "anything" });
    expect(r.auth?.role).toBe("admin");
  });

  test("cf-connecting-ip empty-string still counts as 'present' → NOT admin", async () => {
    // Defense is `!== undefined`: any value, even "", means the edge proxy added it.
    (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = "dev@local";
    const r = await run({ "cf-connecting-ip": "" });
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
  });

  test("via edge + a Bearer token → still the wall (the Bearer/guest tier is retired)", async () => {
    const r = await run({ [TS]: "forged@evil", "cf-connecting-ip": "1.2.3.4", authorization: "Bearer a7t_anything" });
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
  });
});

describe("tier 1b — dev admin convenience", () => {
  test("devAdminLogin set + no edge → admin via 'dev'", async () => {
    (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = "dev@local";
    const r = await run({});
    expect(r.auth?.role).toBe("admin");
    expect(r.auth?.via).toBe("dev");
    expect(r.auth?.user.login).toBe("dev@local");
    expect(r.auth?.user.displayName).toBe("Dev Admin");
  });

  test("devAdminLogin is NOT honored via the edge", async () => {
    (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = "dev@local";
    const r = await run({ "cf-connecting-ip": "9.9.9.9" });
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
  });

  test("promotes a pre-existing non-admin row that matches the bootstrap login", async () => {
    db.insert(users).values({ login: "promote-me@local", role: "guest" }).run();
    (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = "promote-me@local";
    const r = await run({});
    expect(r.auth?.role).toBe("admin");
    expect(db.select().from(users).where(eq(users.login, "promote-me@local")).get()?.role).toBe("admin");
  });
});

// The Bearer/guest-key tier was RETIRED. A Bearer credential is no longer recognized — it must
// fall through to the wall like any other unknown credential (no enumeration, no token lookup).
describe("RETIRED — Bearer token is no longer a credential", () => {
  test("a Bearer token → 401 (the token tier is gone)", async () => {
    const r = await run({ authorization: "Bearer a7t_anything_at_all" });
    expect(r.nextCalled).toBe(false);
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
  });

  test("a Bearer token alongside no other credential is still just the wall", async () => {
    const r = await run({ authorization: "Bearer a7t_does_not_exist" });
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
    expect((r.response?.body as { error: string }).error).toBe("credential required");
  });
});

describe("the wall", () => {
  test("no credentials at all → 401 wall", async () => {
    const r = await run({});
    expect(r.nextCalled).toBe(false);
    expect(r.response?.status).toBe(401);
    expect((r.response?.body as { error: string }).error).toBe("credential required");
  });

  test("non-Bearer Authorization scheme is ignored → 401", async () => {
    const r = await run({ authorization: "Basic dXNlcjpwYXNz" });
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
  });
});

// The passkey front door (#169, #191), gated to the PRIVATE PATH. The availability probe, the sign-up
// ceremony (creates an account), and the sign-in ceremony are reachable with NO credential, but ONLY
// when the request did not arrive via the public edge: this hosted instance is private, so the public
// cloudflared edge must never create or log into an account. Over the edge these paths fall through to
// the 401 wall (the closed exposure: account creation used to be reachable over the edge). Every OTHER
// passkey route (authed register/list/delete) stays walled regardless.
describe("passkey front door, private-path only (#169, #191)", () => {
  const PASSKEY_CASES: [string, string][] = [
    ["/api/auth/passkey/available", "GET"],
    ["/api/auth/passkey/signup/options", "POST"],
    ["/api/auth/passkey/signup/verify", "POST"],
    ["/api/auth/passkey/login/options", "POST"],
    ["/api/auth/passkey/login/verify", "POST"],
  ];

  test("on the private path (no edge marker) all five ceremonies are admitted with NO credential", async () => {
    for (const [path, method] of PASSKEY_CASES) {
      const r = await run({}, path, method);
      expect(r.nextCalled).toBe(true);
      expect(r.response).toBeNull();
      expect(r.auth).toBeNull(); // public path: the route itself enforces the ceremony, not auth
    }
  });

  test("over the PUBLIC EDGE (cf-connecting-ip) all five ceremonies hit the 401 wall: no signup, no login, not even the probe", async () => {
    for (const [path, method] of PASSKEY_CASES) {
      const r = await run({ "cf-connecting-ip": "203.0.113.9" }, path, method);
      expect(r.nextCalled).toBe(false); // NOT admitted over the edge
      expect(r.auth).toBeNull();
      expect(r.response?.status).toBe(401);
    }
  });

  test("signup over the edge is the exposure this fix closes: signup/options + signup/verify both wall", async () => {
    for (const path of ["/api/auth/passkey/signup/options", "/api/auth/passkey/signup/verify"]) {
      const r = await run({ "cf-connecting-ip": "203.0.113.9" }, path, "POST");
      expect(r.nextCalled).toBe(false);
      expect(r.response?.status).toBe(401);
    }
  });

  test("login + availability over the edge also wall (only shares/webhook/map stay public over the edge)", async () => {
    for (const [path, method] of [
      ["/api/auth/passkey/login/options", "POST"],
      ["/api/auth/passkey/login/verify", "POST"],
      ["/api/auth/passkey/available", "GET"],
    ] as [string, string][]) {
      const r = await run({ "cf-connecting-ip": "203.0.113.9" }, path, method);
      expect(r.nextCalled).toBe(false);
      expect(r.response?.status).toBe(401);
    }
  });

  test("a configured matching edge marker also walls the ceremonies (the edge-marker branch of viaEdge)", async () => {
    (config.auth as unknown as { edgeMarkerSecret: string }).edgeMarkerSecret = "s3cr3t";
    for (const [path, method] of PASSKEY_CASES) {
      const r = await run({ [EDGE_HEADER]: "s3cr3t" }, path, method);
      expect(r.nextCalled).toBe(false);
      expect(r.response?.status).toBe(401);
    }
  });

  test("a stray edge marker with NO configured secret cannot wall the private path: ceremonies still admitted", async () => {
    // edgeMarkerSecret defaults to "" so a stray marker header can't flip viaEdge; the private path holds.
    const r = await run({ [EDGE_HEADER]: "anything" }, "/api/auth/passkey/signup/options", "POST");
    expect(r.nextCalled).toBe(true);
    expect(r.auth).toBeNull();
  });

  test("the authed passkey routes (register/list/delete) stay walled with no credential", async () => {
    const cases: [string, string][] = [
      ["/api/auth/passkey/register/options", "POST"],
      ["/api/auth/passkey/register/verify", "POST"],
      ["/api/auth/passkey", "GET"],
      ["/api/auth/passkey/some-id", "DELETE"],
      ["/api/auth/passkey/available", "POST"], // wrong method on the probe: not carved out
      ["/api/auth/passkey/signup/options", "GET"], // wrong method on sign-up: not carved out
    ];
    for (const [path, method] of cases) {
      const r = await run({}, path, method);
      expect(r.nextCalled).toBe(false);
      expect(r.response?.status).toBe(401);
    }
  });

  test("a now-inert Tailscale header on a private-path passkey ceremony changes nothing: still admitted, never admin", async () => {
    // The removed header (#191) grants nothing; without an edge marker this is still the private path.
    const r = await run({ [TS]: "attacker@evil" }, "/api/auth/passkey/signup/verify", "POST");
    expect(r.nextCalled).toBe(true);
    expect(r.auth).toBeNull();
  });
});

// The session-cookie tier — passkey login. An account with `accessGrantedAt` is a normal
// authenticated caller; a legacy account WITHOUT it is authenticated-but-ungated and may reach ONLY
// logout / me. Everything else under /api is 403 {error:"account_inactive"}.
describe("tier 1.5 — session cookie → account user", () => {
  let un = 0;
  function makeAccount(opts: { access?: boolean } = {}): { token: string; userId: string } {
    const u = db
      .insert(users)
      .values({
        login: `acct-${process.pid}-${un++}`,
        email: `acct-${process.pid}-${un}@a7t.test`,
        role: "account",
        emailVerifiedAt: new Date(),
        accessGrantedAt: opts.access ? new Date() : null,
      })
      .returning()
      .get();
    const { token } = createSession({ userId: u!.id });
    return { token, userId: u!.id };
  }
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

  afterEach(() => {
    db.delete(sessions).run();
    db.delete(users).run();
  });

  test("valid session + access granted → role 'account', accessGranted true, admitted", async () => {
    const { token, userId } = makeAccount({ access: true });
    const r = await run(cookie(token), "/api/conversations");
    expect(r.nextCalled).toBe(true);
    expect(r.response).toBeNull();
    expect(r.auth?.role).toBe("account");
    expect(r.auth?.via).toBe("session");
    expect(r.auth?.user.id).toBe(userId);
    expect((r.auth as { accessGranted: boolean }).accessGranted).toBe(true);
    expect(r.auth?.key).toBeNull();
  });

  test("ungated (legacy never-granted) account is BLOCKED on an app route → 403 account_inactive", async () => {
    const { token } = makeAccount({ access: false });
    const r = await run(cookie(token), "/api/conversations");
    expect(r.nextCalled).toBe(false);
    expect(r.response?.status).toBe(403);
    expect((r.response?.body as { error: string }).error).toBe("account_inactive");
    // The auth context is still set (it IS an authenticated user) before the gate fires.
    expect(r.auth?.role).toBe("account");
    expect((r.auth as { accessGranted: boolean }).accessGranted).toBe(false);
  });

  test("ungated account is ALLOWED on /api/me (the ungated carve-out)", async () => {
    const { token } = makeAccount({ access: false });
    const r = await run(cookie(token), "/api/me");
    expect(r.nextCalled).toBe(true);
    expect(r.response).toBeNull();
    expect(r.auth?.role).toBe("account");
  });

  test("expired session cookie → falls through to the wall (401), session GC'd", async () => {
    const u = db
      .insert(users)
      .values({ login: `acct-exp-${process.pid}`, email: `exp-${process.pid}@a7t.test`, role: "account" })
      .returning()
      .get();
    // Create a session that's already past its TTL by minting it in the deep past.
    const past = new Date(Date.now() - (SESSION_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    const { token } = createSession({ userId: u!.id, now: past });
    const r = await run(cookie(token), "/api/conversations");
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
    expect(db.select().from(sessions).all().length).toBe(0); // lazily GC'd on validate
  });

  test("unknown session token → wall (401)", async () => {
    const r = await run({ cookie: `${SESSION_COOKIE}=sess_nope` }, "/api/conversations");
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
  });

  test("session whose user row is gone → wall (401)", async () => {
    const { token, userId } = makeAccount({ access: true });
    db.delete(users).where(eq(users.id, userId)).run(); // cascades the session away
    const r = await run(cookie(token), "/api/conversations");
    expect(r.auth).toBeNull();
    expect(r.response?.status).toBe(401);
  });

  test("a now-inert Tailscale header alongside a session cookie changes nothing → still the account", async () => {
    // The removed header (#191) grants nothing; the session cookie decides the tier.
    const { token, userId } = makeAccount({ access: true });
    const r = await run({ ...cookie(token), [TS]: "leo@github" }, "/api/conversations");
    expect(r.auth?.role).toBe("account");
    expect(r.auth?.user.id).toBe(userId);
  });

  test("the dev bootstrap wins over a session cookie (order: bootstrap before session)", async () => {
    (config.auth as unknown as { devAdminLogin: string }).devAdminLogin = "dev@local";
    const { token } = makeAccount({ access: true });
    const r = await run(cookie(token), "/api/conversations");
    expect(r.auth?.role).toBe("admin");
    expect(r.auth?.via).toBe("dev");
  });
});

// Owner designation (#191) — the SECURITY-CRITICAL path. The owner is the account whose STORED role is
// 'admin' (the first passkey account created via the private path, stamped at sign-up); its session
// resolves to admin. Everyone else is a plain account (no self-promotion), and the owner is NEVER admin
// via the public edge — a stored-admin request over the edge is treated as a plain account. Owner
// resolution does NOT depend on accessGrantedAt (the owner can't be locked out by a stray flag).
describe("owner designation by stored role (#191)", () => {
  let un = 0;
  function makeUser(opts: { role?: "admin" | "account" | "guest"; access?: boolean; handle?: string | null } = {}): {
    token: string;
    userId: string;
  } {
    const u = db
      .insert(users)
      .values({
        login: `own-${process.pid}-${un++}`,
        handle: opts.handle ?? null,
        role: opts.role ?? "account",
        accessGrantedAt: opts.access === false ? null : new Date(),
      })
      .returning()
      .get();
    const { token } = createSession({ userId: u!.id });
    return { token, userId: u!.id };
  }
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

  afterEach(() => {
    db.delete(sessions).run();
    db.delete(users).run();
  });

  test("a stored role='admin' account (the owner) + non-edge session → admin via 'owner'", async () => {
    const { token, userId } = makeUser({ role: "admin" });
    const r = await run(cookie(token), "/api/conversations");
    expect(r.auth?.role).toBe("admin");
    expect(r.auth?.via).toBe("owner");
    expect(r.auth?.user.id).toBe(userId);
    expect(r.auth?.key).toBeNull();
  });

  test("the SAME stored-admin user via the public edge (cf-connecting-ip) → resolves to a plain account", async () => {
    // "A public request is never admin" is absolute: even the stored owner is downgraded over the edge.
    const { token, userId } = makeUser({ role: "admin" });
    const r = await run({ ...cookie(token), "cf-connecting-ip": "203.0.113.9" }, "/api/conversations");
    expect(r.auth?.role).toBe("account");
    expect(r.auth?.via).toBe("session");
    expect(r.auth?.user.id).toBe(userId);
  });

  test("the stored owner via a matching edge marker → resolves to a plain account", async () => {
    (config.auth as unknown as { edgeMarkerSecret: string }).edgeMarkerSecret = "s3cr3t";
    const { token } = makeUser({ role: "admin" });
    const r = await run({ ...cookie(token), [EDGE_HEADER]: "s3cr3t" }, "/api/conversations");
    expect(r.auth?.role).toBe("account");
  });

  test("a plain role='account' user (non-edge) stays an account — no self-promotion", async () => {
    const { token } = makeUser({ role: "account" });
    const r = await run(cookie(token), "/api/conversations");
    expect(r.auth?.role).toBe("account");
    expect(r.auth?.via).toBe("session");
  });

  test("the owner is admin regardless of handle (handle is public identity, not the designation)", async () => {
    // Designation is the stored role, so neither a null handle nor any particular handle matters.
    const { token: a } = makeUser({ role: "admin", handle: null });
    expect((await run(cookie(a), "/api/conversations")).auth?.role).toBe("admin");
    const { token: b } = makeUser({ role: "admin", handle: "anything" });
    expect((await run(cookie(b), "/api/conversations")).auth?.role).toBe("admin");
  });

  test("owner resolution does NOT require accessGrantedAt — a never-granted owner still gets in as admin", async () => {
    // The owner is defined solely by the stored admin role, so a stray access-flag state can't lock
    // them out. (A never-granted plain account, by contrast, is still walled — covered above.)
    const { token } = makeUser({ role: "admin", access: false });
    const r = await run(cookie(token), "/api/conversations");
    expect(r.auth?.role).toBe("admin");
    expect(r.auth?.via).toBe("owner");
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db/index.ts";
import { sessions, users, webauthnChallenges, webauthnCredentials } from "../../db/schema.ts";
import type { AuthContext } from "../middleware.ts";
import { authMiddleware } from "../middleware.ts";
import { SESSION_COOKIE } from "../cookie.ts";
import passkey from "./routes.ts";
import { makeAuthenticator } from "./testkit.ts";

// The passkey feature is DARK unless WEBAUTHN_RP_ID is set; the config helpers read it LIVE, so we
// set it for this file (and the authenticator uses the matching default rpId/origin).
const originalRpId = process.env.WEBAUTHN_RP_ID;
beforeAll(() => {
  process.env.WEBAUTHN_RP_ID = "a7t.chat";
});
afterAll(() => {
  if (originalRpId === undefined) delete process.env.WEBAUTHN_RP_ID;
  else process.env.WEBAUTHN_RP_ID = originalRpId;
});

// A test app that injects a chosen auth context (mirrors what the real middleware sets), then mounts
// the passkey sub-app exactly where server.ts does.
let currentAuth: AuthContext | null = null;
const app = new Hono();
app.use("*", async (c, next) => {
  if (currentAuth) c.set("auth", currentAuth);
  await next();
});
app.route("/api/auth/passkey", passkey);

afterEach(() => {
  currentAuth = null;
  db.delete(webauthnChallenges).run();
  db.delete(webauthnCredentials).run();
  db.delete(sessions).run();
  db.delete(users).run();
});

function makeAccount(accessGranted = true): AuthContext {
  const user = db
    .insert(users)
    .values({
      login: `acct-${Math.random().toString(36).slice(2)}`,
      email: `${Math.random().toString(36).slice(2)}@a7t.test`,
      role: "account",
      emailVerifiedAt: new Date(),
      accessGrantedAt: accessGranted ? new Date() : null,
    })
    .returning()
    .get();
  return { role: "account", via: "session", user: user!, key: null, accessGranted };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// Drive the whole register ceremony for `auth` with a fresh authenticator; returns it + the stored id.
async function registerPasskey(auth: AuthContext, authr = makeAuthenticator()) {
  currentAuth = auth;
  const optRes = await post("/api/auth/passkey/register/options", {});
  expect(optRes.status).toBe(200);
  const { options } = (await optRes.json()) as { options: { challenge: string } };
  const reg = authr.register({ challenge: options.challenge });
  const verifyRes = await post("/api/auth/passkey/register/verify", { ...reg, label: "Test Key" });
  return { authr, verifyRes, challenge: options.challenge };
}

describe("registration", () => {
  test("full register ceremony stores the credential to the caller", async () => {
    const auth = makeAccount();
    const { verifyRes } = await registerPasskey(auth);
    expect(verifyRes.status).toBe(200);
    const body = (await verifyRes.json()) as { ok: boolean; passkey: { id: string; label: string | null } };
    expect(body.ok).toBe(true);
    expect(body.passkey.label).toBe("Test Key");
    const rows = db.select().from(webauthnCredentials).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(auth.user.id);
  });

  test("register/options lists already-registered credentials in excludeCredentials", async () => {
    const auth = makeAccount();
    const { authr } = await registerPasskey(auth);
    currentAuth = auth;
    const optRes = await post("/api/auth/passkey/register/options", {});
    const { options } = (await optRes.json()) as { options: { excludeCredentials: { id: string }[] } };
    expect(options.excludeCredentials.map((c) => c.id)).toContain(authr.credentialIdB64u);
  });

  test("rejects a malformed body", async () => {
    currentAuth = makeAccount();
    const res = await post("/api/auth/passkey/register/verify", { attestationObject: 5 });
    expect(res.status).toBe(400);
  });

  test("rejects an unknown/forged challenge (not one we issued)", async () => {
    const auth = makeAccount();
    currentAuth = auth;
    const authr = makeAuthenticator();
    const reg = authr.register({ challenge: "never-issued" });
    const res = await post("/api/auth/passkey/register/verify", reg);
    expect(res.status).toBe(400);
  });

  test("rejects a challenge that was issued to a DIFFERENT account", async () => {
    const victim = makeAccount();
    const attacker = makeAccount();
    // The victim starts a registration → gets a challenge bound to them.
    currentAuth = victim;
    const optRes = await post("/api/auth/passkey/register/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    // The attacker tries to complete it on their own account.
    currentAuth = attacker;
    const reg = makeAuthenticator().register({ challenge: options.challenge });
    const res = await post("/api/auth/passkey/register/verify", reg);
    expect(res.status).toBe(400);
  });

  test("rejects a tampered attestation (bad origin) after a valid challenge", async () => {
    const auth = makeAccount();
    currentAuth = auth;
    const optRes = await post("/api/auth/passkey/register/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    const reg = makeAuthenticator().register({ challenge: options.challenge, origin: "https://evil.example" });
    const res = await post("/api/auth/passkey/register/verify", reg);
    expect(res.status).toBe(400);
  });
});

// Drive the PUBLIC sign-up ceremony (no prior auth) with a fresh authenticator. `headers` flow into
// BOTH ceremony POSTs so a test can simulate a public-edge sign-up (cf-connecting-ip present) — the
// owner-bootstrap discriminator (#191) reads it off signup/verify.
async function signUp(authr = makeAuthenticator(), headers: Record<string, string> = {}) {
  currentAuth = null; // public sign-up: a visitor with no account
  const optRes = await post("/api/auth/passkey/signup/options", {}, headers);
  expect(optRes.status).toBe(200);
  const { options } = (await optRes.json()) as { options: { challenge: string; user: { id: string } } };
  const reg = authr.register({ challenge: options.challenge });
  const verifyRes = await post("/api/auth/passkey/signup/verify", { ...reg, label: "Signup Key" }, headers);
  return { authr, verifyRes, options };
}

describe("sign-up (#169) — passkey registration creates an account", () => {
  test("full sign-up ceremony CREATES a granted account + credential + session (no prior auth)", async () => {
    expect(db.select().from(users).all().length).toBe(0);
    const { authr, verifyRes } = await signUp();
    expect(verifyRes.status).toBe(200);
    expect(await verifyRes.json()).toEqual({ ok: true, status: "authed" });

    // Exactly one user row exists, access is granted DIRECTLY (no invite), and it carries no email.
    // (Role is asserted in the owner-bootstrap describe; here we only pin the account-creation mechanics,
    // so this stays role-agnostic — the first non-edge sign-up happens to be the owner.)
    const all = db.select().from(users).all();
    expect(all.length).toBe(1);
    const account = all[0]!;
    expect(account.accessGrantedAt).not.toBeNull();
    expect(account.email).toBeNull();
    // The credential is stored against the new account.
    const creds = db.select().from(webauthnCredentials).all();
    expect(creds.length).toBe(1);
    expect(creds[0]!.userId).toBe(account.id);
    expect(creds[0]!.credentialId).toBe(authr.credentialIdB64u);
    // A session was minted for the new account.
    expect(verifyRes.headers.get("set-cookie")).toContain(SESSION_COOKIE);
    const sess = db.select().from(sessions).all();
    expect(sess.length).toBe(1);
    expect(sess[0]!.userId).toBe(account.id);
  });

  test("after sign-up, the SAME passkey logs in as 'authed'", async () => {
    const { authr } = await signUp();
    currentAuth = null;
    const optRes = await post("/api/auth/passkey/login/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    const res = await post("/api/auth/passkey/login/verify", authr.assert({ challenge: options.challenge }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "authed" });
  });

  test("rejects a malformed body (400)", async () => {
    const res = await post("/api/auth/passkey/signup/verify", { attestationObject: 5 });
    expect(res.status).toBe(400);
    expect(db.select().from(users).all().length).toBe(0);
  });

  test("rejects a challenge we never issued (400) + creates no account", async () => {
    const reg = makeAuthenticator().register({ challenge: "never-issued" });
    const res = await post("/api/auth/passkey/signup/verify", reg);
    expect(res.status).toBe(400);
    expect(db.select().from(users).all().length).toBe(0);
  });

  test("an authed-register challenge (bound to an account) is REJECTED on signup/verify — the two paths can't cross", async () => {
    const auth = makeAccount();
    currentAuth = auth;
    const optRes = await post("/api/auth/passkey/register/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    // Try to spend that account-bound challenge to CREATE a brand-new account.
    currentAuth = null;
    const reg = makeAuthenticator().register({ challenge: options.challenge });
    const res = await post("/api/auth/passkey/signup/verify", reg);
    expect(res.status).toBe(400);
    // No NEW account was created (only the pre-existing makeAccount one remains).
    expect(db.select().from(users).where(eq(users.role, "account")).all().length).toBe(1);
  });

  test("rejects a tampered attestation (bad origin) + creates no account", async () => {
    currentAuth = null;
    const optRes = await post("/api/auth/passkey/signup/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    const reg = makeAuthenticator().register({ challenge: options.challenge, origin: "https://evil.example" });
    const res = await post("/api/auth/passkey/signup/verify", reg);
    expect(res.status).toBe(400);
    expect(db.select().from(users).all().length).toBe(0);
  });

  test("re-registering an already-stored credential → 409 and leaves NO orphan account", async () => {
    const { authr } = await signUp(); // credential now belongs to user #1
    const usersAfterFirst = db.select().from(users).all().length;
    // A second sign-up presenting the SAME credential id must 409 BEFORE any account is created.
    currentAuth = null;
    const optRes = await post("/api/auth/passkey/signup/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    const reg = authr.register({ challenge: options.challenge }); // same authr → same credentialId
    const res = await post("/api/auth/passkey/signup/verify", reg);
    expect(res.status).toBe(409);
    // No new user row was left behind (the pre-check runs before createPasskeyAccount).
    expect(db.select().from(users).all().length).toBe(usersAfterFirst);
  });
});

// Owner bootstrap (#191) — SECURITY-CRITICAL. The FIRST passkey account created via the PRIVATE
// (non-edge) path becomes the single owner (role='admin'); every later sign-up, and ANY sign-up that
// arrived via the public edge (cf-connecting-ip present), is a plain role='account'. So a public
// visitor can never steal ownership before the installer signs up on the tailnet, and no later
// sign-up can self-promote. The admin-existence check + the insert share one SQLite write transaction,
// so concurrent first-sign-ups yield exactly ONE owner.
describe("owner bootstrap (#191) — first non-edge sign-up is the owner", () => {
  test("first non-edge sign-up → role='admin' (owner); the second sign-up → role='account'", async () => {
    const { verifyRes: first } = await signUp();
    expect(first.status).toBe(200);
    const all1 = db.select().from(users).all();
    expect(all1.length).toBe(1);
    expect(all1[0]!.role).toBe("admin"); // the owner

    const { verifyRes: second } = await signUp(makeAuthenticator());
    expect(second.status).toBe(200);
    // Exactly ONE owner; the second account is plain.
    expect(db.select().from(users).where(eq(users.role, "admin")).all().length).toBe(1);
    expect(db.select().from(users).where(eq(users.role, "account")).all().length).toBe(1);
  });

  test("a first sign-up arriving VIA THE EDGE (cf-connecting-ip) → role='account', NOT owner", async () => {
    expect(db.select().from(users).all().length).toBe(0);
    const { verifyRes } = await signUp(makeAuthenticator(), { "cf-connecting-ip": "203.0.113.10" });
    expect(verifyRes.status).toBe(200);
    const all = db.select().from(users).all();
    expect(all.length).toBe(1);
    expect(all[0]!.role).toBe("account"); // a public-edge visitor can never claim ownership
    expect(db.select().from(users).where(eq(users.role, "admin")).all().length).toBe(0);
  });

  test("an edge sign-up leaves the owner slot empty → the NEXT non-edge sign-up becomes the owner", async () => {
    await signUp(makeAuthenticator(), { "cf-connecting-ip": "203.0.113.11" }); // account, never owner
    expect(db.select().from(users).where(eq(users.role, "admin")).all().length).toBe(0);
    const { verifyRes } = await signUp(makeAuthenticator()); // non-edge → claims the vacant slot
    expect(verifyRes.status).toBe(200);
    expect(db.select().from(users).where(eq(users.role, "admin")).all().length).toBe(1);
  });

  test("once an owner exists, a later non-edge sign-up is a plain account (no self-promotion)", async () => {
    await signUp(); // owner
    const { verifyRes } = await signUp(makeAuthenticator()); // non-edge, but owner already exists
    expect(verifyRes.status).toBe(200);
    expect(db.select().from(users).where(eq(users.role, "admin")).all().length).toBe(1);
  });

  test("best-effort concurrency: many simultaneous first sign-ups still yield exactly ONE owner", async () => {
    // SQLite serializes the write transactions, so the admin-existence check + the insert are atomic
    // per sign-up — the second-through-Nth transaction sees the first's committed owner row.
    await Promise.all(Array.from({ length: 5 }, () => signUp(makeAuthenticator())));
    expect(db.select().from(users).all().length).toBe(5);
    expect(db.select().from(users).where(eq(users.role, "admin")).all().length).toBe(1);
  });
});

describe("login", () => {
  test("full login ceremony mints a session for the credential owner", async () => {
    const auth = makeAccount();
    const { authr } = await registerPasskey(auth);

    currentAuth = null; // public login
    const optRes = await post("/api/auth/passkey/login/options", {});
    expect(optRes.status).toBe(200);
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    const assertion = authr.assert({ challenge: options.challenge });
    const res = await post("/api/auth/passkey/login/verify", assertion);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "authed" });
    // A session cookie was set + a session row exists for the owner.
    expect(res.headers.get("set-cookie")).toContain(SESSION_COOKIE);
    const sess = db.select().from(sessions).all();
    expect(sess.length).toBe(1);
    expect(sess[0]!.userId).toBe(auth.user.id);
  });

  test("a revoked owner still authenticates but as 'inactive' (the gate then walls it)", async () => {
    const auth = makeAccount(true);
    const { authr } = await registerPasskey(auth);
    // Simulate the admin revoking access after enrolment.
    db.update(users).set({ accessGrantedAt: null }).where(eq(users.id, auth.user.id)).run();

    currentAuth = null;
    const optRes = await post("/api/auth/passkey/login/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    const res = await post("/api/auth/passkey/login/verify", authr.assert({ challenge: options.challenge }));
    expect(await res.json()).toEqual({ ok: true, status: "inactive" });
  });

  test("rejects a malformed assertion body (400)", async () => {
    const res = await post("/api/auth/passkey/login/verify", { id: "x" });
    expect(res.status).toBe(400);
  });

  test("rejects an unknown credential with a generic 401", async () => {
    currentAuth = null;
    const optRes = await post("/api/auth/passkey/login/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    // A valid assertion, but the credential was never registered.
    const res = await post("/api/auth/passkey/login/verify", makeAuthenticator().assert({ challenge: options.challenge }));
    expect(res.status).toBe(401);
  });

  test("rejects a tampered signature with a generic 401", async () => {
    const auth = makeAccount();
    const { authr } = await registerPasskey(auth);
    currentAuth = null;
    const optRes = await post("/api/auth/passkey/login/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    const res = await post("/api/auth/passkey/login/verify", authr.assert({ challenge: options.challenge, tamperSignature: true }));
    expect(res.status).toBe(401);
    expect(db.select().from(sessions).all().length).toBe(0);
  });

  test("a login challenge is single-use (replay → 401)", async () => {
    const auth = makeAccount();
    const { authr } = await registerPasskey(auth);
    currentAuth = null;
    const optRes = await post("/api/auth/passkey/login/options", {});
    const { options } = (await optRes.json()) as { options: { challenge: string } };
    const assertion = authr.assert({ challenge: options.challenge });
    expect((await post("/api/auth/passkey/login/verify", assertion)).status).toBe(200);
    // Replaying the exact same assertion (challenge already consumed) fails.
    expect((await post("/api/auth/passkey/login/verify", assertion)).status).toBe(401);
  });

  test("rejects a clientDataJSON that isn't valid base64url JSON (401)", async () => {
    currentAuth = null;
    await post("/api/auth/passkey/login/options", {});
    const res = await post("/api/auth/passkey/login/verify", {
      id: "x",
      authenticatorData: "x",
      clientDataJSON: Buffer.from("garbage").toString("base64url"),
      signature: "x",
    });
    expect(res.status).toBe(401);
  });
});

describe("manage (list + delete)", () => {
  test("GET / lists the caller's passkeys; DELETE removes one", async () => {
    const auth = makeAccount();
    const { verifyRes } = await registerPasskey(auth);
    const { passkey: pk } = (await verifyRes.json()) as { passkey: { id: string } };

    currentAuth = auth;
    const listRes = await app.request("/api/auth/passkey", { method: "GET" });
    const listed = (await listRes.json()) as { available: boolean; passkeys: { id: string }[] };
    expect(listed.available).toBe(true);
    expect(listed.passkeys.map((p) => p.id)).toEqual([pk.id]);

    const delRes = await app.request(`/api/auth/passkey/${pk.id}`, { method: "DELETE" });
    expect(await delRes.json()).toEqual({ ok: true, removed: true });
    expect(db.select().from(webauthnCredentials).all().length).toBe(0);
  });

  test("a caller cannot delete another account's passkey (removed:false)", async () => {
    const owner = makeAccount();
    const { verifyRes } = await registerPasskey(owner);
    const { passkey: pk } = (await verifyRes.json()) as { passkey: { id: string } };
    const stranger = makeAccount();
    currentAuth = stranger;
    const delRes = await app.request(`/api/auth/passkey/${pk.id}`, { method: "DELETE" });
    expect(await delRes.json()).toEqual({ ok: true, removed: false });
    expect(db.select().from(webauthnCredentials).all().length).toBe(1);
  });
});

describe("availability + dark mode", () => {
  test("GET /available reflects configuration", async () => {
    const res = await app.request("/api/auth/passkey/available", { method: "GET" });
    expect(await res.json()).toEqual({ available: true });
  });

  test("every entry point is dark when WEBAUTHN_RP_ID is unset", async () => {
    delete process.env.WEBAUTHN_RP_ID;
    try {
      expect(await (await app.request("/api/auth/passkey/available", { method: "GET" })).json()).toEqual({ available: false });
      currentAuth = makeAccount();
      expect((await post("/api/auth/passkey/register/options", {})).status).toBe(503);
      expect((await post("/api/auth/passkey/register/verify", { attestationObject: "a", clientDataJSON: "b" })).status).toBe(503);
      const listed = (await (await app.request("/api/auth/passkey", { method: "GET" })).json()) as { available: boolean };
      expect(listed.available).toBe(false);
      currentAuth = null;
      expect((await post("/api/auth/passkey/login/options", {})).status).toBe(503);
      expect((await post("/api/auth/passkey/login/verify", { id: "a", authenticatorData: "b", clientDataJSON: "c", signature: "d" })).status).toBe(503);
    } finally {
      process.env.WEBAUTHN_RP_ID = "a7t.chat";
    }
  });

  test("per-IP rate limit surfaces a 429 on login/options", async () => {
    const headers = { "cf-connecting-ip": "203.0.113.77" };
    let last = 200;
    for (let i = 0; i < 40; i++) {
      last = (await post("/api/auth/passkey/login/options", {}, headers)).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe("auth gate carve-out (real middleware)", () => {
  const gated = new Hono();
  gated.use("/api/*", authMiddleware);
  gated.route("/api/auth/passkey", passkey);

  test("public login endpoints are reachable with NO credential", async () => {
    const res = await gated.request("/api/auth/passkey/login/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  test("the availability probe is public", async () => {
    const res = await gated.request("/api/auth/passkey/available", { method: "GET" });
    expect(res.status).toBe(200);
  });

  test("register/options is WALLED behind the gate (401 without a credential)", async () => {
    const res = await gated.request("/api/auth/passkey/register/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

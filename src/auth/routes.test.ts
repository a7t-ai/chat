import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { db } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import { SESSION_COOKIE } from "./cookie.ts";
import { authMiddleware } from "./middleware.ts";
import authRoutes from "./routes.ts";
import { createSession } from "./session.service.ts";

// Drive the real routes through a Hono app with the real middleware in front (mirrors server.ts).
// Email OTP + invites were removed (#169) — passkeys are the only credential and are exercised in
// webauthn/routes.test.ts — so the only thing that lives directly on /api/auth is logout.

const app = new Hono();
app.use("/api/*", authMiddleware);
app.route("/api/auth", authRoutes);

let n = 0;
function loginAccount(): { cookie: string; userId: string } {
  const u = db
    .insert(users)
    .values({ login: `route-${process.pid}-${n++}`, role: "account", accessGrantedAt: new Date() })
    .returning()
    .get();
  const { token } = createSession({ userId: u!.id });
  return { cookie: `${SESSION_COOKIE}=${token}`, userId: u!.id };
}

afterEach(() => {
  db.delete(sessions).run();
  db.delete(users).run();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /logout — public + idempotent", () => {
  test("destroys the session and clears the cookie", async () => {
    const { cookie } = loginAccount();
    expect(db.select().from(sessions).all().length).toBe(1);
    const res = await post("/api/auth/logout", {}, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Session row is gone, and a clearing Set-Cookie was emitted.
    expect(db.select().from(sessions).all().length).toBe(0);
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain(`${SESSION_COOKIE}=`);
  });

  test("logout without a cookie is a 200 no-op (a stale/expired session can always sign out)", async () => {
    const res = await post("/api/auth/logout", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("logout with an unknown token is a 200 no-op (idempotent, only clears the caller's own cookie)", async () => {
    const res = await post("/api/auth/logout", {}, { cookie: `${SESSION_COOKIE}=sess_does_not_exist` });
    expect(res.status).toBe(200);
  });
});

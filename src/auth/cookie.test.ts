import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SESSION_COOKIE, clearSessionCookie, setSessionCookie } from "./cookie.ts";
import { SESSION_TTL_DAYS } from "./session.service.ts";

// The session cookie's flags are a security control (httpOnly + Secure + SameSite=Lax). Pin
// them via a tiny Hono app so a regression in any flag fails the gate.

function appThatSets(): Hono {
  const app = new Hono();
  app.get("/set", (c) => {
    setSessionCookie(c, "sess_token_value");
    return c.text("ok");
  });
  app.get("/clear", (c) => {
    clearSessionCookie(c);
    return c.text("ok");
  });
  return app;
}

describe("setSessionCookie", () => {
  test("sets a7t_session with httpOnly + Secure + SameSite=Lax + Path=/ + Max-Age", async () => {
    const res = await appThatSets().request("/set");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain(`${SESSION_COOKIE}=sess_token_value`);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("Secure");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Path=/");
    expect(sc).toContain(`Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}`);
  });
});

describe("clearSessionCookie", () => {
  test("emits a clearing Set-Cookie for a7t_session (Max-Age=0 / past expiry)", async () => {
    const res = await appThatSets().request("/clear");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain(`${SESSION_COOKIE}=`);
    // deleteCookie sets Max-Age=0 (and/or an expiry in the past).
    expect(sc).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});

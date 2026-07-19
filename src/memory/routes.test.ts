import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SESSION_COOKIE } from "../auth/cookie.ts";
import { createSession } from "../auth/session.service.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { facts, memoryChunks, summaries, users } from "../db/schema.ts";
import server from "../server.ts";

// /api/memory — the archivist transparency + control surface (#27). Exercised end-to-end through
// the real server (auth gate included), so the scoping guarantees are tested where they matter.

function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(server.fetch(new Request(`http://localhost${path}`, init)));
}

function makeAccount(prefs?: string): string {
  return db
    .insert(users)
    .values({
      login: `mem-acct-${Math.random()}`,
      email: `${Math.random()}@a7t.test`,
      role: "account",
      accessGrantedAt: new Date(),
      ...(prefs ? { preferences: prefs } : {}),
    })
    .returning()
    .get()!.id;
}
function cookieFor(userId: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${createSession({ userId }).token}` };
}
function addFact(userId: string, content: string): string {
  return db.insert(facts).values({ userId, content }).returning().get()!.id;
}

beforeEach(() => {
  // Keep the admin paths (the dev bootstrap; the stored-admin owner is created explicitly, #191) out of
  // these account-session tests.
  const a = config.auth as unknown as { devAdminLogin: string; edgeMarkerSecret: string };
  a.devAdminLogin = "";
  a.edgeMarkerSecret = "";
});
afterEach(() => {
  db.delete(facts).run();
  db.delete(summaries).run();
  db.delete(memoryChunks).run();
});

describe("/api/memory — auth", () => {
  test("401 without a credential", async () => {
    expect((await fetchApp("/api/memory")).status).toBe(401);
  });
});

describe("GET /api/memory", () => {
  test("lists the caller's facts + the enabled flag", async () => {
    const u = makeAccount();
    addFact(u, "prefers concise answers");
    const res = await fetchApp("/api/memory", { headers: cookieFor(u) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; facts: { id: string; content: string; createdAt: string }[] };
    expect(body.enabled).toBe(true);
    expect(body.facts.map((f) => f.content)).toEqual(["prefers concise answers"]);
    expect(typeof body.facts[0]!.id).toBe("string");
  });

  test("reports enabled:false when the caller switched memory off", async () => {
    const u = makeAccount(JSON.stringify({ memory: { enabled: false } }));
    const res = await fetchApp("/api/memory", { headers: cookieFor(u) });
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
  });

  test("never shows another account's facts", async () => {
    const a = makeAccount();
    const b = makeAccount();
    addFact(a, "a's private fact");
    const res = await fetchApp("/api/memory", { headers: cookieFor(b) });
    expect(((await res.json()) as { facts: unknown[] }).facts).toEqual([]);
  });
});

describe("DELETE /api/memory/:id", () => {
  test("forgets the caller's own fact", async () => {
    const u = makeAccount();
    const id = addFact(u, "forget me");
    const res = await fetchApp(`/api/memory/${id}`, { method: "DELETE", headers: cookieFor(u) });
    expect(res.status).toBe(200);
    expect(db.select().from(facts).where(eq(facts.userId, u)).all()).toEqual([]);
  });

  test("cannot forget another account's fact — 404, and the fact survives", async () => {
    const a = makeAccount();
    const b = makeAccount();
    const id = addFact(a, "a's secret");
    const res = await fetchApp(`/api/memory/${id}`, { method: "DELETE", headers: cookieFor(b) });
    expect(res.status).toBe(404);
    expect(db.select().from(facts).where(eq(facts.id, id)).all().length).toBe(1);
  });

  test("an unknown id is a 404 (no existence oracle)", async () => {
    const u = makeAccount();
    const res = await fetchApp("/api/memory/nope", { method: "DELETE", headers: cookieFor(u) });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/memory", () => {
  test("clears all of the caller's derived memory and reports the count", async () => {
    const u = makeAccount();
    addFact(u, "f1");
    addFact(u, "f2");
    db.insert(memoryChunks).values({ userId: u, content: "c", embeddingModel: "bge-m3" }).run();
    const res = await fetchApp("/api/memory", { method: "DELETE", headers: cookieFor(u) });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; cleared: number }).toEqual({ ok: true, cleared: 2 });
    expect(db.select().from(facts).where(eq(facts.userId, u)).all()).toEqual([]);
    expect(db.select().from(memoryChunks).where(eq(memoryChunks.userId, u)).all()).toEqual([]);
  });

  test("leaves another account's memory untouched", async () => {
    const a = makeAccount();
    const b = makeAccount();
    addFact(a, "keep");
    await fetchApp("/api/memory", { method: "DELETE", headers: cookieFor(b) });
    expect(db.select().from(facts).where(eq(facts.userId, a)).all().length).toBe(1);
  });
});

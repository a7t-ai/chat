import { afterEach, describe, expect, test } from "bun:test";
import type { AuthContext } from "../auth/middleware.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { providerKeys, users } from "../db/schema.ts";
import { backend as janoBackend } from "../jano/client.ts";
import type { ChatChunk } from "../jano/types.ts";
import { canSpendByokModel, frontierBackendFor, resolveTurnBackend } from "./backend.ts";
import { setProviderKey } from "./service.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  db.delete(providerKeys).run();
  db.delete(users).run();
});

function sse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function makeAccount(): AuthContext {
  // Pin the plan to `free` (a NON-unlocking plan). The OSS build defaults accounts to `ultra` (#166),
  // so to exercise the dormant BYOK paywall we set a non-entitled plan explicitly; the entitled test
  // below opens BYOK via the `guestsAllowed` override, independent of the plan.
  const u = db.insert(users).values({ login: `byok-be-${Math.random()}`, role: "account", plan: "free" }).returning().get()!;
  return { role: "account", via: "session", user: u, key: null, accessGranted: true } as unknown as AuthContext;
}
const ADMIN = () => {
  const u = db.insert(users).values({ login: `byok-admin-${Math.random()}`, role: "admin" }).returning().get()!;
  return { role: "admin", via: "owner", user: u, key: null } as unknown as AuthContext;
};

async function drain(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("frontierBackendFor", () => {
  test("posts to the provider base with the caller's Bearer key and streams the reply", async () => {
    let seen: { url: string; auth: string | null; body: unknown } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        auth: new Headers(init.headers).get("authorization"),
        body: JSON.parse(init.body as string),
      };
      return sse([`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n`, "data: [DONE]\n"]);
    }) as unknown as typeof fetch;

    const be = frontierBackendFor("openai", "sk-test-key");
    const chunks = await drain(be.chat({ model: "gpt-4o", messages: [{ role: "user", content: "yo" }] }));

    expect(chunks).toEqual([{ type: "delta", text: "hi" }, { type: "done" }]);
    expect(seen!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen!.auth).toBe("Bearer sk-test-key");
    expect((seen!.body as { model: string; stream: boolean }).model).toBe("gpt-4o");
    expect((seen!.body as { stream: boolean }).stream).toBe(true);
  });

  test("noTrain adds store:false", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return sse(["data: [DONE]\n"]);
    }) as unknown as typeof fetch;
    await drain(frontierBackendFor("groq", "gsk_x").chat({ model: "llama", messages: [], noTrain: true }));
    expect(body.store).toBe(false);
  });

  test("complete returns the message content", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await frontierBackendFor("openai", "sk-x").complete({ model: "gpt-4o", messages: [] })).toBe("done");
  });

  test("listModels maps the data array", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o", label: "GPT-4o" }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await frontierBackendFor("openai", "sk-x").listModels()).toEqual([{ id: "gpt-4o", label: "GPT-4o" }]);
  });

  test("errors surface the status without the key", async () => {
    globalThis.fetch = (async () => new Response("bad", { status: 401 })) as unknown as typeof fetch;
    await expect(frontierBackendFor("openai", "sk-super-secret").complete({ model: "x", messages: [] })).rejects.toThrow(
      "openai complete -> 401",
    );
    await expect(frontierBackendFor("openai", "sk-super-secret").listModels()).rejects.toThrow("openai /models -> 401");
  });

  test("unknown provider is rejected", () => {
    expect(() => frontierBackendFor("acme", "k")).toThrow("unknown BYOK provider");
  });
});

describe("resolveTurnBackend", () => {
  test("entitled caller with a stored key routes to the frontier provider (stripped model)", () => {
    const admin = ADMIN();
    setProviderKey(admin.user.id, "openai", "sk-live-abcd");
    const turn = resolveTurnBackend(admin, "openai/gpt-4o");
    expect(turn.backend).not.toBe(janoBackend);
    expect(turn.upstreamModel).toBe("gpt-4o");
  });

  test("falls back to the local router for a plain model", () => {
    const admin = ADMIN();
    const turn = resolveTurnBackend(admin, "qwen-chat");
    expect(turn.backend).toBe(janoBackend);
    expect(turn.upstreamModel).toBe("qwen-chat");
  });

  test("falls back when the caller is entitled but has no key for that provider", () => {
    const admin = ADMIN();
    const turn = resolveTurnBackend(admin, "openai/gpt-4o");
    expect(turn.backend).toBe(janoBackend);
    expect(turn.upstreamModel).toBe("openai/gpt-4o");
  });

  test("a non-entitled account never reaches BYOK, even with a stored key", () => {
    const acct = makeAccount();
    setProviderKey(acct.user.id, "openai", "sk-live-abcd"); // key present, but no paywall entitlement
    const turn = resolveTurnBackend(acct, "openai/gpt-4o");
    expect(turn.backend).toBe(janoBackend);
    expect(turn.upstreamModel).toBe("openai/gpt-4o");
  });

  test("an entitled account (BYOK opened) with a key does route to the frontier", () => {
    const acct = makeAccount();
    setProviderKey(acct.user.id, "openai", "sk-live-abcd");
    (config.byok as unknown as { guestsAllowed: boolean }).guestsAllowed = true;
    try {
      const turn = resolveTurnBackend(acct, "openai/gpt-4o");
      expect(turn.backend).not.toBe(janoBackend);
      expect(turn.upstreamModel).toBe("gpt-4o");
    } finally {
      (config.byok as unknown as { guestsAllowed: boolean }).guestsAllowed = false;
    }
  });
});

describe("canSpendByokModel", () => {
  test("true for an entitled caller with a stored key for the provider", () => {
    const admin = ADMIN();
    setProviderKey(admin.user.id, "openai", "sk-live-abcd");
    expect(canSpendByokModel(admin, "openai/gpt-4o")).toBe(true);
  });

  test("false for a plain (non-provider) model id", () => {
    const admin = ADMIN();
    expect(canSpendByokModel(admin, "qwen-chat")).toBe(false);
  });

  test("false when the caller is entitled but has no key for that provider", () => {
    const admin = ADMIN();
    expect(canSpendByokModel(admin, "openai/gpt-4o")).toBe(false);
  });

  test("false for a non-entitled account even with a stored key", () => {
    const acct = makeAccount(); // plan free → BYOK paywall closed
    setProviderKey(acct.user.id, "openai", "sk-live-abcd");
    expect(canSpendByokModel(acct, "openai/gpt-4o")).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import {
  deletePasskey,
  fetchPasskeyAvailable,
  listPasskeys,
  loginWithPasskey,
  passkeySupported,
  registerPasskey,
  signUpWithPasskey,
} from "./webauthn";

// A small ArrayBuffer from a string (the WebAuthn responses are ArrayBuffers).
function ab(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

function jsonRes(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let createMock: ReturnType<typeof vi.fn>;
let getMock: ReturnType<typeof vi.fn>;

// Turn on WebAuthn support: a PublicKeyCredential ctor + a credentials store with create/get.
function enableSupport() {
  createMock = vi.fn();
  getMock = vi.fn();
  (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential = function () {};
  Object.defineProperty(navigator, "credentials", {
    value: { create: createMock, get: getMock },
    configurable: true,
    writable: true,
  });
}

function disableSupport() {
  delete (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  Object.defineProperty(navigator, "credentials", { value: undefined, configurable: true, writable: true });
}

const REG_OPTIONS = {
  options: {
    rp: { id: "a7t.chat", name: "a7t.chat" },
    user: { id: "AAAA", name: "u@a7t.test", displayName: "U" },
    challenge: "Y2hhbGxlbmdl",
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    excludeCredentials: [{ type: "public-key", id: "ZXhjbA" }],
  },
};
const LOGIN_OPTIONS = { options: { challenge: "Y2hhbGxlbmdl", rpId: "a7t.chat", userVerification: "required" } };

const REG_CREDENTIAL = {
  id: "cred-b64u",
  rawId: ab("raw"),
  type: "public-key",
  response: { attestationObject: ab("att"), clientDataJSON: ab("cdj"), getTransports: () => ["internal"] },
};
const LOGIN_CREDENTIAL = {
  id: "cred-b64u",
  rawId: ab("raw"),
  type: "public-key",
  response: { authenticatorData: ab("ad"), clientDataJSON: ab("cdj"), signature: ab("sig"), userHandle: ab("uh") },
};

beforeEach(() => {
  installLocalStorage();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  disableSupport();
});

describe("passkeySupported", () => {
  test("false without PublicKeyCredential", () => {
    disableSupport();
    expect(passkeySupported()).toBe(false);
  });
  test("true when the platform API is present", () => {
    enableSupport();
    expect(passkeySupported()).toBe(true);
  });
});

describe("fetchPasskeyAvailable", () => {
  test("true when the server reports available", async () => {
    fetchMock.mockResolvedValue(jsonRes({ available: true }));
    expect(await fetchPasskeyAvailable()).toBe(true);
  });
  test("false when unavailable / non-ok / thrown", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ available: false }));
    expect(await fetchPasskeyAvailable()).toBe(false);
    fetchMock.mockResolvedValueOnce(jsonRes({}, { status: 500 }));
    expect(await fetchPasskeyAvailable()).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error("net"));
    expect(await fetchPasskeyAvailable()).toBe(false);
  });
  test("false on a 401 (the public-edge case: the probe is gated to the private path), which drives the wall", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "credential required" }, { status: 401 }));
    expect(await fetchPasskeyAvailable()).toBe(false);
  });
});

describe("listPasskeys / deletePasskey", () => {
  test("listPasskeys returns the payload", async () => {
    fetchMock.mockResolvedValue(jsonRes({ available: true, passkeys: [{ id: "p1", label: null, createdAt: 1, lastUsedAt: null }] }));
    const out = await listPasskeys();
    expect(out.passkeys).toHaveLength(1);
  });
  test("listPasskeys throws on non-ok", async () => {
    fetchMock.mockResolvedValue(jsonRes({}, { status: 500 }));
    await expect(listPasskeys()).rejects.toThrow();
  });
  test("deletePasskey resolves on ok and throws on non-ok", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, removed: true }));
    await expect(deletePasskey("p1")).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(jsonRes({}, { status: 404 }));
    await expect(deletePasskey("p1")).rejects.toThrow();
  });
});

describe("registerPasskey", () => {
  test("unsupported browser", async () => {
    disableSupport();
    expect(await registerPasskey()).toEqual({ ok: false, reason: "unsupported" });
  });

  test("happy path: options → create → verify", async () => {
    enableSupport();
    createMock.mockResolvedValue(REG_CREDENTIAL);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/register/options")
        ? jsonRes(REG_OPTIONS)
        : jsonRes({ ok: true, passkey: { id: "p1", label: "Test", createdAt: 1, lastUsedAt: null } }),
    );
    const r = await registerPasskey("Test");
    expect(r).toEqual({ ok: true, passkey: { id: "p1", label: "Test", createdAt: 1, lastUsedAt: null } });
    // The create call received decoded ArrayBuffers, not the base64url strings.
    const arg = createMock.mock.calls[0][0].publicKey;
    expect(arg.challenge).toBeInstanceOf(ArrayBuffer);
    expect(arg.user.id).toBeInstanceOf(ArrayBuffer);
    expect(arg.excludeCredentials[0].id).toBeInstanceOf(ArrayBuffer);
  });

  test("options fetch failure → error", async () => {
    enableSupport();
    fetchMock.mockResolvedValue(jsonRes({}, { status: 503 }));
    expect(await registerPasskey()).toEqual({ ok: false, reason: "error" });
  });

  test("user cancels the OS prompt → cancelled", async () => {
    enableSupport();
    createMock.mockRejectedValue(new DOMException("cancelled", "NotAllowedError"));
    fetchMock.mockResolvedValue(jsonRes(REG_OPTIONS));
    expect(await registerPasskey()).toEqual({ ok: false, reason: "cancelled" });
  });

  test("null credential → cancelled", async () => {
    enableSupport();
    createMock.mockResolvedValue(null);
    fetchMock.mockResolvedValue(jsonRes(REG_OPTIONS));
    expect(await registerPasskey()).toEqual({ ok: false, reason: "cancelled" });
  });

  test("verify failure → error", async () => {
    enableSupport();
    createMock.mockResolvedValue(REG_CREDENTIAL);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/register/options") ? jsonRes(REG_OPTIONS) : jsonRes({}, { status: 409 }),
    );
    expect(await registerPasskey()).toEqual({ ok: false, reason: "error" });
  });

  test("handles a response with no getTransports", async () => {
    enableSupport();
    createMock.mockResolvedValue({ ...REG_CREDENTIAL, response: { attestationObject: ab("att"), clientDataJSON: ab("cdj") } });
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/register/options") ? jsonRes(REG_OPTIONS) : jsonRes({ ok: true, passkey: { id: "p2", label: null, createdAt: 2, lastUsedAt: null } }),
    );
    const r = await registerPasskey();
    expect(r.ok).toBe(true);
  });
});

// PUBLIC passkey SIGN-UP (#169) — creates the account + session. Mirrors registerPasskey but hits the
// /signup/* ceremony (no auth header, no excludeCredentials).
const SIGNUP_OPTIONS = {
  options: {
    rp: { id: "a7t.chat", name: "a7t.chat" },
    user: { id: "AAAA", name: "a7t.chat", displayName: "a7t.chat" },
    challenge: "Y2hhbGxlbmdl",
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  },
};

describe("signUpWithPasskey", () => {
  test("unsupported browser → unsupported", async () => {
    disableSupport();
    expect(await signUpWithPasskey()).toEqual({ ok: false, reason: "unsupported" });
  });

  test("happy path: signup/options → create → signup/verify creates the account", async () => {
    enableSupport();
    createMock.mockResolvedValue(REG_CREDENTIAL);
    const seen: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      seen.push(url);
      return url.includes("/signup/options") ? jsonRes(SIGNUP_OPTIONS) : jsonRes({ ok: true, status: "authed" });
    });
    const r = await signUpWithPasskey("My Laptop");
    expect(r).toEqual({ ok: true, status: "authed" });
    // It drove the PUBLIC signup ceremony, not the authed register one.
    expect(seen.some((u) => u.includes("/signup/options"))).toBe(true);
    expect(seen.some((u) => u.includes("/signup/verify"))).toBe(true);
    // The create call received decoded ArrayBuffers + an empty excludeCredentials (brand-new visitor).
    const arg = createMock.mock.calls[0][0].publicKey;
    expect(arg.challenge).toBeInstanceOf(ArrayBuffer);
    expect(arg.user.id).toBeInstanceOf(ArrayBuffer);
    expect(arg.excludeCredentials).toEqual([]);
  });

  test("a dark server (503 on options) → unavailable", async () => {
    enableSupport();
    fetchMock.mockResolvedValue(jsonRes({ error: "passkeys are not enabled" }, { status: 503 }));
    expect(await signUpWithPasskey()).toEqual({ ok: false, reason: "unavailable" });
  });

  test("options fetch non-503 failure → error", async () => {
    enableSupport();
    fetchMock.mockResolvedValue(jsonRes({}, { status: 500 }));
    expect(await signUpWithPasskey()).toEqual({ ok: false, reason: "error" });
  });

  test("user cancels the OS prompt → cancelled", async () => {
    enableSupport();
    createMock.mockRejectedValue(new DOMException("cancelled", "NotAllowedError"));
    fetchMock.mockResolvedValue(jsonRes(SIGNUP_OPTIONS));
    expect(await signUpWithPasskey()).toEqual({ ok: false, reason: "cancelled" });
  });

  test("null credential → cancelled", async () => {
    enableSupport();
    createMock.mockResolvedValue(null);
    fetchMock.mockResolvedValue(jsonRes(SIGNUP_OPTIONS));
    expect(await signUpWithPasskey()).toEqual({ ok: false, reason: "cancelled" });
  });

  test("verify failure (e.g. 409 credential already registered) → error", async () => {
    enableSupport();
    createMock.mockResolvedValue(REG_CREDENTIAL);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/signup/options") ? jsonRes(SIGNUP_OPTIONS) : jsonRes({ error: "passkey already registered" }, { status: 409 }),
    );
    expect(await signUpWithPasskey()).toEqual({ ok: false, reason: "error" });
  });

  test("options fetch throws → error", async () => {
    enableSupport();
    fetchMock.mockRejectedValue(new Error("net"));
    expect(await signUpWithPasskey()).toEqual({ ok: false, reason: "error" });
  });

  test("verify fetch throws → error", async () => {
    enableSupport();
    createMock.mockResolvedValue(REG_CREDENTIAL);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/signup/options")) return jsonRes(SIGNUP_OPTIONS);
      throw new Error("net");
    });
    expect(await signUpWithPasskey()).toEqual({ ok: false, reason: "error" });
  });
});

describe("loginWithPasskey", () => {
  test("unsupported browser", async () => {
    disableSupport();
    expect(await loginWithPasskey()).toEqual({ ok: false, reason: "unsupported" });
  });

  test("happy path authed", async () => {
    enableSupport();
    getMock.mockResolvedValue(LOGIN_CREDENTIAL);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/login/options") ? jsonRes(LOGIN_OPTIONS) : jsonRes({ ok: true, status: "authed" }),
    );
    expect(await loginWithPasskey()).toEqual({ ok: true, status: "authed" });
  });

  test("a non-'authed' status maps to 'inactive' (a revoked/never-granted account, #169)", async () => {
    enableSupport();
    getMock.mockResolvedValue(LOGIN_CREDENTIAL);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/login/options") ? jsonRes(LOGIN_OPTIONS) : jsonRes({ ok: true, status: "inactive" }),
    );
    expect(await loginWithPasskey()).toEqual({ ok: true, status: "inactive" });
  });

  test("server dark (503) → unavailable", async () => {
    enableSupport();
    fetchMock.mockResolvedValue(jsonRes({ error: "x" }, { status: 503 }));
    expect(await loginWithPasskey()).toEqual({ ok: false, reason: "unavailable" });
  });

  test("options non-ok → error", async () => {
    enableSupport();
    fetchMock.mockResolvedValue(jsonRes({}, { status: 500 }));
    expect(await loginWithPasskey()).toEqual({ ok: false, reason: "error" });
  });

  test("options fetch throws → error", async () => {
    enableSupport();
    fetchMock.mockRejectedValue(new Error("net"));
    expect(await loginWithPasskey()).toEqual({ ok: false, reason: "error" });
  });

  test("user cancels → cancelled", async () => {
    enableSupport();
    getMock.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    fetchMock.mockResolvedValue(jsonRes(LOGIN_OPTIONS));
    expect(await loginWithPasskey()).toEqual({ ok: false, reason: "cancelled" });
  });

  test("null assertion → cancelled", async () => {
    enableSupport();
    getMock.mockResolvedValue(null);
    fetchMock.mockResolvedValue(jsonRes(LOGIN_OPTIONS));
    expect(await loginWithPasskey()).toEqual({ ok: false, reason: "cancelled" });
  });

  test("assertion without userHandle still verifies", async () => {
    enableSupport();
    getMock.mockResolvedValue({ ...LOGIN_CREDENTIAL, response: { ...LOGIN_CREDENTIAL.response, userHandle: null } });
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/login/options") ? jsonRes(LOGIN_OPTIONS) : jsonRes({ ok: true, status: "authed" }),
    );
    expect(await loginWithPasskey()).toEqual({ ok: true, status: "authed" });
  });

  test("verify non-ok → error", async () => {
    enableSupport();
    getMock.mockResolvedValue(LOGIN_CREDENTIAL);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/login/options") ? jsonRes(LOGIN_OPTIONS) : jsonRes({}, { status: 401 }),
    );
    expect(await loginWithPasskey()).toEqual({ ok: false, reason: "error" });
  });

  test("verify throws → error", async () => {
    enableSupport();
    getMock.mockResolvedValue(LOGIN_CREDENTIAL);
    let call = 0;
    fetchMock.mockImplementation(async (url: string) => {
      call++;
      if (url.includes("/login/options")) return jsonRes(LOGIN_OPTIONS);
      throw new Error("net");
    });
    expect(await loginWithPasskey()).toEqual({ ok: false, reason: "error" });
    expect(call).toBe(2);
  });
});

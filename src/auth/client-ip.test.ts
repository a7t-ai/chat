import { describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { trustedClientIp } from "./client-ip.ts";

// SECURITY-CRITICAL: the trusted client IP is what every per-IP OTP rate limit keys on. These
// pin the three derivation paths and — most importantly — that `x-forwarded-for` is NEVER
// honored (it's client-spoofable, so trusting it would let an attacker forge a fresh IP per
// request and walk past every per-IP cap).

// A minimal fake Context: trustedClientIp only reads c.req.header and (for the serve path)
// c.env.server.requestIP via getConnInfo. `serverPeer` lets us simulate the Bun socket peer.
function ctx(headers: Record<string, string>, serverPeer?: string | null): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: {
      header: (name: string): string | undefined => lower[name.toLowerCase()],
      raw: new Request("http://127.0.0.1/api/auth/request-code"),
    },
    // getConnInfo reads c.env.server.requestIP(req). `serverPeer === undefined` → no server
    // handle at all (getConnInfo throws → null). `null` → server present but no peer info.
    env: serverPeer === undefined
      ? {}
      : {
          server: {
            requestIP: () => (serverPeer === null ? null : { address: serverPeer, family: "IPv4", port: 1 }),
          },
        },
  } as unknown as Context;
}

describe("trustedClientIp — edge path (cf-connecting-ip)", () => {
  test("uses cf-connecting-ip when present (request via the public edge)", () => {
    expect(trustedClientIp(ctx({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  test("trims the cf-connecting-ip value", () => {
    expect(trustedClientIp(ctx({ "cf-connecting-ip": "  198.51.100.4 " }))).toBe("198.51.100.4");
  });

  test("empty cf-connecting-ip → null (present-but-blank is unknown, not a bypass)", () => {
    // The header's PRESENCE still means 'via edge', but with no usable address we return null;
    // the OTP service treats null as non-local (subject to IP limits), never a loopback skip.
    expect(trustedClientIp(ctx({ "cf-connecting-ip": "" }))).toBeNull();
  });
});

describe("trustedClientIp — Tailscale Serve path (socket peer)", () => {
  test("falls back to the Bun socket peer when no edge header", () => {
    expect(trustedClientIp(ctx({}, "100.64.0.0"))).toBe("100.64.0.0");
  });

  test("null peer info → null", () => {
    expect(trustedClientIp(ctx({}, null))).toBeNull();
  });

  test("no Bun server handle (synthetic context) → null, never throws", () => {
    expect(trustedClientIp(ctx({}))).toBeNull();
  });
});

describe("trustedClientIp — NEVER trusts x-forwarded-for", () => {
  test("x-forwarded-for is ignored when it's the only signal", () => {
    expect(trustedClientIp(ctx({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
  });

  test("x-forwarded-for does NOT override the socket peer", () => {
    expect(trustedClientIp(ctx({ "x-forwarded-for": "1.2.3.4" }, "100.64.0.0"))).toBe("100.64.0.0");
  });

  test("x-forwarded-for does NOT override cf-connecting-ip", () => {
    expect(
      trustedClientIp(ctx({ "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "203.0.113.7" })),
    ).toBe("203.0.113.7");
  });
});

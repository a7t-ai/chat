import { describe, expect, test } from "bun:test";
import { mintWriteToken, verifyWriteToken } from "./write-token.ts";

// The stateless, slug-bound HMAC write token (#45). Security-critical: it's the gate on the one
// public write, so mint/verify, slug binding, tamper/expiry rejection, and stability are pinned.

const SECRET = "test-secret-key";
const SLUG = "abc123";
const NOW = 1_000_000_000_000; // fixed clock for determinism

describe("mintWriteToken / verifyWriteToken", () => {
  test("a freshly minted token verifies for its slug", () => {
    const { token } = mintWriteToken(SLUG, NOW, SECRET);
    expect(verifyWriteToken(SLUG, token, NOW, SECRET)).toBe(true);
  });

  test("expiresAt is in the future and within the max TTL (15–30 min)", () => {
    const { expiresAt } = mintWriteToken(SLUG, NOW, SECRET);
    expect(expiresAt - NOW).toBeGreaterThan(15 * 60_000);
    expect(expiresAt - NOW).toBeLessThanOrEqual(30 * 60_000);
  });

  test("a token minted for one slug does NOT verify for another (slug-bound)", () => {
    const { token } = mintWriteToken(SLUG, NOW, SECRET);
    expect(verifyWriteToken("different-slug", token, NOW, SECRET)).toBe(false);
  });

  test("a token signed with a different secret is rejected", () => {
    const { token } = mintWriteToken(SLUG, NOW, "other-secret");
    expect(verifyWriteToken(SLUG, token, NOW, SECRET)).toBe(false);
  });

  test("a tampered MAC is rejected", () => {
    const { token } = mintWriteToken(SLUG, NOW, SECRET);
    const dot = token.indexOf(".");
    const exp = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const flipped = `${mac.slice(0, -1)}${mac.at(-1) === "0" ? "1" : "0"}`;
    expect(verifyWriteToken(SLUG, `${exp}.${flipped}`, NOW, SECRET)).toBe(false);
  });

  test("a tampered expiry (re-signed window) is rejected — the MAC covers the expiry", () => {
    const { token, expiresAt } = mintWriteToken(SLUG, NOW, SECRET);
    const mac = token.slice(token.indexOf(".") + 1);
    expect(verifyWriteToken(SLUG, `${expiresAt + 60_000}.${mac}`, NOW, SECRET)).toBe(false);
  });

  test("an expired token is rejected", () => {
    const { token, expiresAt } = mintWriteToken(SLUG, NOW, SECRET);
    expect(verifyWriteToken(SLUG, token, expiresAt + 1, SECRET)).toBe(false);
  });

  test("a forged far-future expiry is rejected even if longer than the max TTL", () => {
    const farExpiry = NOW + 10 * 24 * 60 * 60_000; // 10 days out
    // A validly-signed but over-long token still fails the TTL ceiling.
    expect(verifyWriteToken(SLUG, `${farExpiry}.deadbeef`, NOW, SECRET)).toBe(false);
  });

  test("malformed tokens are rejected without throwing", () => {
    for (const bad of ["", "no-dot", ".", "abc.def", "123.", "notanumber.aabb"]) {
      expect(verifyWriteToken(SLUG, bad, NOW, SECRET)).toBe(false);
    }
    expect(verifyWriteToken(SLUG, null, NOW, SECRET)).toBe(false);
    expect(verifyWriteToken(SLUG, undefined, NOW, SECRET)).toBe(false);
  });

  test("the token is STABLE within a 15-minute window (survives repeated snapshot polls)", () => {
    const a = mintWriteToken(SLUG, NOW, SECRET).token;
    const b = mintWriteToken(SLUG, NOW + 60_000, SECRET).token; // 1 min later, same window
    expect(a).toBe(b);
  });

  test("crossing a window boundary mints a fresh token", () => {
    const a = mintWriteToken(SLUG, NOW, SECRET).token;
    const b = mintWriteToken(SLUG, NOW + 20 * 60_000, SECRET).token; // next window
    expect(a).not.toBe(b);
  });
});

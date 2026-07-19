import { afterEach, describe, expect, test } from "bun:test";
import { webauthnAvailable, webauthnOrigin, webauthnRpId, webauthnRpName } from "./config.ts";

const original = process.env.WEBAUTHN_RP_ID;
afterEach(() => {
  if (original === undefined) delete process.env.WEBAUTHN_RP_ID;
  else process.env.WEBAUTHN_RP_ID = original;
});

describe("webauthn config — availability toggles on WEBAUTHN_RP_ID (live env)", () => {
  test("dark when unset", () => {
    delete process.env.WEBAUTHN_RP_ID;
    expect(webauthnRpId()).toBe("");
    expect(webauthnAvailable()).toBe(false);
  });
  test("dark when blank/whitespace", () => {
    process.env.WEBAUTHN_RP_ID = "   ";
    expect(webauthnAvailable()).toBe(false);
  });
  test("lit + trimmed when set", () => {
    process.env.WEBAUTHN_RP_ID = "  a7t.chat  ";
    expect(webauthnRpId()).toBe("a7t.chat");
    expect(webauthnAvailable()).toBe(true);
  });
});

describe("webauthn config — derived values", () => {
  test("rp name is the product name", () => {
    expect(webauthnRpName()).toBe("a7t.chat");
  });
  test("origin is derived from APP_URL (scheme+host, no path)", () => {
    // APP_URL defaults to https://a7t.chat under test.
    expect(webauthnOrigin()).toBe("https://a7t.chat");
  });
});

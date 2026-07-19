import { describe, expect, test } from "bun:test";
import { generateToken, hashToken } from "./tokens.ts";

describe("tokens", () => {
  test("hashToken is deterministic SHA-256 hex", () => {
    const h = hashToken("a7t_example");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("a7t_example")).toBe(h); // stable
    expect(hashToken("a7t_other")).not.toBe(h); // distinct input → distinct hash
  });

  test("generateToken yields a prefixed token whose hash matches", () => {
    const { token, hash } = generateToken();
    expect(token.startsWith("a7t_")).toBe(true);
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("generateToken is unique per call", () => {
    expect(generateToken().token).not.toBe(generateToken().token);
  });
});

import { describe, expect, test } from "bun:test";
import { isStrayRoleToken } from "./verify.ts";

describe("isStrayRoleToken", () => {
  test("a bare role marker is the template bug", () => {
    expect(isStrayRoleToken("user")).toBe(true);
    expect(isStrayRoleToken(" assistant ")).toBe(true);
    expect(isStrayRoleToken("System")).toBe(true);
    expect(isStrayRoleToken("user\n")).toBe(true);
    // The exact MLX symptom: a stray role marker prepended before the reply.
    expect(isStrayRoleToken("user\nHello")).toBe(true);
  });

  test("real content is not flagged", () => {
    expect(isStrayRoleToken("pong")).toBe(false);
    expect(isStrayRoleToken("Users can sign in with a passkey")).toBe(false); // starts with 'Users', not the token
    expect(isStrayRoleToken("assistantship programs")).toBe(false);
    expect(isStrayRoleToken("")).toBe(false);
    expect(isStrayRoleToken("   ")).toBe(false);
  });
});

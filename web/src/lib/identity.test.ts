import { describe, expect, test } from "vitest";
import type { Me } from "./api";
import { displayNameOf } from "./identity";

type U = Me["user"];
const user = (over: Partial<U> = {}): U => ({ id: "u", login: "acct_abc-123", displayName: null, ...over });

describe("displayNameOf — precedence", () => {
  test("handle wins over everything", () => {
    expect(displayNameOf(user({ handle: "leo", displayName: "Leo C", email: "leo@a7t.test" }), "Account")).toBe("leo");
  });

  test("falls back to displayName when no handle", () => {
    expect(displayNameOf(user({ displayName: "Leo C", email: "leo@a7t.test" }), "Account")).toBe("Leo C");
  });

  test("falls back to email when no handle or displayName", () => {
    expect(displayNameOf(user({ email: "leo@a7t.test" }), "Account")).toBe("leo@a7t.test");
  });

  test("shows a real (admin) login when nothing friendlier is set", () => {
    expect(displayNameOf(user({ login: "leo@github" }), "Account")).toBe("leo@github");
  });

  test("NEVER shows a synthetic acct_ login — uses the friendly fallback instead", () => {
    expect(displayNameOf(user({ login: "acct_abc-123" }), "Account")).toBe("Account");
    // Even with a null displayName + email, the acct_ slug stays hidden.
    expect(displayNameOf(user({ login: "acct_deadbeef", displayName: null, email: null }), "You")).toBe("You");
  });

  test("empty-string identity fields are treated as unset (fall through)", () => {
    expect(displayNameOf(user({ handle: "", displayName: "", email: "", login: "acct_x" }), "Account")).toBe("Account");
  });
});

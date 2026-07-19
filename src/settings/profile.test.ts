import { afterEach, describe, expect, test } from "bun:test";
import type { AuthContext } from "../auth/middleware.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { planOf, selfProfile } from "./profile.ts";

// The admin tier (the stored-admin owner account, #191) resolves to the "owner" plan, above the ladder.
function makeAdmin(): AuthContext {
  const u = db.insert(users).values({ login: `adm-${Math.random()}`, role: "admin" }).returning().get();
  return { role: "admin", via: "owner", user: u, key: null } as unknown as AuthContext;
}

// An email-login account user on a given subscription plan (defaults to free).
function makeAccount(plan: "free" | "plus" | "pro" | "ultra" = "free"): AuthContext {
  const u = db.insert(users).values({ login: `acct-${Math.random()}`, role: "account", plan }).returning().get();
  return { role: "account", via: "session", user: u, key: null, accessGranted: true } as unknown as AuthContext;
}

afterEach(() => {
  db.delete(users).run();
});

describe("planOf", () => {
  test("admin tier → owner", () => {
    expect(planOf(makeAdmin())).toBe("owner");
  });
  test("account tier → its subscription plan (#13)", () => {
    expect(planOf(makeAccount())).toBe("free"); // default
    expect(planOf(makeAccount("plus"))).toBe("plus");
    expect(planOf(makeAccount("pro"))).toBe("pro");
  });
});

describe("selfProfile", () => {
  // The usage meter was dropped (#186): the self-profile now carries only the plan.
  test("composes the plan for an account", () => {
    expect(selfProfile(makeAccount())).toEqual({ plan: "free" });
    expect(selfProfile(makeAccount("ultra"))).toEqual({ plan: "ultra" });
  });
  test("composes the plan for the owner", () => {
    expect(selfProfile(makeAdmin())).toEqual({ plan: "owner" });
  });
});

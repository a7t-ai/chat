import { afterEach, describe, expect, test } from "bun:test";
import type { AuthContext } from "../auth/middleware.ts";
import { config } from "../config.ts";
import type { User } from "../db/schema.ts";
import { assertFeature, can, decide, EntitlementError, featureMap, FEATURES } from "./index.ts";
import type { AccountPlanId } from "./plans.ts";

// Minimal auth contexts — the entitlement rules only read `role` and `user.plan`. We fake the
// rest (never persisted), mirroring profile.test.ts.
function admin(): AuthContext {
  return { role: "admin", via: "owner", user: { plan: "free" } as User, key: null } as unknown as AuthContext;
}
function account(plan: AccountPlanId = "free"): AuthContext {
  return {
    role: "account",
    via: "session",
    user: { plan } as User,
    key: null,
    accessGranted: true,
  } as unknown as AuthContext;
}

afterEach(() => {
  const s = config.search as unknown as { guestsAllowed: boolean };
  const b = config.byok as unknown as { guestsAllowed: boolean };
  s.guestsAllowed = false;
  b.guestsAllowed = false;
});

describe("decide / can", () => {
  test("open features are allowed for everyone", () => {
    expect(can(account(), "chat.send")).toBe(true);
    expect(decide(account(), "conversations.read").allowed).toBe(true);
  });

  test("admin-only features are forbidden for accounts (403), allowed for admin", () => {
    const d = decide(account(), "admin.stats");
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.gate).toBe("forbidden");
      expect(d.status).toBe(403);
    }
    expect(can(admin(), "admin.stats")).toBe(true);
  });
});

describe("plan-derived premium levers (#13)", () => {
  test("free account: no research, no byok — a paywall (402)", () => {
    for (const feature of ["research", "byok"] as const) {
      const d = decide(account("free"), feature);
      expect(d.allowed).toBe(false);
      if (!d.allowed) {
        expect(d.gate).toBe("paywall");
        expect(d.status).toBe(402);
      }
    }
  });

  test("plus plan unlocks byok but NOT research", () => {
    expect(can(account("plus"), "byok")).toBe(true);
    expect(can(account("plus"), "research")).toBe(false);
  });

  test("pro plan unlocks both research and byok", () => {
    expect(can(account("pro"), "research")).toBe(true);
    expect(can(account("pro"), "byok")).toBe(true);
  });

  test("admin always has both regardless of the (moot) plan value", () => {
    expect(can(admin(), "research")).toBe(true);
    expect(can(admin(), "byok")).toBe(true);
  });

  test("the config guest flags are a global override that opens a lever to every account", () => {
    (config.search as unknown as { guestsAllowed: boolean }).guestsAllowed = true;
    (config.byok as unknown as { guestsAllowed: boolean }).guestsAllowed = true;
    expect(can(account("free"), "research")).toBe(true);
    expect(can(account("free"), "byok")).toBe(true);
  });
});

describe("assertFeature", () => {
  test("throws EntitlementError with the gate/status for a blocked caller", () => {
    try {
      assertFeature(account("free"), "byok");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EntitlementError);
      if (e instanceof EntitlementError) {
        expect(e.gate).toBe("paywall");
        expect(e.status).toBe(402);
        expect(e.feature).toBe("byok");
      }
    }
  });
  test("does not throw when allowed", () => {
    expect(() => assertFeature(account("pro"), "research")).not.toThrow();
  });
});

describe("featureMap", () => {
  test("covers every feature id and reflects the caller's plan", () => {
    const map = featureMap(account("plus"));
    expect(Object.keys(map).sort()).toEqual([...FEATURES].sort());
    expect(map.byok).toBe(true);
    expect(map.research).toBe(false);
    expect(map["admin.stats"]).toBe(false);
  });
});

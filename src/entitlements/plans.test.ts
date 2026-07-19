import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_PLAN_IDS,
  accountPlanOf,
  isAccountPlan,
  planCatalog,
  planInfo,
  planUnlocks,
} from "./plans.ts";

describe("isAccountPlan", () => {
  test("accepts exactly the catalog ids", () => {
    for (const id of ACCOUNT_PLAN_IDS) expect(isAccountPlan(id)).toBe(true);
  });
  test("rejects unknown / non-string / owner", () => {
    for (const v of ["owner", "admin", "", "FREE", null, undefined, 3, {}]) {
      expect(isAccountPlan(v)).toBe(false);
    }
  });
});

describe("accountPlanOf", () => {
  test("returns the stored plan when valid", () => {
    expect(accountPlanOf({ plan: "plus" })).toBe("plus");
    expect(accountPlanOf({ plan: "pro" })).toBe("pro");
    expect(accountPlanOf({ plan: "ultra" })).toBe("ultra");
    expect(accountPlanOf({ plan: "free" })).toBe("free");
  });
  test("degrades an unknown / null plan to ultra (OSS build has no paywall, #166)", () => {
    // The OSS build defaults every account to `ultra`; a corrupt/legacy column resolves the same
    // way, so any account gets the full feature set.
    expect(accountPlanOf({ plan: "enterprise" as unknown as "free" })).toBe("ultra");
    expect(accountPlanOf({ plan: null as unknown as "free" })).toBe("ultra");
  });
});

describe("planUnlocks — the ladder", () => {
  test("free unlocks the baseline features but no premium levers", () => {
    expect(planUnlocks("free", "files")).toBe(true);
    expect(planUnlocks("free", "chat.voice")).toBe(true);
    expect(planUnlocks("free", "research")).toBe(false);
    expect(planUnlocks("free", "byok")).toBe(false);
  });
  test("plus adds byok (keeps the baseline) but not research", () => {
    expect(planUnlocks("plus", "byok")).toBe(true);
    expect(planUnlocks("plus", "files")).toBe(true);
    expect(planUnlocks("plus", "research")).toBe(false);
  });
  test("pro + ultra unlock both research and byok", () => {
    for (const plan of ["pro", "ultra"] as const) {
      expect(planUnlocks(plan, "research")).toBe(true);
      expect(planUnlocks(plan, "byok")).toBe(true);
    }
  });
});

describe("catalog shape", () => {
  test("planCatalog is the ladder in floor→top order", () => {
    expect(planCatalog().map((p) => p.id)).toEqual(["free", "plus", "pro", "ultra"]);
  });
  test("free is not purchasable; plus / pro / ultra are", () => {
    expect(planInfo("free").purchasable).toBe(false);
    expect(planInfo("plus").purchasable).toBe(true);
    expect(planInfo("pro").purchasable).toBe(true);
    expect(planInfo("ultra").purchasable).toBe(true);
  });
  test("every plan carries display copy (name, tagline, highlights)", () => {
    for (const p of planCatalog()) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.tagline.length).toBeGreaterThan(0);
      expect(p.highlights.length).toBeGreaterThan(0);
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import {
  accountIdByEmail,
  BillingError,
  billingConfigured,
  checkoutUrlFor,
  currentPlan,
  setAccountPlan,
  startCheckout,
} from "./service.ts";

type BillingCfg = { provider: string; webhookSecret: string; checkoutUrls: Record<string, string> };
const billing = () => config.billing as unknown as BillingCfg;

function seedAccount(over: Partial<{ email: string; role: "account" | "admin"; plan: "free" | "plus" | "pro" | "ultra" }> = {}) {
  return db
    .insert(users)
    .values({
      login: `bill-${Math.random()}`,
      email: over.email ?? `${Math.random()}@a7t.test`,
      role: over.role ?? "account",
      plan: over.plan ?? "free",
      accessGrantedAt: new Date(),
    })
    .returning()
    .get()!;
}

beforeEach(() => {
  const b = billing();
  b.provider = "";
  b.webhookSecret = "";
  b.checkoutUrls = { plus: "", pro: "", ultra: "" };
});
afterEach(() => {
  db.delete(users).run();
});

describe("billingConfigured", () => {
  test("false when no provider, true when a provider is set", () => {
    expect(billingConfigured()).toBe(false);
    billing().provider = "polar";
    expect(billingConfigured()).toBe(true);
  });
});

describe("checkoutUrlFor", () => {
  test("null when billing is dark", () => {
    billing().checkoutUrls.pro = "https://buy.example/pro";
    expect(checkoutUrlFor("pro")).toBeNull(); // no provider ⇒ dark
  });
  test("null for the non-purchasable free plan even with a URL set", () => {
    billing().provider = "polar";
    billing().checkoutUrls.free = "https://buy.example/free" as string;
    expect(checkoutUrlFor("free")).toBeNull();
  });
  test("returns the configured https link for a purchasable plan", () => {
    billing().provider = "polar";
    billing().checkoutUrls.pro = "https://buy.example/pro";
    expect(checkoutUrlFor("pro")).toBe("https://buy.example/pro");
  });
  test("rejects a non-https link (never sends an insecure/relative target)", () => {
    billing().provider = "polar";
    billing().checkoutUrls.plus = "http://buy.example/plus";
    expect(checkoutUrlFor("plus")).toBeNull();
  });
});

describe("startCheckout", () => {
  test("throws 400 for free / unknown / non-string plan", () => {
    billing().provider = "polar";
    billing().checkoutUrls.pro = "https://buy.example/pro";
    for (const bad of ["free", "enterprise", "", null, 3]) {
      try {
        startCheckout(bad);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(BillingError);
        if (e instanceof BillingError) expect(e.status).toBe(400);
      }
    }
  });
  test("throws 503 when the plan is purchasable but no self-serve link is configured", () => {
    billing().provider = "polar"; // configured, but no pro URL
    try {
      startCheckout("pro");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BillingError);
      if (e instanceof BillingError) expect(e.status).toBe(503);
    }
  });
  test("returns the checkout url for a purchasable, configured plan", () => {
    billing().provider = "polar";
    billing().checkoutUrls.pro = "https://buy.example/pro";
    expect(startCheckout("pro")).toEqual({ url: "https://buy.example/pro" });
  });
});

describe("setAccountPlan + currentPlan", () => {
  test("updates an account's plan and reads it back", () => {
    const u = seedAccount({ plan: "free" });
    expect(setAccountPlan(u.id, "pro")).toBe(true);
    expect(currentPlan(u.id)).toBe("pro");
  });
  test("returns false (no-op) for a non-account (admin) row — never changes the owner", () => {
    const adm = seedAccount({ role: "admin", plan: "free" });
    expect(setAccountPlan(adm.id, "pro")).toBe(false);
    // the admin row is untouched
    const row = db.select({ plan: users.plan }).from(users).where(eq(users.id, adm.id)).get();
    expect(row?.plan).toBe("free");
  });
  test("returns false for an unknown id", () => {
    expect(setAccountPlan("nope", "pro")).toBe(false);
  });
  test("currentPlan defaults to free for an unknown id", () => {
    expect(currentPlan("nope")).toBe("free");
  });
});

describe("accountIdByEmail", () => {
  test("finds an account case-insensitively (emails are stored lowercased)", () => {
    const u = seedAccount({ email: "leo@a7t.test" });
    expect(accountIdByEmail("LEO@A7T.test")).toBe(u.id);
    expect(accountIdByEmail("  leo@a7t.test  ")).toBe(u.id);
  });
  test("null for a blank email, an unknown email, and a non-account row", () => {
    seedAccount({ email: "admin@a7t.test", role: "admin" });
    expect(accountIdByEmail("")).toBeNull();
    expect(accountIdByEmail("ghost@a7t.test")).toBeNull();
    expect(accountIdByEmail("admin@a7t.test")).toBeNull(); // admins have no plan
  });
});

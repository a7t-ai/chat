import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { parseBillingEvent, verifyWebhookSignature, webhookConfigured } from "./webhook.ts";

const SECRET = "test-billing-secret";
function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("webhookConfigured", () => {
  test("false for a blank/whitespace secret, true otherwise", () => {
    expect(webhookConfigured("")).toBe(false);
    expect(webhookConfigured("   ")).toBe(false);
    expect(webhookConfigured(SECRET)).toBe(true);
  });
});

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ email: "a@b.test", plan: "pro" });

  test("accepts a correct HMAC-SHA256 hex signature", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  test("tolerates a sha256= prefix", () => {
    expect(verifyWebhookSignature(body, `sha256=${sign(body)}`, SECRET)).toBe(true);
  });

  test("rejects a wrong signature, a tampered body, and a wrong secret", () => {
    expect(verifyWebhookSignature(body, sign(body, "other"), SECRET)).toBe(false);
    expect(verifyWebhookSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, SECRET), "other")).toBe(false);
  });

  test("fails closed with no secret (dark) even given any signature", () => {
    expect(verifyWebhookSignature(body, sign(body, ""), "")).toBe(false);
    expect(verifyWebhookSignature(body, "anything", "")).toBe(false);
  });

  test("rejects a missing / malformed / non-hex signature (no throw)", () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "zzzz", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "abcd", SECRET)).toBe(false); // wrong length
  });
});

describe("parseBillingEvent", () => {
  test("parses a valid normalized event", () => {
    expect(parseBillingEvent(JSON.stringify({ email: "A@B.test", plan: "plus" }))).toEqual({
      email: "A@B.test",
      plan: "plus",
    });
  });
  test("accepts every catalog plan (incl. free = a cancel/downgrade)", () => {
    for (const plan of ["free", "plus", "pro", "ultra"] as const) {
      expect(parseBillingEvent(JSON.stringify({ email: "x@y.test", plan }))?.plan).toBe(plan);
    }
  });
  test("rejects a bad plan, missing/blank email, non-object, and non-JSON", () => {
    expect(parseBillingEvent(JSON.stringify({ email: "x@y.test", plan: "enterprise" }))).toBeNull();
    expect(parseBillingEvent(JSON.stringify({ email: "", plan: "pro" }))).toBeNull();
    expect(parseBillingEvent(JSON.stringify({ email: "   ", plan: "pro" }))).toBeNull();
    expect(parseBillingEvent(JSON.stringify({ plan: "pro" }))).toBeNull();
    expect(parseBillingEvent(JSON.stringify({ email: "x@y.test" }))).toBeNull();
    expect(parseBillingEvent("null")).toBeNull();
    expect(parseBillingEvent("[1,2]")).toBeNull();
    expect(parseBillingEvent("not json")).toBeNull();
  });
});

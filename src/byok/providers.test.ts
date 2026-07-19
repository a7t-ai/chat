import { describe, expect, test } from "bun:test";
import { isProvider, parseModelRef, providerCatalog, providerInfo } from "./providers.ts";

describe("byok/providers", () => {
  test("catalog exposes id/label/keyHint but not baseUrl", () => {
    const cat = providerCatalog();
    expect(cat.length).toBeGreaterThan(0);
    for (const p of cat) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.label).toBe("string");
      expect(typeof p.keyHint).toBe("string");
      expect((p as Record<string, unknown>).baseUrl).toBeUndefined();
    }
    expect(cat.some((p) => p.id === "openai")).toBe(true);
  });

  test("isProvider / providerInfo agree with the catalog", () => {
    expect(isProvider("openai")).toBe(true);
    expect(isProvider("nope")).toBe(false);
    const info = providerInfo("openai");
    expect(info?.baseUrl).toBe("https://api.openai.com/v1");
    expect(providerInfo("nope")).toBeNull();
  });

  test("every catalog base is a fixed https URL (no SSRF surface)", () => {
    for (const p of providerCatalog()) {
      const info = providerInfo(p.id)!;
      expect(info.baseUrl.startsWith("https://")).toBe(true);
      expect(info.baseUrl.endsWith("/")).toBe(false);
    }
  });

  describe("parseModelRef", () => {
    test("splits a provider/model id on the first slash", () => {
      expect(parseModelRef("openai/gpt-4o")).toEqual({ provider: "openai", upstreamModel: "gpt-4o" });
    });
    test("keeps later slashes in the upstream id (openrouter vendor/model)", () => {
      expect(parseModelRef("openrouter/anthropic/claude-3.5-sonnet")).toEqual({
        provider: "openrouter",
        upstreamModel: "anthropic/claude-3.5-sonnet",
      });
    });
    test("null for a plain local model (no slash)", () => {
      expect(parseModelRef("qwen-chat")).toBeNull();
    });
    test("null for an unknown provider prefix", () => {
      expect(parseModelRef("acme/model")).toBeNull();
    });
    test("null for a leading slash or empty upstream", () => {
      expect(parseModelRef("/gpt-4o")).toBeNull();
      expect(parseModelRef("openai/")).toBeNull();
    });
  });
});

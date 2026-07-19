import { describe, expect, test } from "bun:test";
import { ACCOUNT_PLAN_IDS } from "../entitlements/plans.ts";
import { catalogEntry, defaultMeta, MODEL_CATALOG } from "./catalog.ts";
import type { Modality } from "./types.ts";

const MODALITIES: Modality[] = ["text", "image", "audio", "video", "document"];

describe("MODEL_CATALOG seed integrity", () => {
  const ids = Object.keys(MODEL_CATALOG);

  test("seeds the models Jano serves today", () => {
    // These are the ids Jano's /v1/models returns; the seed must cover them so they're enriched,
    // not defaulted. (A new Jano model without a row still shows — via defaultMeta — but should
    // get a real row here.)
    for (const id of ["qwen-chat", "qwen-code", "qwen-omni", "whisper"]) {
      expect(ids).toContain(id);
    }
  });

  test("every entry is well-formed (honest modalities, valid tier, present cost/features)", () => {
    for (const [id, meta] of Object.entries(MODEL_CATALOG)) {
      // Non-empty IN and OUT modalities, drawn only from the known set.
      expect(meta.input.length, `${id} input`).toBeGreaterThan(0);
      expect(meta.output.length, `${id} output`).toBeGreaterThan(0);
      for (const m of [...meta.input, ...meta.output]) expect(MODALITIES).toContain(m);
      // Tier is a real plan rung (kept in lockstep with the #13 ladder).
      expect(ACCOUNT_PLAN_IDS as readonly string[]).toContain(meta.tier);
      // Features + cost are always present (the meter/picker read them unconditionally).
      expect(meta.features).toBeDefined();
      expect(meta.cost).toBeDefined();
      // Any advertised window is a positive number (unknown is OMITTED, never faked to 0).
      if (meta.contextTokens !== undefined) expect(meta.contextTokens).toBeGreaterThan(0);
      if (meta.maxOutputTokens !== undefined) expect(meta.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  test("every seeded model is local, free, and does not train on data (the local privacy floor)", () => {
    for (const meta of Object.values(MODEL_CATALOG)) {
      expect(meta.hosting).toBe("local");
      expect(meta.cost).toEqual({ local: true });
      expect(meta.trainsOnData).toBe(false);
      expect(meta.tier).toBe("free");
    }
  });

  test("qwen-omni accepts image input — the model that lights up the attachment picker (#15/#74)", () => {
    expect(catalogEntry("qwen-omni")?.input).toContain("image");
  });

  test("whisper has NO text input, so a chat picker filtering for a text prompt excludes it", () => {
    const whisper = catalogEntry("whisper");
    expect(whisper?.input).not.toContain("text");
    expect(whisper?.input).toContain("audio");
  });
});

describe("catalogEntry", () => {
  test("returns the row for a known id", () => {
    expect(catalogEntry("qwen-chat")?.provider).toBe("qwen");
  });

  test("returns undefined for an unknown id (merge falls back to defaults)", () => {
    expect(catalogEntry("gpt-9-ultra")).toBeUndefined();
  });
});

describe("defaultMeta", () => {
  test("is conservative: local/free, text-only, no premium features, no advertised window", () => {
    const d = defaultMeta();
    expect(d.hosting).toBe("local");
    expect(d.cost).toEqual({ local: true });
    expect(d.tier).toBe("free");
    expect(d.input).toEqual(["text"]);
    expect(d.output).toEqual(["text"]);
    expect(d.openWeights).toBe(false); // never CLAIM open for a model we don't know
    expect(d.features).toEqual({ reasoning: "none", toolUse: false, webSearch: false, structuredOutput: false });
    expect(d.contextTokens).toBeUndefined();
    expect(d.maxOutputTokens).toBeUndefined();
  });

  test("returns a fresh object each call (mutating one never corrupts the next)", () => {
    const a = defaultMeta();
    const b = defaultMeta();
    expect(a).not.toBe(b);
    a.input.push("image");
    a.recommendedFor.push("hacked");
    expect(b.input).toEqual(["text"]);
    expect(b.recommendedFor).toEqual([]);
  });
});

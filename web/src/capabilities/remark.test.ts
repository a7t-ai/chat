import { describe, expect, test } from "vitest";
import { decodeCapability, encodeCapability, remarkCapabilities } from "./remark";

// The capability marker pipeline already bit us once (streamdown strips element
// attributes, so the marker rides inside the span's TEXT behind a sentinel). These lock
// the encode/decode round-trip and the remark transform so it can't silently regress.

describe("encode/decode round-trip", () => {
  test("recovers id + payload, including commas/accents", () => {
    const enc = encodeCapability("map", "Belém Tower, Lisbon, Portugal");
    expect(decodeCapability(enc)).toEqual({ id: "map", payload: "Belém Tower, Lisbon, Portugal" });
  });

  test("plain text is not a capability marker", () => {
    expect(decodeCapability("just some text")).toBeNull();
    expect(decodeCapability("")).toBeNull();
  });
});

describe("remarkCapabilities transform", () => {
  test("splits a complete [[id:payload]] into a decodable span node", () => {
    // Minimal mdast: a paragraph whose text holds one complete marker.
    const tree = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Go to [[map:Berlin, Germany]] now." }] }],
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal mdast shape for the test
    remarkCapabilities()(tree as any);
    const para = tree.children[0] as { children: { type: string; value?: string; data?: { hName?: string; hChildren?: { value: string }[] } }[] };
    const span = para.children.find((n) => n.data?.hName === "span");
    expect(span).toBeTruthy();
    const text = span?.data?.hChildren?.[0]?.value ?? "";
    expect(decodeCapability(text)).toEqual({ id: "map", payload: "Berlin, Germany" });
    // surrounding prose is preserved
    expect(para.children[0]).toMatchObject({ type: "text", value: "Go to " });
  });

  test("leaves an INCOMPLETE marker (still streaming) as plain text", () => {
    const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "Go to [[map:Ber" }] }] };
    // biome-ignore lint/suspicious/noExplicitAny: minimal mdast shape for the test
    remarkCapabilities()(tree as any);
    const para = tree.children[0] as { children: { type: string; data?: { hName?: string } }[] };
    expect(para.children.some((n) => n.data?.hName === "span")).toBe(false);
  });
});

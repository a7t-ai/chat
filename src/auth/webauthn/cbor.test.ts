import { describe, expect, test } from "bun:test";
import { CborError, decodeCbor } from "./cbor.ts";

describe("decodeCbor — integers", () => {
  test("small unsigned (inline)", () => {
    expect(decodeCbor(Buffer.from([0x0a]))).toBe(10);
  });
  test("1-byte / 2-byte / 4-byte / 8-byte unsigned", () => {
    expect(decodeCbor(Buffer.from([0x18, 0xff]))).toBe(255);
    expect(decodeCbor(Buffer.from([0x19, 0x01, 0x00]))).toBe(256);
    expect(decodeCbor(Buffer.from([0x1a, 0x00, 0x01, 0x00, 0x00]))).toBe(65536);
    expect(decodeCbor(Buffer.from([0x1b, 0, 0, 0, 1, 0, 0, 0, 0]))).toBe(0x1_0000_0000);
  });
  test("negative integers", () => {
    expect(decodeCbor(Buffer.from([0x20]))).toBe(-1); // -1-0
    expect(decodeCbor(Buffer.from([0x26]))).toBe(-7); // COSE ES256 alg id
  });
  test("throws on an 8-byte integer beyond the safe range", () => {
    expect(() => decodeCbor(Buffer.from([0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow(CborError);
  });
});

describe("decodeCbor — strings, arrays, maps", () => {
  test("byte string", () => {
    const v = decodeCbor(Buffer.from([0x43, 1, 2, 3]));
    expect(Buffer.isBuffer(v)).toBe(true);
    expect((v as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });
  test("text string", () => {
    expect(decodeCbor(Buffer.from([0x63, 0x66, 0x6d, 0x74]))).toBe("fmt");
  });
  test("array", () => {
    expect(decodeCbor(Buffer.from([0x82, 0x01, 0x02]))).toEqual([1, 2]);
  });
  test("map with a text key (attestation-object shape)", () => {
    // { "a": 1 }
    const m = decodeCbor(Buffer.from([0xa1, 0x61, 0x61, 0x01])) as Map<unknown, unknown>;
    expect(m).toBeInstanceOf(Map);
    expect(m.get("a")).toBe(1);
  });
  test("map with integer keys incl. negatives (COSE shape)", () => {
    // { 1: 2, -1: 3 }
    const m = decodeCbor(Buffer.from([0xa2, 0x01, 0x02, 0x20, 0x03])) as Map<unknown, unknown>;
    expect(m.get(1)).toBe(2);
    expect(m.get(-1)).toBe(3);
  });
});

describe("decodeCbor — simple values", () => {
  test("false / true / null / undefined", () => {
    expect(decodeCbor(Buffer.from([0xf4]))).toBe(false);
    expect(decodeCbor(Buffer.from([0xf5]))).toBe(true);
    expect(decodeCbor(Buffer.from([0xf6]))).toBe(null);
    expect(decodeCbor(Buffer.from([0xf7]))).toBe(undefined);
  });
  test("throws on an unsupported simple/float value", () => {
    expect(() => decodeCbor(Buffer.from([0xfa, 0, 0, 0, 0]))).toThrow(CborError); // float32
  });
});

describe("decodeCbor — failures fail closed", () => {
  test("throws on a truncated buffer", () => {
    expect(() => decodeCbor(Buffer.from([0x43, 1]))).toThrow(/end of CBOR/);
  });
  test("throws on an indefinite-length item (unsupported)", () => {
    expect(() => decodeCbor(Buffer.from([0x5f]))).toThrow(/length encoding/);
  });
  test("ignores trailing bytes after a complete item", () => {
    expect(decodeCbor(Buffer.from([0x01, 0xff, 0xff]))).toBe(1);
  });

  test("throws on excessively deep nesting (stack-exhaustion guard)", () => {
    // 40 nested single-element arrays (0x81 = array of 1) exceeds MAX_DEPTH (32).
    const buf = Buffer.concat([Buffer.alloc(40, 0x81), Buffer.from([0x00])]);
    expect(() => decodeCbor(buf)).toThrow(/too deep/);
  });
});

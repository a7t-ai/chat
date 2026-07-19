import { describe, expect, test } from "vitest";
import { stripIncompleteMarkdownTail } from "./markdown";

describe("stripIncompleteMarkdownTail", () => {
  test("strips a dangling link whose URL never closes", () => {
    expect(stripIncompleteMarkdownTail("see [the docs](https://example.com/page")).toBe("see");
  });

  test("leaves a bare unclosed [text tail untouched (no `](` -> not a link, never a placeholder)", () => {
    expect(stripIncompleteMarkdownTail("read more [the docs")).toBe("read more [the docs");
  });

  test("leaves prose ending in a bare unclosed bracket untouched (obj[key, arr[i)", () => {
    expect(stripIncompleteMarkdownTail("access obj[key")).toBe("access obj[key");
    expect(stripIncompleteMarkdownTail("read arr[i")).toBe("read arr[i");
  });

  test("strips a dangling (truncated) capability marker", () => {
    expect(stripIncompleteMarkdownTail("visit [[map:Alfama, Lisbon")).toBe("visit");
  });

  test("leaves a complete link untouched", () => {
    const s = "see [the docs](https://example.com)";
    expect(stripIncompleteMarkdownTail(s)).toBe(s);
  });

  test("leaves a complete capability marker untouched", () => {
    const s = "wander [[map:Chiado, Lisbon, Portugal]] tonight";
    expect(stripIncompleteMarkdownTail(s)).toBe(s);
  });

  test("leaves a bare reference-style bracket untouched (not a dangling link)", () => {
    const s = "this is [a note]";
    expect(stripIncompleteMarkdownTail(s)).toBe(s);
  });

  test("leaves ordinary balanced brackets in prose untouched", () => {
    const s = "access arr[0] then arr[1]";
    expect(stripIncompleteMarkdownTail(s)).toBe(s);
  });

  test("keeps earlier complete links and leaves a trailing bare [text fragment intact", () => {
    // The tail is a bare `[away` (no `](`), so it is prose, not a dangling link — left untouched.
    expect(stripIncompleteMarkdownTail("[home](https://a.com) and [away")).toBe("[home](https://a.com) and [away");
  });

  test("only strips the trailing incomplete link, keeping an earlier complete one", () => {
    expect(stripIncompleteMarkdownTail("[a](https://a.com) [b](https://b.com/x")).toBe("[a](https://a.com)");
  });

  test("plain prose with no brackets is returned unchanged", () => {
    const s = "just a normal completed answer.";
    expect(stripIncompleteMarkdownTail(s)).toBe(s);
  });

  test("empty content stays empty", () => {
    expect(stripIncompleteMarkdownTail("")).toBe("");
  });
});

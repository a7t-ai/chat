import { describe, expect, it } from "vitest";
import { setTaskItem, taskItemStates } from "./todos";

// Client mirror of the server checkbox helper (kept identical so optimistic == persisted).
describe("setTaskItem", () => {
  it("ticks the Nth item, leaving others untouched", () => {
    expect(setTaskItem("- [ ] eggs\n- [ ] flour", 1, true)).toBe("- [ ] eggs\n- [x] flour");
  });

  it("unticks an item", () => {
    expect(setTaskItem("- [x] eggs", 0, false)).toBe("- [ ] eggs");
  });

  it("recognizes ordered and *,+ markers", () => {
    expect(setTaskItem("1. [ ] a\n* [ ] b\n+ [ ] c", 2, true)).toBe("1. [ ] a\n* [ ] b\n+ [x] c");
  });

  it("returns null for an out-of-range or invalid index", () => {
    expect(setTaskItem("- [ ] only", 3, true)).toBeNull();
    expect(setTaskItem("- [ ] only", -1, true)).toBeNull();
    expect(setTaskItem("no tasks", 0, true)).toBeNull();
  });

  it("does not match a non-list bracket", () => {
    expect(setTaskItem("arr[ ] and [x] inline", 0, true)).toBeNull();
  });

  it("skips a fenced-code look-alike so index 0 hits the real task (matches server, #53)", () => {
    expect(setTaskItem("```\n- [ ] example\n```\n- [ ] real", 0, true)).toBe(
      "```\n- [ ] example\n```\n- [x] real",
    );
  });

  it("ticks a blockquoted task item, preserving the `>` prefix", () => {
    expect(setTaskItem("> - [ ] quoted", 0, true)).toBe("> - [x] quoted");
  });

  it("skips a top-level indented-code look-alike so index 0 hits the real task (matches server, #53)", () => {
    expect(setTaskItem("    - [ ] fake\n- [ ] real", 0, true)).toBe("    - [ ] fake\n- [x] real");
  });

  it("still ticks a genuinely nested 4-space task item under an open list", () => {
    expect(setTaskItem("- [ ] top\n    - [ ] nested", 1, true)).toBe("- [ ] top\n    - [x] nested");
  });

  it("skips a bracket with no whitespace-then-content after it (plain text, matches server, #53)", () => {
    // GFM only renders a checkbox when `]` is followed by whitespace then content, so `- [ ]eggs`,
    // `- [ ]`, and `- [ ] ` are plain text; index 0 must reach the one real task and index 1 is null.
    const md = "- [ ]eggs\n- [ ]\n- [ ] \n- [ ] real";
    expect(setTaskItem(md, 0, true)).toBe("- [ ]eggs\n- [ ]\n- [ ] \n- [x] real");
    expect(setTaskItem(md, 1, true)).toBeNull();
  });
});

describe("taskItemStates", () => {
  it("reports each rendered checkbox's checked state in document order", () => {
    expect(taskItemStates("- [ ] a\n- [x] b\n- [ ] c")).toEqual([false, true, false]);
  });

  it("accepts an uppercase [X] as checked (GFM is case-insensitive)", () => {
    expect(taskItemStates("- [X] done")).toEqual([true]);
  });

  it("is empty for content with no rendered task items", () => {
    expect(taskItemStates("just a paragraph")).toEqual([]);
  });

  it("counts and orders exactly the checkboxes streamdown renders (skips look-alikes)", () => {
    // A fenced-code look-alike and a no-space bracket render NO checkbox; the blockquoted task does.
    const md = ["- [ ] alpha", "```", "- [x] fenced", "```", "> - [x] beta", "- [ ]delta"].join("\n");
    expect(taskItemStates(md)).toEqual([false, true]);
  });

  it("stays index-aligned with setTaskItem's ordinals", () => {
    const md = "- [ ] one\n- [ ] two\n- [ ] three";
    const flipped = setTaskItem(md, 1, true)!;
    expect(taskItemStates(flipped)).toEqual([false, true, false]);
  });
});

import { describe, expect, test } from "vitest";
import {
  buildMinimap,
  classify,
  estimateHeight,
  excerpt,
  MIN_MESSAGES,
  type MinimapInput,
  shouldShowMinimap,
} from "./minimap";

describe("classify", () => {
  test("counts prose lines, wrapping long lines", () => {
    const k = classify("hello\nworld");
    expect(k.proseLines).toBe(2);
    expect(k.code).toBe(0);
    expect(k.landmarks).toBe(0);
    expect(k.attachments).toBe(0);

    // A single very long line wraps into several rendered rows.
    const long = classify("x".repeat(180));
    expect(long.proseLines).toBeGreaterThan(1);
  });

  test("blank lines don't count as prose", () => {
    expect(classify("a\n\n\nb").proseLines).toBe(2);
  });

  test("counts fenced code blocks and excludes their lines from prose", () => {
    const k = classify("intro line\n```js\nconst a = 1;\nconst b = 2;\n```\noutro");
    expect(k.code).toBe(1);
    // Only the two prose lines (intro/outro), not the code body, count as prose.
    expect(k.proseLines).toBe(2);
  });

  test("counts tilde fences too", () => {
    expect(classify("~~~\ncode\n~~~").code).toBe(1);
  });

  test("two separate code blocks count as two", () => {
    expect(classify("```\na\n```\ntext\n```\nb\n```").code).toBe(2);
  });

  test("a still-streaming (unclosed) code fence counts as one block", () => {
    expect(classify("here is code\n```js\nconst a = 1;").code).toBe(1);
  });

  test("counts markdown image attachments but not bare links", () => {
    const withImg = classify("see ![a diagram](http://x/y.png) here");
    expect(withImg.attachments).toBe(1);
    const withLink = classify("see https://example.com here");
    expect(withLink.attachments).toBe(0);
  });

  test("detects capability landmarks via the shared marker parser", () => {
    const k = classify("Visit [[map:Lisbon]] and [[map:Porto]].");
    expect(k.landmarks).toBe(2);
  });
});

describe("estimateHeight", () => {
  test("code weighs more than the same count of prose lines", () => {
    const proseHeavy = estimateHeight({ proseLines: 4, code: 0, landmarks: 0, attachments: 0 });
    const codeHeavy = estimateHeight({ proseLines: 0, code: 1, landmarks: 0, attachments: 0 });
    expect(codeHeavy).toBeGreaterThan(proseHeavy);
  });

  test("an empty message still has a minimum height", () => {
    expect(estimateHeight({ proseLines: 0, code: 0, landmarks: 0, attachments: 0 })).toBeGreaterThan(0);
  });

  test("attachments add height", () => {
    const base = estimateHeight({ proseLines: 2, code: 0, landmarks: 0, attachments: 0 });
    const withAttach = estimateHeight({ proseLines: 2, code: 0, landmarks: 0, attachments: 2 });
    expect(withAttach).toBeGreaterThan(base);
  });
});

describe("excerpt", () => {
  test("returns plain prose unchanged but whitespace-collapsed", () => {
    expect(excerpt("hello   world")).toBe("hello world");
    expect(excerpt("line one\nline two")).toBe("line one line two");
  });

  test("drops fenced code blocks, keeping the surrounding prose", () => {
    const out = excerpt("intro text\n```js\nconst secret = 1;\n```\noutro text");
    expect(out).toBe("intro text outro text");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("```");
  });

  test("drops a still-streaming (unclosed) code fence to end of string", () => {
    const out = excerpt("here is the answer\n```py\nx = 1\ny = 2");
    expect(out).toBe("here is the answer");
    expect(out).not.toContain("```");
    expect(out).not.toContain("x = 1");
  });

  test("turns a [[map:Place, City]] marker into its place text", () => {
    expect(excerpt("Visit [[map:Lisbon, Portugal]] today")).toBe("Visit Lisbon, Portugal today");
  });

  test("uses the place text before a | label in a marker payload", () => {
    expect(excerpt("Go to [[map:Porto|Ribeira]] now")).toBe("Go to Porto now");
  });

  test("strips leading header, list, and quote markers per line", () => {
    expect(excerpt("# Title")).toBe("Title");
    expect(excerpt("- one\n- two")).toBe("one two");
    expect(excerpt("1. first\n2. second")).toBe("first second");
    expect(excerpt("> quoted line")).toBe("quoted line");
  });

  test("unwraps emphasis, inline code, links, and images", () => {
    expect(excerpt("this is **bold** and _italic_ and ~~struck~~")).toBe("this is bold and italic and struck");
    expect(excerpt("call `fn()` here")).toBe("call fn() here");
    expect(excerpt("see [the docs](http://x/y) please")).toBe("see the docs please");
    expect(excerpt("look ![a chart](http://x/c.png) here")).toBe("look a chart here");
  });

  test("keeps a generous excerpt below the cap intact (fills tall blocks)", () => {
    // ~250 chars: well over the old 180 cap, well under the new 600 — returned whole, no cut.
    const medium = `${"word ".repeat(50)}end`;
    const out = excerpt(medium);
    expect(out).toBe(`${"word ".repeat(50)}end`.trim());
    expect(out.endsWith("…")).toBe(false);
  });

  test("caps the length on a word boundary with an ellipsis at the upper bound", () => {
    const long = `${"word ".repeat(200)}end`; // ~1000 chars, over the 600 cap
    const out = excerpt(long);
    expect(out.length).toBeLessThanOrEqual(601); // <= cap + the ellipsis char
    expect(out.endsWith("…")).toBe(true);
    // The cut lands on a word boundary, never mid-word.
    expect(out.slice(0, -1).trim().endsWith("word")).toBe(true);
  });

  test("an empty or code-only message yields an empty excerpt", () => {
    expect(excerpt("")).toBe("");
    expect(excerpt("```js\nconst a = 1;\n```")).toBe("");
  });
});

const thread: MinimapInput[] = [
  { role: "user", content: "short question" },
  { role: "assistant", content: "a paragraph\nwith two lines" },
  { role: "user", content: "follow up" },
  { role: "assistant", content: "here is code\n```py\nx=1\ny=2\nz=3\n```\nand a note" },
];

describe("buildMinimap", () => {
  test("returns one block per message, in order", () => {
    const mm = buildMinimap(thread);
    expect(mm.blocks).toHaveLength(4);
    expect(mm.blocks.map((b) => b.index)).toEqual([0, 1, 2, 3]);
    expect(mm.blocks.map((b) => b.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  test("blocks carry ABSOLUTE natural heights (not normalized shares) summing to totalHeight", () => {
    const mm = buildMinimap(thread);
    // Heights are real height-units, NOT fractions of 1 — the fixed-scale model never
    // squashes the thread to fit the strip.
    expect(mm.blocks.every((b) => b.height > 1)).toBe(true);
    const sum = mm.blocks.reduce((s, b) => s + b.height, 0);
    expect(mm.totalHeight).toBe(sum);
    expect(mm.totalHeight).toBeGreaterThan(1);
  });

  test("the code-bearing message carries the most height", () => {
    const mm = buildMinimap(thread);
    const heaviest = mm.blocks.reduce((a, b) => (b.height > a.height ? b : a));
    expect(heaviest.index).toBe(3);
    expect(mm.blocks[3].kinds.code).toBe(1);
  });

  test("carries a cleaned excerpt per block, code body excluded", () => {
    const mm = buildMinimap(thread);
    expect(mm.blocks[0].text).toBe("short question");
    // The code-bearing block keeps only its intro/outro prose, never the fenced body.
    expect(mm.blocks[3].text).toBe("here is code and a note");
    expect(mm.blocks[3].text).not.toContain("x=1");
  });

  test("an empty thread is safe (no NaN weights)", () => {
    const mm = buildMinimap([]);
    expect(mm.blocks).toHaveLength(0);
  });

  test("keeps system messages so the strip mirrors the thread", () => {
    const mm = buildMinimap([
      { role: "user", content: "hi" },
      { role: "system", content: "switched model → x" },
    ]);
    expect(mm.blocks.map((b) => b.role)).toEqual(["user", "system"]);
  });
});

describe("shouldShowMinimap", () => {
  test("hidden below the message threshold", () => {
    expect(shouldShowMinimap(0)).toBe(false);
    expect(shouldShowMinimap(MIN_MESSAGES - 1)).toBe(false);
  });
  test("shown at or above the threshold", () => {
    expect(shouldShowMinimap(MIN_MESSAGES)).toBe(true);
    expect(shouldShowMinimap(MIN_MESSAGES + 10)).toBe(true);
  });
});

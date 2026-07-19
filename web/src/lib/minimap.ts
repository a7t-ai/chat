// Minimap model — the PURE, deterministic seam behind the conversation minimap (the
// Sublime/VSCode-style scrubbable preview that pins to the right edge of the thread). No
// LLM, no network: given the thread's raw messages it returns, per message, a content-type
// breakdown the strip paints as texture (faint prose lines, a tinted code block, a landmark
// pin, an attachment chip) + a generous excerpt + a coarse natural-height weight.
//
// The strip renders each block in NATURAL DOM FLOW — every block is exactly as tall as its
// own tiny excerpt text, so nothing overlaps and nothing is clipped. The stacked track
// therefore can (and usually does) exceed the visible strip, and it scrolls in PARALLAX with
// the thread — exactly Sublime/VSCode. The component owns the live scroll/viewport/parallax
// math and the MEASURED track height; everything classifiable from the text alone lives here
// so it can be unit-tested without a DOM.

import { extractMarkers } from "../capabilities/remark";

// The minimum number of messages before the minimap is worth showing. Below this a
// thread fits on screen and the strip is just noise, so the component hides it.
export const MIN_MESSAGES = 4;

// A single message's row in the minimap model.
export interface MinimapBlock {
  // Index of the message in the thread (the anchor target for a scrub).
  index: number;
  role: "user" | "assistant" | "system";
  // Estimated NATURAL height of this message, in arbitrary text-units. The live strip no
  // longer uses this — blocks flow at height:auto, so the DOM sizes each one to its excerpt.
  // It stays as a coarse, deterministic weight a model-only consumer can reason about (e.g.
  // "which message carries the most content") without a DOM. Absolute units, not a share.
  height: number;
  // Content-type breakdown, used to paint texture onto the block.
  kinds: ContentKinds;
  // A cleaned single-paragraph excerpt of the message, markdown-stripped + generously
  // capped, rendered as tiny readable text in the block so the strip reads like a shrunk
  // render of the conversation (the way Sublime's minimap shows the actual text, for
  // recognition/anchoring). Generous so longer messages fill their taller block.
  text: string;
}

// What a message is made of, in coarse buckets the strip can render as marks. Counts are
// deterministic from the raw markdown (fenced code, landmark markers, image/link refs).
export interface ContentKinds {
  // Estimated wrapped prose lines (drives the faint horizontal-line texture).
  proseLines: number;
  // Number of fenced code blocks (each paints a solid tinted band).
  code: number;
  // Map / capability landmarks ([[map:…]] etc.) — each paints a pin dot.
  landmarks: number;
  // Attachment-like references (markdown images, source/link chips) — each a chip mark.
  attachments: number;
}

// The full minimap model for a thread: the per-message blocks plus their summed natural
// height. The strip flows blocks in the DOM (it does not use these heights to lay out), but
// the sum lets a model-only consumer reason about relative thread weight without a DOM.
export interface Minimap {
  blocks: MinimapBlock[];
  // Sum of every block's natural-height weight — a text-units total over the thread. Not used
  // for layout (the track is DOM-flowed + measured); kept for model-only reasoning.
  totalHeight: number;
}

// Shape we need from a thread message. Mirrors the fields <ChatView> already has; kept
// minimal so the helper stays decoupled from the view model.
export interface MinimapInput {
  role: "user" | "assistant" | "system";
  content: string;
}

// Average characters that fit on one rendered line of prose at the thread's width. Only
// used for the text-based height fallback; the live strip measures real heights. A rough
// constant is fine — it just sets relative proportions before the DOM is measured.
const CHARS_PER_LINE = 60;

// Markdown image / explicit attachment reference: ![alt](url). Bare links are NOT counted
// as attachments (they're prose); only embedded media reads as an attachment chip.
const IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;

// A fence LINE (``` or ~~~) at the start of a line. Each code block has an opener and a
// closer (two fence lines); a streaming, still-unclosed block has just the opener. We pair
// them up so both cases count as one code region (see codeBlockCount).
const FENCE_RE = /^[ \t]*(```|~~~)/gm;

// Number of fenced code regions: paired opener/closer fences, plus one for a dangling
// (unclosed, mid-stream) opener so a half-rendered block still reads as code.
function codeBlockCount(content: string): number {
  const fences = (content.match(FENCE_RE) ?? []).length;
  return Math.ceil(fences / 2);
}

// Classify a single message's raw content into coarse content buckets. Pure + cheap:
// regex counts over the text, landmark detection reused from the capability marker parser
// so map/capability pins line up with the inline chips exactly.
export function classify(content: string): ContentKinds {
  const code = codeBlockCount(content);
  const attachments = (content.match(IMAGE_RE) ?? []).length;
  const landmarks = extractMarkers(content).length;

  // Strip fenced code from the prose estimate so a long code block doesn't inflate the
  // line texture — code is rendered as its own band, not as prose lines.
  const prose = content.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
  let proseLines = 0;
  for (const line of prose.split("\n")) {
    const len = line.trim().length;
    if (len === 0) continue;
    // A long line wraps to multiple rendered rows.
    proseLines += Math.max(1, Math.ceil(len / CHARS_PER_LINE));
  }
  return { proseLines, code, landmarks, attachments };
}

// Longest excerpt we render into a block, in characters. The block FLOWS to fit its excerpt,
// so a longer message gets a TALLER block — we want a faithful shrunk render, not a two-line
// teaser. The cap is just a sane upper bound so one pathological message can't dominate the
// track (which would dwarf the rest of the thread in the parallax); we cut on a word boundary
// and add an ellipsis. ~600 reads as a full preview while staying bounded.
const EXCERPT_MAX = 600;

// A capability marker  [[map:Place, City]]  → its payload's place text ("Place, City"). For
// a map marker the payload may carry a trailing  |label  the chip uses; the excerpt wants
// the human place, so keep the part before any pipe. Other capabilities just inline their
// payload. Pure string work, mirrors what extractMarkers sees.
const MARKER_RE = /\[\[[a-z][\w-]*:([^\]]+)\]\]/gi;

// Build the cleaned, single-paragraph excerpt rendered into a block. Deterministic + pure:
// strips the markdown so the tiny text reads as plain prose (the way Xcode's minimap shows
// real code) rather than raw syntax. Order matters — fenced code goes first (so its body
// never leaks), then markers become their place text, then inline syntax is unwrapped.
export function excerpt(content: string): string {
  let s = content;
  // Drop fenced code blocks entirely — code shows as its own tinted band, not as text.
  s = s.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  // A dangling (still-streaming) opener has no closer; cut from it to end of string.
  s = s.replace(/(?:```|~~~)[\s\S]*$/g, " ");
  // Capability markers → their place/payload text (before any | label).
  s = s.replace(MARKER_RE, (_m, payload: string) => payload.split("|")[0].trim());
  // Images ![alt](url) → the alt text; links [text](url) → the text. Images first so the
  // leading "!" doesn't strand on a bare link.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Inline code `x` → its contents (no backticks).
  s = s.replace(/`([^`]*)`/g, "$1");
  // Per-line: strip leading heading (#), list (-, *, +, 1.), and quote (>) markers.
  s = s
    .split("\n")
    .map((line) => line.replace(/^[ \t]*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>+\s*)+/, ""))
    .join("\n");
  // Emphasis / strikethrough markers anywhere: ** __ * _ ~~ ~ — drop the wrappers.
  s = s.replace(/(\*\*|__|~~|[*_~])/g, "");
  // Collapse all whitespace (incl. the newlines we joined on) into single spaces.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= EXCERPT_MAX) return s;
  // Cut to the cap, then back off to the last word boundary so we don't slice a word.
  const cut = s.slice(0, EXCERPT_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Text-only height estimate for a message, in arbitrary units. Prose contributes per
// wrapped line; each code fence and attachment adds a fixed chunk; an empty message still
// occupies a minimum so a placeholder/role row never weighs nothing. The strip no longer
// uses this for layout (blocks flow + are DOM-measured); it's a coarse content weight that
// keeps the model meaningful (and testable) on its own.
export function estimateHeight(kinds: ContentKinds): number {
  const PROSE = 1;
  const CODE = 6; // a fenced block reads taller than its line count suggests
  const ATTACH = 3;
  const MIN = 2;
  const h = kinds.proseLines * PROSE + kinds.code * CODE + kinds.attachments * ATTACH;
  return Math.max(MIN, h);
}

// Build the minimap model for a thread. Returns one block per message (in order) with its
// content breakdown, a generous excerpt, and an ABSOLUTE natural-height weight. The strip
// flows + DOM-measures the blocks (it does not lay out from these heights); the weight is a
// coarse content signal, not a share of the strip. System messages are kept so the strip
// stays a faithful 1:1 of the thread. Deterministic: same input → same output, no side
// effects.
export function buildMinimap(messages: MinimapInput[]): Minimap {
  const blocks: MinimapBlock[] = messages.map((m, index) => {
    const kinds = classify(m.content);
    return { index, role: m.role, height: estimateHeight(kinds), kinds, text: excerpt(m.content) };
  });
  const totalHeight = blocks.reduce((sum, b) => sum + b.height, 0);
  return { blocks, totalHeight };
}

// Should the minimap show for this thread? Gated on message count alone here (the pure,
// testable part); the component additionally hides on narrow viewports (a CSS/media
// concern, not a data one).
export function shouldShowMinimap(messageCount: number): boolean {
  return messageCount >= MIN_MESSAGES;
}

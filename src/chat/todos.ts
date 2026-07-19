// Task-list checkbox helpers — the persistent-TODO-completion primitive (#45). A shared
// recipe/plan can carry a GFM task list ("- [ ] buy eggs"); ticking an item persists IN THE
// MESSAGE CONTENT (`- [ ]` -> `- [x]`), so the completion is shared for everyone who opens the
// conversation (the owner in their own chat, an invited collaborator, or a no-login watcher on
// the public share page). `setTaskItem` is the pure parser behind the toggle; `toggleConversationTodo`
// is the single message-scoped write both the owner route (`POST /conversations/:id/todo`) and
// the public share route (`toggleSharedTodo`) ride — deliberately scoped to a single checkbox
// character so no caller can ever rewrite arbitrary content (see routes.ts + share/routes.ts).

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { messages } from "../db/schema.ts";

// A GFM task-list item at the start of a (blockquote-stripped) line: optional indentation, a
// bullet (-/*/+) or an ordered marker (1. / 2)), horizontal whitespace, then the `[ ]` / `[x]`
// checkbox. We match only horizontal whitespace ([^\S\r\n]) around the marker so line endings
// (\n or \r\n) are left untouched. Capture 1 is the marker prefix; the checkbox state character
// sits one char past it. Anchored (no `g`/`m`) — the walk in `eachTaskItem` feeds it one line
// at a time so it can honor context (code fences, blockquotes) the way streamdown renders it.
//
// The trailing `(?=[^\S\r\n]+\S)` is load-bearing: GFM only renders a checkbox when the `]` is
// followed by horizontal whitespace AND then some content on the same line. So `- [ ]eggs` (no
// space), `- [ ]` (empty), and `- [ ] ` (trailing space only) are all plain text to remark-gfm.
// Without this assertion the walk over-counts those look-alikes and every later checkbox's ordinal
// drifts by one relative to what streamdown renders — toggling the wrong item (#53 review).
const TASK_ITEM_RE = /^([^\S\r\n]*(?:[-*+]|\d+[.)])[^\S\r\n]+)\[[ xX]\](?=[^\S\r\n]+\S)/;

// A fenced-code-block delimiter: up to 3 leading spaces, then a run of >=3 backticks or tildes.
// streamdown/remark-gfm never renders task checkboxes inside fenced code, so we must skip those
// lines — otherwise a `- [ ]` written inside a code snippet would inflate the server's item
// count and shift every subsequent index past what the page actually shows.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// Leading blockquote markers (`>` optionally followed by a space, one or more deep). remark-gfm
// strips these and DOES render a task checkbox on the inner content ("> - [ ] x" is a real,
// clickable checkbox), so we strip them before matching too — otherwise the server would miss a
// checkbox the page renders and, again, its indexes would drift out of alignment.
const BLOCKQUOTE_RE = /^ {0,3}(?:>[^\S\r\n]?)+/;

// A bare list-item marker (bullet -/*/+ or ordered 1. / 2)) — the checkbox is optional here.
// Used only to track whether we're inside a list: a plain bullet opens/continues one just as a
// task item does, which decides whether a >=4-space-indented line below it is a NESTED list item
// (a rendered checkbox) or a top-level INDENTED CODE block (no checkbox — see the walk below).
const LIST_MARKER_RE = /^[^\S\r\n]*(?:[-*+]|\d+[.)])[^\S\r\n]+/;

// Visual column width of a line's leading whitespace, expanding tabs to the next 4-column stop
// the way CommonMark measures indentation. >=4 columns is the indented-code-block threshold.
function leadingIndent(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Walk `content` line by line and invoke `visit` with the source offset of each rendered task
// checkbox's STATE character (the ` `/`x`/`X` between the brackets), in document order. Tracks
// fenced-code state (skipping items inside code), strips blockquote prefixes (including items
// inside quotes), and skips top-level indented (>=4-space) code blocks — so the ordinals here
// line up 1:1 with the checkboxes streamdown renders on the page — the invariant the client's
// per-checkbox counter (Message.tsx) depends on.
function eachTaskItem(content: string, visit: (stateOffset: number) => void): void {
  let fence: { char: string; len: number } | null = null;
  // Whether a list is currently open above this line. A >=4-space-indented line is a NESTED list
  // item when a list is open (streamdown renders its checkbox), but an INDENTED CODE block when
  // none is (no checkbox) — CommonMark's key ambiguity, and the last index-drift the naive regex
  // missed (a top-level `    - [ ] x` was counted but renders as code — #53 review).
  let listOpen = false;
  let offset = 0;
  // Split keeping each line's terminator attached, so `offset` (and \r\n) stay byte-exact.
  for (const line of content.split(/(?<=\n)/)) {
    const bq = line.match(BLOCKQUOTE_RE);
    const prefixLen = bq ? bq[0].length : 0;
    const inner = prefixLen ? line.slice(prefixLen) : line;

    const fenceMatch = inner.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const char = marker[0]!;
      const len = marker.length;
      // Open a fence, or close it on a matching (same char, >= length) delimiter.
      if (!fence) fence = { char, len };
      else if (fence.char === char && len >= fence.len) fence = null;
      offset += line.length;
      continue;
    }

    if (!fence && inner.trim() !== "") {
      const indent = leadingIndent(inner);
      const m = inner.match(TASK_ITEM_RE);
      if (indent >= 4) {
        // Nested list item only when a list is open above; otherwise it's indented code — skip.
        // State char = blockquote prefix + marker prefix + the `[` itself.
        if (listOpen && m) visit(offset + prefixLen + m[1]!.length + 1);
      } else if (m) {
        visit(offset + prefixLen + m[1]!.length + 1);
        listOpen = true;
      } else if (LIST_MARKER_RE.test(inner)) {
        // A plain (checkbox-free) bullet/ordered item still opens/continues the list.
        listOpen = true;
      } else if (indent === 0) {
        // A flush-left, non-list line (paragraph/heading) ends any open list. Indented 1-3-space
        // non-list lines stay ambiguous (possible lazy continuation), so we leave `listOpen` be.
        listOpen = false;
      }
    }
    // A blank line leaves `listOpen` unchanged — lists tolerate internal blank lines.
    offset += line.length;
  }
}

// Set the Nth (0-based) rendered task-list checkbox to `done`, returning the updated content.
// Returns null when `index` is out of range (or not a valid index) so the caller rejects the
// write without touching anything — the leaked-token guard's last line. Idempotent: setting an
// item to the state it's already in returns equivalent content. Only the single bracket
// character changes; all surrounding text and whitespace is preserved verbatim.
export function setTaskItem(content: string, index: number, done: boolean): string | null {
  if (!Number.isInteger(index) || index < 0) return null;
  let target = -1;
  let i = 0;
  eachTaskItem(content, (stateOffset) => {
    if (i++ === index) target = stateOffset;
  });
  if (target < 0) return null;
  return content.slice(0, target) + (done ? "x" : " ") + content.slice(target + 1);
}

// Tick/untick the Nth task-list checkbox of a message, scoped to `conversationId` — the ONE
// message-content write the TODO primitive performs. Both the owner-side route and the public
// share route (via `toggleSharedTodo`) call this after their own authorization: the caller has
// already been admitted to the conversation, and the write is deliberately narrow (a single
// checkbox character via `setTaskItem` — never arbitrary content). Returns the updated content,
// or null when the message isn't in this conversation or the index is out of range (the caller
// surfaces that as a clean 404 no-op — no partial write, no existence oracle). Fully synchronous:
// bun:sqlite queries don't yield, so the read-modify-write is atomic against other in-flight toggles.
export function toggleConversationTodo(
  conversationId: string,
  messageId: string,
  index: number,
  done: boolean,
): { content: string } | null {
  const msg = db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .get();
  if (!msg) return null; // unknown message, or one belonging to a different conversation

  const next = setTaskItem(msg.content, index, done);
  if (next === null) return null; // index out of range — reject, no write

  if (next !== msg.content) {
    db.update(messages).set({ content: next }).where(eq(messages.id, messageId)).run();
  }
  return { content: next };
}

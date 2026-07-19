// Client mirror of the server's task-list checkbox helper (src/chat/todos.ts). The shared
// watch page uses it for OPTIMISTIC updates: when a viewer ticks a TODO we flip the checkbox in
// the local message content immediately, then confirm with the server (which is the source of
// truth). Kept in lockstep with the server logic — same context-aware walk (skip fenced code,
// strip blockquotes) — so the optimistic result matches the persisted one and, crucially, the
// item index lines up with the checkbox streamdown actually rendered in Message.tsx.

// A GFM task-list item at the start of a (blockquote-stripped) line — marker prefix in capture 1,
// checkbox state one char past it. Anchored: fed one line at a time by the walk below. The
// trailing `(?=[^\S\r\n]+\S)` mirrors GFM: a checkbox renders only when `]` is followed by
// horizontal whitespace then content, so `- [ ]eggs` / `- [ ]` / `- [ ] ` stay plain text and
// don't drift the ordinal past what streamdown renders (kept in lockstep with src/chat/todos.ts).
const TASK_ITEM_RE = /^([^\S\r\n]*(?:[-*+]|\d+[.)])[^\S\r\n]+)\[[ xX]\](?=[^\S\r\n]+\S)/;
// A fenced-code-block delimiter (>=3 backticks/tildes): its inner lines render no checkboxes.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// Leading blockquote markers: remark-gfm strips them and renders the inner checkbox, so we do too.
const BLOCKQUOTE_RE = /^ {0,3}(?:>[^\S\r\n]?)+/;
// A bare list-item marker (checkbox optional) — tracks list context so a >=4-space-indented line
// is read as a NESTED item (rendered checkbox) vs a top-level INDENTED CODE block (no checkbox).
const LIST_MARKER_RE = /^[^\S\r\n]*(?:[-*+]|\d+[.)])[^\S\r\n]+/;

// Visual column width of a line's leading whitespace (tabs -> next 4-column stop). >=4 is code.
function leadingIndent(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Walk `content` line by line, tracking fenced-code state, stripping blockquote prefixes, and
// skipping top-level indented (>=4-space) code blocks, invoking `visit` with the source offset of
// each rendered checkbox's state char, in document order (matches src/chat/todos.ts).
function eachTaskItem(content: string, visit: (stateOffset: number) => void): void {
  let fence: { char: string; len: number } | null = null;
  // A >=4-space-indented line is a nested item (checkbox) when a list is open, else indented code.
  let listOpen = false;
  let offset = 0;
  for (const line of content.split(/(?<=\n)/)) {
    const bq = line.match(BLOCKQUOTE_RE);
    const prefixLen = bq ? bq[0].length : 0;
    const inner = prefixLen ? line.slice(prefixLen) : line;

    const fenceMatch = inner.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const char = marker[0]!;
      const len = marker.length;
      if (!fence) fence = { char, len };
      else if (fence.char === char && len >= fence.len) fence = null;
      offset += line.length;
      continue;
    }

    if (!fence && inner.trim() !== "") {
      const indent = leadingIndent(inner);
      const m = inner.match(TASK_ITEM_RE);
      if (indent >= 4) {
        if (listOpen && m) visit(offset + prefixLen + m[1]!.length + 1);
      } else if (m) {
        visit(offset + prefixLen + m[1]!.length + 1);
        listOpen = true;
      } else if (LIST_MARKER_RE.test(inner)) {
        listOpen = true;
      } else if (indent === 0) {
        listOpen = false;
      }
    }
    offset += line.length;
  }
}

// The checked state of every rendered task-list checkbox, in document order — the live source of
// truth the interactive checkbox reads (bypassing streamdown's block memo, which won't repaint a
// same-length `[ ]`↔`[x]` flip; see Message.tsx TodoCheckedContext, #138). Ordinals line up with
// setTaskItem's `index` and the checkboxes streamdown renders (pinned in todo-ordinal.test.tsx).
export function taskItemStates(content: string): boolean[] {
  const states: boolean[] = [];
  eachTaskItem(content, (stateOffset) => {
    const ch = content[stateOffset];
    states.push(ch === "x" || ch === "X");
  });
  return states;
}

// Set the Nth (0-based) rendered task-list checkbox to `done`. Returns null when the index is out
// of range so the caller can leave the content untouched (matching the server's reject).
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

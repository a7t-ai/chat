// Small, pure markdown helpers.

// Streamdown auto-completes an unterminated markdown link at the tail of the text it's given
// (via its `remend` dependency, driven by the on-by-default `parseIncompleteMarkdown`): a
// dangling `[text](url` becomes `[text](streamdown:incomplete-link)` so a half-typed link
// doesn't flicker mid-stream. That's the right behavior for the live, still-streaming bubble.
// But a COMPLETED (persisted) reply is final — one that was cut off mid-link (a stopped or
// truncated turn) would otherwise render streamdown's raw `streamdown:incomplete-link`
// placeholder. Strip a single dangling link/marker tail from finished content so it reads
// clean before it ever reaches streamdown.
//
// The pattern is anchored to end-of-string and every opener must be genuinely unclosed, so it
// only ever removes a trailing fragment and leaves everything complete untouched:
//   - a complete link `[text](url)` (has the closing `)`),
//   - a complete capability marker `[[id:payload]]` (has the closing `]]`),
//   - a bare reference-style `[label]` (has the closing `]`, no dangling `(`),
//   - ordinary brackets in prose, closed (`arr[0]`) or not (`obj[key`).
// It removes ONLY the two dangling shapes that actually produce streamdown's
// `streamdown:incomplete-link` placeholder:
//   - `[[id:payload…`   an unterminated capability marker,
//   - `[text](url…`     a link whose URL never closes.
// A bare `[text` (no `](`) is deliberately NOT matched: streamdown never turns it into the
// placeholder, so trimming it would corrupt legitimate prose ending in `obj[key` or `arr[i`.
// Alternatives are ordered longest-first so a dangling link URL is consumed whole rather than
// leaving its `](` behind.
const INCOMPLETE_TAIL_RE = /(?:\[\[[^\]]*|\[[^\]]*\]\([^)]*)$/;

export function stripIncompleteMarkdownTail(content: string): string {
  return content.replace(INCOMPLETE_TAIL_RE, "").trimEnd();
}

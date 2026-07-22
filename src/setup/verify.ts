// Pure verification helpers for `bun run setup`. The wizard's smoke test streams one short turn and
// asserts the first content delta is real text, not a leaked chat-template role marker. Some MLX
// serving stacks intermittently prepend a stray `user\n` turn-marker (or emit only `user`) under
// streaming; llama.cpp uses the GGUF's own template and does not. Catching it here means the operator
// sees a clear failure at setup time instead of a mysterious `user` reply later.

const ROLE_TOKENS = ["user", "assistant", "system", "tool"];

// True when a streamed delta is nothing but a bare role marker (optionally trailed by a newline),
// e.g. "user", " assistant ", "system\n". The smoke-test prompt asks for a specific word, so a first
// delta of a bare role token is the template bug, never a legitimate answer.
export function isStrayRoleToken(delta: string): boolean {
  const trimmed = delta.trim().toLowerCase();
  if (!trimmed) return false;
  // Just the marker (whitespace-only around it), or the marker immediately followed by a newline.
  const firstLine = trimmed.split("\n")[0]?.trim() ?? "";
  return ROLE_TOKENS.includes(firstLine) && (trimmed === firstLine || trimmed.startsWith(`${firstLine}\n`));
}

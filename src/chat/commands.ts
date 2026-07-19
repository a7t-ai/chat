// Slash commands parsed server-side. `/model` lists allowed models; `/model <name>`
// switches the conversation's model (a real Jano coder<->chat swap).

export type ParsedCommand =
  | { kind: "model.list" }
  | { kind: "model.set"; model: string }
  | { kind: "none" };

export function parseCommand(content: string): ParsedCommand {
  const t = content.trim();
  if (t === "/model" || t === "/models") return { kind: "model.list" };
  const m = t.match(/^\/model\s+(\S+)/);
  if (m) return { kind: "model.set", model: m[1]! };
  return { kind: "none" };
}

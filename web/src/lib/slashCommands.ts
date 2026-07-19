import type { MessageKey } from "./i18n";

// Composer slash-command layer (client-side actions typed as `/name` in the message box,
// distinct from the `/model` chat command which is SENT to the server). The registry below is
// the single place a command is declared; the pure parse/match helpers let the composer decide
// what to show and run WITHOUT touching the DOM, so every trigger rule is unit-testable.

// Everything a command needs to decide whether it's runnable and to run. Plain data + callbacks
// (no React, no DOM) so `available`/`run` can be exercised directly in a test with a mock ctx.
export interface SlashCommandContext {
  // The open conversation's id, or null on the new-chat / ghost screen.
  conversationId: string | null;
  // Force "where you left off" for a conversation — reuses ChatView's existing recap force path
  // (`runRecap` -> `forceRecap`), so the command shares the auto-surface's card, scoping, and gate.
  runRecap: (conversationId: string) => void;
}

// One composer slash command. `name` is the bare word typed after "/" ("recap" -> "/recap").
// `label`/`hint` are i18n message keys resolved by the composer, so ALL copy stays in the
// dictionary (American English, no em-dashes). Adding a future command (e.g. `/compact`) is a
// single new entry here — the parser, menu, and Enter/submit wiring are command-agnostic.
export interface SlashCommand {
  id: string;
  name: string;
  label: MessageKey;
  hint: MessageKey;
  available: (ctx: SlashCommandContext) => boolean;
  run: (ctx: SlashCommandContext) => void;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "recap",
    name: "recap",
    label: "palette.recap",
    hint: "palette.recapHint",
    // Only when a real conversation is open — a ghost/new chat has nothing persisted to recap.
    available: (ctx) => ctx.conversationId !== null,
    run: (ctx) => {
      if (ctx.conversationId) ctx.runRecap(ctx.conversationId);
    },
  },
];

// The command-name token parsed from composer text, or null when the text is NOT naming a
// command: it doesn't start with "/", or it's already past the name (any whitespace means the
// user is typing arguments, e.g. "/model llama" — not our concern). Pure: text in, data out.
export interface SlashToken {
  token: string; // the lowercased partial word after "/" ("" for a bare "/")
}

export function parseSlashToken(text: string): SlashToken | null {
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  if (/\s/.test(rest)) return null; // a space/newline ends the command name
  return { token: rest.toLowerCase() };
}

// Available registry commands whose name PREFIX-matches the current composer token — the menu
// list. Non-slash text (or an argument context) yields none. A bare "/" (token "") surfaces every
// available command; "/r", "/rec", "/recap" all narrow to "/recap". Unavailable commands are
// omitted (the composer never offers a command that can't run right now).
export function matchSlashCommands(
  text: string,
  ctx: SlashCommandContext,
  registry: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const parsed = parseSlashToken(text);
  if (!parsed) return [];
  return registry.filter((c) => c.available(ctx) && c.name.toLowerCase().startsWith(parsed.token));
}

// The registry command the text names EXACTLY ("/recap", case-insensitive, trailing space
// tolerated), by NAME regardless of availability. The composer uses this to (a) run a
// fully-typed command and (b) GUARD send so a recognized command is never dispatched to the model
// as a literal chat message — even when it isn't currently runnable. Availability is a separate
// check the caller makes via `available(ctx)`.
export function exactSlashCommand(
  text: string,
  registry: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1).toLowerCase();
  if (!name) return null;
  return registry.find((c) => c.name.toLowerCase() === name) ?? null;
}

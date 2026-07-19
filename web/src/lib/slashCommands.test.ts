import { describe, expect, test, vi } from "vitest";
import {
  exactSlashCommand,
  matchSlashCommands,
  parseSlashToken,
  type SlashCommand,
  type SlashCommandContext,
  SLASH_COMMANDS,
} from "./slashCommands";

// The composer slash-command layer's trigger rules are a pure function of the typed text (and a
// plain context object), so they're exercised here with zero DOM — leading-slash detection, token
// filtering, exact-match, availability gating, and the seeded `/recap` command's run/available.

function ctx(over: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return { conversationId: "c1", runRecap: vi.fn(), ...over };
}

describe("parseSlashToken", () => {
  test("returns null for text that does not start with a slash", () => {
    expect(parseSlashToken("")).toBeNull();
    expect(parseSlashToken("hello")).toBeNull();
    expect(parseSlashToken("hello /recap")).toBeNull(); // a mid-text slash is not a command
  });

  test("a bare slash yields an empty token (matches every command)", () => {
    expect(parseSlashToken("/")).toEqual({ token: "" });
  });

  test("captures and lowercases the partial command word", () => {
    expect(parseSlashToken("/rec")).toEqual({ token: "rec" });
    expect(parseSlashToken("/ReCaP")).toEqual({ token: "recap" });
  });

  test("returns null once past the command name (whitespace = arguments)", () => {
    expect(parseSlashToken("/model llama")).toBeNull();
    expect(parseSlashToken("/recap ")).toBeNull();
    expect(parseSlashToken("/recap\nmore")).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  test("non-slash text matches nothing", () => {
    expect(matchSlashCommands("just a message", ctx())).toEqual([]);
  });

  test("a bare slash surfaces every available command", () => {
    const rows = matchSlashCommands("/", ctx());
    expect(rows.map((c) => c.name)).toEqual(["recap"]);
  });

  test("a prefix narrows to the matching command", () => {
    for (const text of ["/r", "/re", "/rec", "/reca", "/recap"]) {
      expect(matchSlashCommands(text, ctx()).map((c) => c.name)).toEqual(["recap"]);
    }
  });

  test("a non-matching prefix (or another command's name) matches nothing", () => {
    expect(matchSlashCommands("/xyz", ctx())).toEqual([]);
    // "/model" is a server chat command, not part of this client registry — never leaks in.
    expect(matchSlashCommands("/model", ctx())).toEqual([]);
  });

  test("omits commands whose available(ctx) is false", () => {
    // /recap needs an open conversation; on the new-chat screen it is not offered.
    expect(matchSlashCommands("/", ctx({ conversationId: null }))).toEqual([]);
    expect(matchSlashCommands("/recap", ctx({ conversationId: null }))).toEqual([]);
  });

  test("an argument context (space after the name) matches nothing", () => {
    expect(matchSlashCommands("/recap now", ctx())).toEqual([]);
  });

  test("accepts a custom registry (extensible for future commands)", () => {
    const custom: SlashCommand[] = [
      { id: "compact", name: "compact", label: "palette.recap", hint: "palette.recapHint", available: () => true, run: vi.fn() },
    ];
    expect(matchSlashCommands("/comp", ctx(), custom).map((c) => c.name)).toEqual(["compact"]);
    expect(matchSlashCommands("/recap", ctx(), custom)).toEqual([]);
  });
});

describe("exactSlashCommand", () => {
  test("matches a fully-typed command by name, tolerating a trailing space", () => {
    expect(exactSlashCommand("/recap")?.id).toBe("recap");
    expect(exactSlashCommand("  /recap  ")?.id).toBe("recap");
    expect(exactSlashCommand("/ReCaP")?.id).toBe("recap");
  });

  test("does not match a partial name, a non-command, or a bare slash", () => {
    expect(exactSlashCommand("/rec")).toBeNull();
    expect(exactSlashCommand("/recap now")).toBeNull(); // an argument makes it not an exact name
    expect(exactSlashCommand("/model")).toBeNull(); // not in this registry
    expect(exactSlashCommand("hello")).toBeNull();
    expect(exactSlashCommand("/")).toBeNull();
    expect(exactSlashCommand("")).toBeNull();
  });

  test("matches by name regardless of availability (so it can guard send)", () => {
    // Recognized even though it can't run here — the composer swallows it rather than sending it.
    const cmd = exactSlashCommand("/recap");
    expect(cmd).not.toBeNull();
    expect(cmd!.available({ conversationId: null, runRecap: vi.fn() })).toBe(false);
  });

  test("accepts a custom registry", () => {
    const custom: SlashCommand[] = [
      { id: "compact", name: "compact", label: "palette.recap", hint: "palette.recapHint", available: () => true, run: vi.fn() },
    ];
    expect(exactSlashCommand("/compact", custom)?.id).toBe("compact");
    expect(exactSlashCommand("/recap", custom)).toBeNull();
  });
});

describe("SLASH_COMMANDS — the seeded /recap command", () => {
  const recap = SLASH_COMMANDS.find((c) => c.id === "recap")!;

  test("is available only when a conversation is open", () => {
    expect(recap.available({ conversationId: "c9", runRecap: vi.fn() })).toBe(true);
    expect(recap.available({ conversationId: null, runRecap: vi.fn() })).toBe(false);
  });

  test("run() forces a recap for the open conversation", () => {
    const runRecap = vi.fn();
    recap.run({ conversationId: "c9", runRecap });
    expect(runRecap).toHaveBeenCalledWith("c9");
  });

  test("run() is a no-op with no open conversation (never calls the recap path)", () => {
    const runRecap = vi.fn();
    recap.run({ conversationId: null, runRecap });
    expect(runRecap).not.toHaveBeenCalled();
  });
});

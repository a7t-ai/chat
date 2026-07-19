import { describe, expect, test } from "bun:test";
import { parseCommand } from "./commands.ts";

describe("parseCommand", () => {
  test("/model and /models → list", () => {
    expect(parseCommand("/model")).toEqual({ kind: "model.list" });
    expect(parseCommand("/models")).toEqual({ kind: "model.list" });
    expect(parseCommand("  /model  ")).toEqual({ kind: "model.list" });
  });

  test("/model <name> → set, capturing the id", () => {
    expect(parseCommand("/model qwen-code")).toEqual({ kind: "model.set", model: "qwen-code" });
    expect(parseCommand("/model   qwen-chat  ")).toEqual({ kind: "model.set", model: "qwen-chat" });
  });

  test("ordinary text → none", () => {
    expect(parseCommand("hello there")).toEqual({ kind: "none" });
    expect(parseCommand("/modelish")).toEqual({ kind: "none" });
    expect(parseCommand("tell me about /model")).toEqual({ kind: "none" });
  });
});

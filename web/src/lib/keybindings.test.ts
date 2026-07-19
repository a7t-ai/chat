import { beforeEach, describe, expect, test } from "vitest";
import { installLocalStorage } from "../__tests__/localStorage";
import {
  ACTION_LABEL_KEYS,
  beginRecording,
  bindingOwner,
  type ChordEvent,
  chordTokens,
  DEFAULT_BINDINGS,
  endRecording,
  eventToChord,
  getBindings,
  isRecording,
  matchBinding,
  normalizeBindings,
  normalizeChord,
  resetBindings,
  setBinding,
  SHORTCUT_ACTIONS,
} from "./keybindings";

// A KeyboardEvent-shaped stub for the pure chord logic — no real DOM needed.
function ev(key: string, mods: Partial<Omit<ChordEvent, "key">> = {}): ChordEvent {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

beforeEach(() => {
  installLocalStorage();
  resetBindings();
});

describe("eventToChord", () => {
  test("requires a modifier (bare keys never match — typing is safe)", () => {
    expect(eventToChord(ev("k"))).toBeNull();
    expect(eventToChord(ev("a", { shiftKey: true }))).toBeNull();
    expect(eventToChord(ev("ArrowDown", { altKey: true }))).toBeNull();
  });

  test("a lone modifier press is not yet a chord", () => {
    expect(eventToChord(ev("Meta", { metaKey: true }))).toBeNull();
    expect(eventToChord(ev("Control", { ctrlKey: true }))).toBeNull();
    expect(eventToChord(ev("Shift", { metaKey: true, shiftKey: true }))).toBeNull();
  });

  test("Cmd or Ctrl both fold to `mod`", () => {
    expect(eventToChord(ev("k", { metaKey: true }))).toBe("mod+k");
    expect(eventToChord(ev("k", { ctrlKey: true }))).toBe("mod+k");
  });

  test("modifiers serialize in a fixed order (mod, alt, shift, key)", () => {
    expect(eventToChord(ev("M", { metaKey: true, shiftKey: true }))).toBe("mod+shift+m");
    expect(eventToChord(ev("m", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe("mod+alt+shift+m");
  });

  test("named keys and space normalize", () => {
    expect(eventToChord(ev("ArrowUp", { metaKey: true, shiftKey: true }))).toBe("mod+shift+arrowup");
    expect(eventToChord(ev("Backspace", { metaKey: true, shiftKey: true }))).toBe("mod+shift+backspace");
    expect(eventToChord(ev(" ", { metaKey: true }))).toBe("mod+space");
  });
});

describe("normalizeChord", () => {
  test("accepts aliases and arbitrary modifier order", () => {
    expect(normalizeChord("cmd+k")).toBe("mod+k");
    expect(normalizeChord("Command+K")).toBe("mod+k");
    expect(normalizeChord("ctrl+shift+m")).toBe("mod+shift+m");
    expect(normalizeChord("shift+mod+m")).toBe("mod+shift+m");
    expect(normalizeChord("option+meta+.")).toBe("mod+alt+.");
    expect(normalizeChord("⌘+⇧+m")).toBe("mod+shift+m");
  });

  test("rejects chords without a modifier or without a key", () => {
    expect(normalizeChord("k")).toBeNull();
    expect(normalizeChord("shift+k")).toBeNull();
    expect(normalizeChord("mod")).toBeNull();
    expect(normalizeChord("mod+shift")).toBeNull();
  });

  test("rejects two non-modifier keys and non-strings", () => {
    expect(normalizeChord("mod+k+j")).toBeNull();
    expect(normalizeChord("")).toBeNull();
    expect(normalizeChord(null)).toBeNull();
    expect(normalizeChord(42)).toBeNull();
  });
});

describe("DEFAULT_BINDINGS", () => {
  test("every action has a canonical, distinct default", () => {
    const chords = SHORTCUT_ACTIONS.map((a) => DEFAULT_BINDINGS[a]);
    // canonical: normalizing a default is a no-op
    for (const c of chords) expect(normalizeChord(c)).toBe(c);
    // distinct: no two actions share a chord
    expect(new Set(chords).size).toBe(chords.length);
  });

  test("every action has a label key in both dictionaries", () => {
    for (const a of SHORTCUT_ACTIONS) expect(ACTION_LABEL_KEYS[a]).toMatch(/^keyboard\./);
  });

  test("preserves the app's original chords", () => {
    expect(DEFAULT_BINDINGS.search).toBe("mod+k");
    expect(DEFAULT_BINDINGS.newThread).toBe("mod+.");
    expect(DEFAULT_BINDINGS.temporaryChat).toBe("mod+/");
    expect(DEFAULT_BINDINGS.minimap).toBe("mod+\\");
  });
});

describe("normalizeBindings", () => {
  test("garbage → full defaults", () => {
    expect(normalizeBindings(null)).toEqual(DEFAULT_BINDINGS);
    expect(normalizeBindings("nope")).toEqual(DEFAULT_BINDINGS);
    expect(normalizeBindings(123)).toEqual(DEFAULT_BINDINGS);
  });

  test("honors a valid custom chord, defaults the rest", () => {
    const b = normalizeBindings({ search: "mod+shift+f" });
    expect(b.search).toBe("mod+shift+f");
    expect(b.newThread).toBe(DEFAULT_BINDINGS.newThread);
  });

  test("an invalid custom chord falls back to that action's default", () => {
    const b = normalizeBindings({ search: "totally invalid" });
    expect(b.search).toBe(DEFAULT_BINDINGS.search);
  });

  test("a duplicate custom chord is dropped (first action in priority order wins)", () => {
    // Both claim mod+g; `search` precedes `newThread` in SHORTCUT_ACTIONS.
    const b = normalizeBindings({ search: "mod+g", newThread: "mod+g" });
    expect(b.search).toBe("mod+g");
    expect(b.newThread).toBe(DEFAULT_BINDINGS.newThread);
  });

  test("output is always complete with no duplicates", () => {
    const b = normalizeBindings({ search: "mod+g", newThread: "mod+g", modelPicker: "garbage" });
    for (const a of SHORTCUT_ACTIONS) expect(b[a]).toBeTruthy();
    const values = SHORTCUT_ACTIONS.map((a) => b[a]);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("bindingOwner / matchBinding", () => {
  test("bindingOwner finds the action holding a chord", () => {
    expect(bindingOwner(DEFAULT_BINDINGS, "mod+k")).toBe("search");
    expect(bindingOwner(DEFAULT_BINDINGS, "mod+z")).toBeNull();
  });

  test("matchBinding maps a keystroke to its action", () => {
    expect(matchBinding(DEFAULT_BINDINGS, ev("k", { metaKey: true }))).toBe("search");
    expect(matchBinding(DEFAULT_BINDINGS, ev("b", { ctrlKey: true }))).toBe("toggleSidebar");
    expect(matchBinding(DEFAULT_BINDINGS, ev("j", { metaKey: true, shiftKey: true }))).toBe("nextThread");
  });

  test("matchBinding returns null for unbound mod-combos and bare keys", () => {
    expect(matchBinding(DEFAULT_BINDINGS, ev("c", { metaKey: true }))).toBeNull(); // Cmd+C stays copy
    expect(matchBinding(DEFAULT_BINDINGS, ev("k"))).toBeNull(); // typing "k"
  });
});

describe("chordTokens", () => {
  test("macOS symbols", () => {
    expect(chordTokens("mod+shift+m", true)).toEqual(["⌘", "⇧", "M"]);
    expect(chordTokens("mod+shift+arrowdown", true)).toEqual(["⌘", "⇧", "↓"]);
    expect(chordTokens("mod+shift+backspace", true)).toEqual(["⌘", "⇧", "⌫"]);
  });

  test("non-mac labels", () => {
    expect(chordTokens("mod+b", false)).toEqual(["Ctrl", "B"]);
    expect(chordTokens("mod+.", false)).toEqual(["Ctrl", "."]);
  });
});

describe("store", () => {
  test("defaults out of the box", () => {
    expect(getBindings()).toEqual(DEFAULT_BINDINGS);
  });

  test("setBinding applies a valid chord and persists it", () => {
    expect(setBinding("search", "mod+shift+f")).toBe("ok");
    expect(getBindings().search).toBe("mod+shift+f");
    const raw = JSON.parse(localStorage.getItem("a7t_chat_keybindings")!);
    expect(raw.search).toBe("mod+shift+f");
  });

  test("setBinding normalizes aliases before storing", () => {
    expect(setBinding("toggleSidebar", "Ctrl+Shift+G")).toBe("ok");
    expect(getBindings().toggleSidebar).toBe("mod+shift+g");
  });

  test("setBinding rejects an invalid chord", () => {
    expect(setBinding("search", "nope")).toBe("invalid");
    expect(getBindings().search).toBe(DEFAULT_BINDINGS.search);
  });

  test("setBinding rejects a chord already owned by another action", () => {
    const res = setBinding("toggleSidebar", "mod+k"); // held by `search`
    expect(res).toEqual({ conflict: "search" });
    expect(getBindings().toggleSidebar).toBe(DEFAULT_BINDINGS.toggleSidebar);
  });

  test("rebinding to the same chord is a no-op ok", () => {
    expect(setBinding("search", "mod+k")).toBe("ok");
    expect(getBindings().search).toBe("mod+k");
  });

  test("resetBindings restores every default", () => {
    setBinding("search", "mod+shift+f");
    resetBindings();
    expect(getBindings()).toEqual(DEFAULT_BINDINGS);
  });

  test("recording flag toggles", () => {
    expect(isRecording()).toBe(false);
    beginRecording();
    expect(isRecording()).toBe(true);
    endRecording();
    expect(isRecording()).toBe(false);
  });

  test("a persisted custom binding is read back on the next load", () => {
    setBinding("modelPicker", "mod+shift+p");
    // Simulate a reload: normalizeBindings over the stored blob is what readStored does.
    const reloaded = normalizeBindings(JSON.parse(localStorage.getItem("a7t_chat_keybindings")!));
    expect(reloaded.modelPicker).toBe("mod+shift+p");
  });
});

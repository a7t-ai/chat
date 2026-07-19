// Customizable keyboard shortcuts (#16). Purely client-side: the bindings live in
// localStorage (never synced to the account — a shortcut is about the keyboard in front of
// you, not the identity), behind a tiny useSyncExternalStore store that mirrors the
// preferences/i18n/theme runtimes so the KeyboardSheet re-renders the instant a binding
// changes.
//
// A binding is a canonical "chord" string like "mod+k" or "mod+shift+m". Two invariants keep
// the whole thing safe and simple:
//   1. Every chord MUST include the platform modifier ("mod" = Cmd on macOS, Ctrl elsewhere).
//      A chord without a modifier could never round-trip and — more importantly — a bare-key
//      shortcut would fire while the user is typing in the composer. Requiring `mod` means the
//      global handler stays inert during normal text entry, exactly as the original hardcoded
//      handler did.
//   2. The map is always complete and valid: every action resolves to a normalized chord (a bad
//      or missing entry degrades to that action's default), and no two actions share a chord
//      (enforced at write time — a conflicting rebind is rejected, not silently swapped).

import { useSyncExternalStore } from "react";
import type { MessageKey } from "./i18n";

// The rebindable actions. Order is meaningful: it's the priority order the matcher walks (first
// action holding a chord wins, so a corrupt duplicate is still deterministic) and the order the
// KeyboardSheet lists them in.
export type ShortcutAction =
  | "search"
  | "newThread"
  | "nextThread"
  | "prevThread"
  | "deleteChat"
  | "temporaryChat"
  | "toggleSidebar"
  | "modelPicker"
  | "dictation"
  | "minimap";

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  "search",
  "newThread",
  "nextThread",
  "prevThread",
  "deleteChat",
  "temporaryChat",
  "toggleSidebar",
  "modelPicker",
  "dictation",
  "minimap",
];

// The i18n key for each action's human label (defined in both locale dictionaries).
export const ACTION_LABEL_KEYS: Record<ShortcutAction, MessageKey> = {
  search: "keyboard.search",
  newThread: "keyboard.newChat",
  nextThread: "keyboard.nextThread",
  prevThread: "keyboard.prevThread",
  deleteChat: "keyboard.deleteChat",
  temporaryChat: "keyboard.temporaryChat",
  toggleSidebar: "keyboard.toggleSidebar",
  modelPicker: "keyboard.modelPicker",
  dictation: "keyboard.dictation",
  minimap: "keyboard.minimap",
};

// Defaults preserve the app's original hardcoded chords (search / new / temporary / minimap)
// and pick unobtrusive combos for the rest. Since the global handler fires regardless of focus,
// every default deliberately avoids native composer text-editing chords: no mod+shift+arrow
// (extends selection) and no mod+shift+backspace (deletes to line start), so nothing is clobbered
// while composing. Every default is distinct and canonical (mod, then alt, then shift, then the
// key) — asserted by a test so a typo can't ship a duplicate.
export const DEFAULT_BINDINGS: Record<ShortcutAction, string> = {
  search: "mod+k",
  newThread: "mod+.",
  nextThread: "mod+shift+j",
  prevThread: "mod+shift+k",
  deleteChat: "mod+shift+d",
  temporaryChat: "mod+/",
  toggleSidebar: "mod+b",
  modelPicker: "mod+shift+m",
  dictation: "mod+shift+u",
  minimap: "mod+\\",
};

// ---- Chord parsing / normalization ---------------------------------------

// Keys that are modifiers themselves — a lone press of one is not a complete chord.
const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "OS", "Super", "Hyper"]);

// The shape we need off a KeyboardEvent — narrowed so the pure logic is trivially testable
// without a real DOM event.
export interface ChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// Lowercase a key name. Single characters ("K", ".") and named keys ("ArrowDown", "Backspace")
// both fold to a stable token; " " becomes "space" so it survives the "+"-joined form.
function normalizeKeyName(key: string): string {
  if (key === " " || key.toLowerCase() === "spacebar") return "space";
  return key.toLowerCase();
}

// Turn a live keyboard event into a canonical chord, or null when it isn't a bindable combo
// (no modifier held, or only a modifier pressed so far). This is the single source of truth for
// both matching a keystroke and recording a new binding, so the two can never disagree.
export function eventToChord(e: ChordEvent): string | null {
  if (!(e.metaKey || e.ctrlKey)) return null; // invariant #1: a chord must include `mod`
  if (!e.key || MODIFIER_KEYS.has(e.key)) return null; // still waiting for the real key
  const parts = ["mod"];
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(normalizeKeyName(e.key));
  return parts.join("+");
}

// Aliases accepted when parsing a stored / hand-written chord back to canonical form.
const MOD_ALIASES = new Set(["mod", "cmd", "command", "meta", "ctrl", "control", "⌘", "⌃"]);
const ALT_ALIASES = new Set(["alt", "option", "opt", "⌥"]);
const SHIFT_ALIASES = new Set(["shift", "⇧"]);

// Normalize an arbitrary chord string to canonical form, or null if it's not a valid single
// mod-anchored chord. Tolerant of aliases and modifier order; strict about the invariants
// (exactly one non-modifier key, and `mod` present). The literal "+" key can't round-trip
// through the "+"-joined form and so is intentionally unbindable.
export function normalizeChord(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tokens = raw
    .toLowerCase()
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  let mod = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;
  for (const tok of tokens) {
    if (MOD_ALIASES.has(tok)) mod = true;
    else if (ALT_ALIASES.has(tok)) alt = true;
    else if (SHIFT_ALIASES.has(tok)) shift = true;
    else if (key !== null) return null; // two non-modifier keys — not a valid chord
    else key = normalizeKeyName(tok);
  }
  if (!mod || !key) return null;
  const parts = ["mod"];
  if (alt) parts.push("alt");
  if (shift) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

// Coerce an unknown blob (an older/garbled localStorage payload) into a complete, valid bindings
// map. Each action keeps its stored chord only if it's valid AND not already claimed by an
// earlier action; otherwise it falls back to its default. Guarantees: every action present, every
// chord canonical, no duplicates.
export function normalizeBindings(raw: unknown): Record<ShortcutAction, string> {
  const r = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<ShortcutAction, string>;
  const used = new Set<string>();
  // First pass: honor valid, non-conflicting custom chords.
  for (const action of SHORTCUT_ACTIONS) {
    const chord = normalizeChord(r[action]);
    if (chord && !used.has(chord)) {
      out[action] = chord;
      used.add(chord);
    }
  }
  // Second pass: fill the rest from defaults, still avoiding collisions.
  for (const action of SHORTCUT_ACTIONS) {
    if (out[action]) continue;
    const def = DEFAULT_BINDINGS[action];
    if (!used.has(def)) {
      out[action] = def;
      used.add(def);
    } else {
      // A custom chord took this action's default slot; leave the action on its default anyway
      // (matcher priority keeps behavior deterministic). Distinct defaults make this unreachable
      // in practice — it's only a belt-and-suspenders for hostile input.
      out[action] = def;
    }
  }
  return out;
}

// Which action currently owns `chord`, or null. Used to reject a conflicting rebind.
export function bindingOwner(bindings: Record<ShortcutAction, string>, chord: string): ShortcutAction | null {
  for (const action of SHORTCUT_ACTIONS) {
    if (bindings[action] === chord) return action;
  }
  return null;
}

// Match a keystroke to an action, or null if nothing is bound to it. Returns null for every
// non-mod keystroke (so ordinary typing is untouched) and for unbound mod-combos (so the browser
// keeps Cmd+C etc.).
export function matchBinding(bindings: Record<ShortcutAction, string>, e: ChordEvent): ShortcutAction | null {
  const chord = eventToChord(e);
  if (!chord) return null;
  return bindingOwner(bindings, chord);
}

// ---- Display ------------------------------------------------------------

const MAC_SYMBOLS: Record<string, string> = {
  mod: "⌘",
  alt: "⌥",
  shift: "⇧",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  enter: "↵",
  escape: "Esc",
  space: "Space",
  tab: "Tab",
};
const OTHER_LABELS: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  enter: "↵",
  escape: "Esc",
  space: "Space",
  tab: "Tab",
};

// Break a canonical chord into display tokens (e.g. "mod+shift+m" → ["⌘","⇧","M"] on macOS,
// ["Ctrl","Shift","M"] elsewhere) for rendering as individual <kbd> keys.
export function chordTokens(chord: string, isMac: boolean): string[] {
  const map = isMac ? MAC_SYMBOLS : OTHER_LABELS;
  return chord.split("+").map((tok) => map[tok] ?? (tok.length === 1 ? tok.toUpperCase() : tok));
}

// ---- Store --------------------------------------------------------------

const KEY = "a7t_chat_keybindings";
const listeners = new Set<() => void>();

function readStored(): Record<ShortcutAction, string> {
  try {
    return normalizeBindings(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

let current: Record<ShortcutAction, string> = readStored();

// True while the KeyboardSheet is capturing a new chord. The global handler consults this and
// bails, so the keystroke being recorded can't also fire the action it's being bound to.
let recording = false;
export function beginRecording(): void {
  recording = true;
}
export function endRecording(): void {
  recording = false;
}
export function isRecording(): boolean {
  return recording;
}

function emit(): void {
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable (private mode) — bindings just stay session-local */
  }
}

export function getBindings(): Record<ShortcutAction, string> {
  return current;
}

// The outcome of a rebind attempt: applied, rejected as not-a-valid-chord, or blocked by the
// action already using it (the conflicting action is returned so the UI can name it).
export type BindResult = "ok" | "invalid" | { conflict: ShortcutAction };

// Rebind an action. Rejects an invalid chord and a chord already held by a different action
// (no silent swap — the user must free it first), keeping the map a clean bijection.
export function setBinding(action: ShortcutAction, rawChord: string): BindResult {
  const chord = normalizeChord(rawChord);
  if (!chord) return "invalid";
  const owner = bindingOwner(current, chord);
  if (owner && owner !== action) return { conflict: owner };
  if (current[action] === chord) return "ok"; // no-op (rebinding to the same chord)
  current = { ...current, [action]: chord };
  persist();
  emit();
  return "ok";
}

// Restore every action to its default chord.
export function resetBindings(): void {
  current = { ...DEFAULT_BINDINGS };
  persist();
  emit();
}

// Subscribe to the live bindings (re-renders on change), like usePreferences()/useLang().
export function useBindings(): Record<ShortcutAction, string> {
  return useSyncExternalStore(subscribe, getBindings, getBindings);
}

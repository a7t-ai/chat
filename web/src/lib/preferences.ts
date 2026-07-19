// Client half of the Customize feature (#11). Mirrors the server's Preferences shape
// (src/settings/preferences.ts) and owns applying the visual + accessibility choices to the
// DOM. Persisting a change server-side (PUT /api/settings) is what propagates it to the user's
// other instances — each reads it back from /api/me on load (syncPreferences). Persona is
// consumed server-side (injected into the system prompt); the rest is applied here.
//
// A tiny module-level store (useSyncExternalStore) mirrors the i18n/theme runtimes so any
// component (the composer's Enter-to-send behavior, the SettingsPanel state) re-renders the
// moment a preference changes.

import { useSyncExternalStore } from "react";
import { saveSettings } from "./api";

export interface Persona {
  name: string;
  role: string;
  traits: string[];
  extra: string;
}
export interface Behavior {
  enterToSend: boolean;
  timerSound: boolean; // play the synthesized chime when a recipe-step timer ends
}
export type MainFont = "sans" | "serif" | "system";
export type CodeFont = "mono" | "system";
export type Density = "comfortable" | "compact";
export interface Visual {
  mainFont: MainFont;
  codeFont: CodeFont;
  density: Density;
}
export interface Accessibility {
  fontScale: number;
  reducedMotion: boolean;
  highContrast: boolean;
  dyslexiaFont: boolean;
}
// Memory (#27) — the archivist opt-out. Consumed SERVER-side (it gates whether durable memory is
// read into / written from a turn); the client only reflects + toggles it here so the switch syncs
// across the user's instances like every other preference.
export interface Memory {
  enabled: boolean;
}
export interface Preferences {
  persona: Persona;
  behavior: Behavior;
  visual: Visual;
  accessibility: Accessibility;
  memory: Memory;
}

// A section-wise partial patch (what the SettingsPanel emits on each control change).
export interface PreferencesPatch {
  persona?: Partial<Persona>;
  behavior?: Partial<Behavior>;
  visual?: Partial<Visual>;
  accessibility?: Partial<Accessibility>;
  memory?: Partial<Memory>;
}

// ---- Bounds + option lists (kept in sync with the server) -----------------
export const NAME_MAX = 80;
export const ROLE_MAX = 80;
export const EXTRA_MAX = 600;
export const TRAIT_MAX = 40;
export const TRAITS_MAX = 8;
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.4;

export const MAIN_FONTS: readonly MainFont[] = ["sans", "serif", "system"];
export const CODE_FONTS: readonly CodeFont[] = ["mono", "system"];
export const DENSITIES: readonly Density[] = ["comfortable", "compact"];
export const TRAIT_SUGGESTIONS: readonly string[] = [
  "friendly",
  "witty",
  "concise",
  "encouraging",
  "direct",
  "analytical",
  "creative",
  "patient",
];

export const DEFAULT_PREFERENCES: Preferences = {
  persona: { name: "", role: "", traits: [], extra: "" },
  behavior: { enterToSend: true, timerSound: true },
  visual: { mainFont: "sans", codeFont: "mono", density: "comfortable" },
  accessibility: { fontScale: 1, reducedMotion: false, highContrast: false, dyslexiaFont: false },
  memory: { enabled: true },
};

// ---- Normalization (defends the client against an older/garbled /api/me) ---
function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function boundedString(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function boolOr(v: unknown, fb: boolean): boolean {
  return typeof v === "boolean" ? v : fb;
}
function enumOr<T extends string>(v: unknown, allowed: readonly T[], fb: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fb;
}
function clampNumber(v: unknown, min: number, max: number, fb: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;
}
function normalizeTraits(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v.slice(0, 200)) {
    const t = boundedString(raw, TRAIT_MAX);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= TRAITS_MAX) break;
  }
  return out;
}

export function normalizePreferences(raw: unknown): Preferences {
  const r = asRecord(raw);
  const persona = asRecord(r.persona);
  const behavior = asRecord(r.behavior);
  const visual = asRecord(r.visual);
  const a11y = asRecord(r.accessibility);
  const memory = asRecord(r.memory);
  const d = DEFAULT_PREFERENCES;
  return {
    persona: {
      name: boundedString(persona.name, NAME_MAX),
      role: boundedString(persona.role, ROLE_MAX),
      traits: normalizeTraits(persona.traits),
      extra: boundedString(persona.extra, EXTRA_MAX),
    },
    behavior: {
      enterToSend: boolOr(behavior.enterToSend, d.behavior.enterToSend),
      timerSound: boolOr(behavior.timerSound, d.behavior.timerSound),
    },
    visual: {
      mainFont: enumOr(visual.mainFont, MAIN_FONTS, d.visual.mainFont),
      codeFont: enumOr(visual.codeFont, CODE_FONTS, d.visual.codeFont),
      density: enumOr(visual.density, DENSITIES, d.visual.density),
    },
    accessibility: {
      fontScale: clampNumber(a11y.fontScale, FONT_SCALE_MIN, FONT_SCALE_MAX, d.accessibility.fontScale),
      reducedMotion: boolOr(a11y.reducedMotion, d.accessibility.reducedMotion),
      highContrast: boolOr(a11y.highContrast, d.accessibility.highContrast),
      dyslexiaFont: boolOr(a11y.dyslexiaFont, d.accessibility.dyslexiaFont),
    },
    memory: { enabled: boolOr(memory.enabled, d.memory.enabled) },
  };
}

// ---- DOM application ------------------------------------------------------
// We OVERRIDE the base design tokens (--font-sans / --font-mono) on the document root rather
// than introduce parallel vars: every existing rule already reads these, so the choice applies
// app-wide with no stylesheet churn. The "sans"/"mono" defaults reproduce tokens.css EXACTLY
// (keep these literal stacks in sync with web/src/styles/tokens.css).
const FONT_STACKS: Record<MainFont, string> = {
  sans: '"Switzer", ui-sans-serif, system-ui, -apple-system, sans-serif',
  serif: '"Instrument Serif", Georgia, "Times New Roman", serif',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
const CODE_STACKS: Record<CodeFont, string> = {
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
  system: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
// Dyslexia-friendly stack: OpenDyslexic if the reader has it installed, else a plain, evenly
// spaced fallback. Paired with extra letter/word spacing in CSS ([data-dysfont="on"]).
const DYSLEXIA_STACK = '"OpenDyslexic", "Comic Sans MS", "Segoe UI", system-ui, sans-serif';

function setFlag(root: HTMLElement, name: string, on: boolean, value: string): void {
  if (on) root.dataset[name] = value;
  else delete root.dataset[name];
}

// Push a preferences object onto the document root as CSS variables + data-attributes that the
// stylesheet keys off. Accessibility wins over Visual where they collide (the dyslexia font
// overrides the chosen main font — it's a need, not a preference).
export function applyPreferences(prefs: Preferences): void {
  const root = document.documentElement;
  const a11y = prefs.accessibility;
  const mainStack = a11y.dyslexiaFont ? DYSLEXIA_STACK : FONT_STACKS[prefs.visual.mainFont];
  root.style.setProperty("--font-sans", mainStack);
  root.style.setProperty("--font-mono", CODE_STACKS[prefs.visual.codeFont]);
  root.style.setProperty("--font-scale", String(a11y.fontScale));
  root.dataset.density = prefs.visual.density;
  setFlag(root, "motion", a11y.reducedMotion, "reduced");
  setFlag(root, "contrast", a11y.highContrast, "high");
  setFlag(root, "dysfont", a11y.dyslexiaFont, "on");
}

// ---- Store ----------------------------------------------------------------
const KEY = "a7t_chat_prefs";
const listeners = new Set<() => void>();

function readStored(): Preferences {
  try {
    return normalizePreferences(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

let current: Preferences = readStored();

function emit(): void {
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getPreferences(): Preferences {
  return current;
}

function persistLocal(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable (private mode) — the account sync is the source of truth anyway */
  }
}

// Apply a section-wise patch: merge onto the current prefs, normalize, persist locally, apply to
// the DOM, notify subscribers, and sync to the account. A blank/omitted section is untouched.
export function setPreferences(patch: PreferencesPatch): void {
  current = normalizePreferences({
    persona: { ...current.persona, ...(patch.persona ?? {}) },
    behavior: { ...current.behavior, ...(patch.behavior ?? {}) },
    visual: { ...current.visual, ...(patch.visual ?? {}) },
    accessibility: { ...current.accessibility, ...(patch.accessibility ?? {}) },
    memory: { ...current.memory, ...(patch.memory ?? {}) },
  });
  persistLocal();
  applyPreferences(current);
  emit();
  void saveSettings({ preferences: current }).catch(() => {}); // shared across the user's instances
}

// Apply account-provided preferences on login WITHOUT re-saving them (avoids an echo write).
export function syncPreferences(server: Preferences | null | undefined): void {
  if (!server) return;
  current = normalizePreferences(server);
  persistLocal();
  applyPreferences(current);
  emit();
}

// First paint: apply whatever is in localStorage (avoids a flash before /api/me resolves).
export function initPreferences(): void {
  applyPreferences(current);
}

// Subscribe to the live preferences (re-renders on change), like useLang().
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getPreferences, getPreferences);
}

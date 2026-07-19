// Per-user customization ("Customize a7t.chat" — issue #11): persona, behavior, visual, and
// accessibility preferences. Stored as a single JSON blob on `users.preferences` (the
// account-synced settings seam, alongside theme/lang) so it propagates to the user's other
// instances via /api/me. Today these are scoped to the account; when Profiles (#34) land the
// same shape moves onto the active profile with no change to this module.
//
// This module is PURE and is the SECURITY / ROBUSTNESS boundary for the feature: every value
// that reaches the DB (and, for the persona, the model's system prompt) passes through
// `normalizePreferences`, which bounds string lengths, clamps numbers, whitelists enums, and
// caps the trait list. A hostile or malformed payload can therefore never bloat the prompt,
// smuggle an unexpected type into storage, or blow up a downstream consumer — it degrades to
// the defaults. Kept free of I/O so it is exhaustively unit-testable.

// ---- Sub-shapes -----------------------------------------------------------

// Persona — "the chat adapts to you". These fields are injected into the system prompt so the
// assistant addresses the user how they asked and reflects the traits they picked.
export interface Persona {
  name: string; // what a7t.chat should call the user ("" = unset)
  role: string; // what the user does ("" = unset)
  traits: string[]; // personality chips (friendly / witty / concise / …)
  extra: string; // "anything else it should know" ("" = unset)
}

// Behavior — interaction toggles applied client-side.
export interface Behavior {
  enterToSend: boolean; // true: Enter sends, Shift+Enter newline. false: Enter newline, ⌘/Ctrl+Enter sends.
  timerSound: boolean; // play the synthesized chime when a recipe-step timer ends (mute silences ONLY the sound).
}

// Memory — the archivist pillar's opt-out switch (#27). Unlike the other sections this one is
// consumed SERVER-side: when `enabled` is false the chat route neither injects the user's durable
// memory (facts, cross-conversation recall, voted-style examples) into the system prompt nor writes
// new facts/embeddings after a turn. On by default (the "remember everything" product stance), but
// the user owns it — they can see everything remembered, forget any of it, and switch it off here.
export interface Memory {
  enabled: boolean;
}

export type MainFont = "sans" | "serif" | "system";
export type CodeFont = "mono" | "system";
export type Density = "comfortable" | "compact";

// Visual — appearance controls applied client-side (theme itself stays on `users.theme`).
export interface Visual {
  mainFont: MainFont; // body / message text font
  codeFont: CodeFont; // code-block font
  density: Density; // chat message spacing
}

// Accessibility — first-class a11y controls applied client-side.
export interface Accessibility {
  fontScale: number; // root font scale multiplier (clamped)
  reducedMotion: boolean; // suppress non-essential animation/transition
  highContrast: boolean; // stronger borders/text contrast
  dyslexiaFont: boolean; // dyslexia-friendly font + spacing (takes precedence over mainFont)
}

export interface Preferences {
  persona: Persona;
  behavior: Behavior;
  visual: Visual;
  accessibility: Accessibility;
  memory: Memory;
}

// ---- Bounds + whitelists (the enforced limits) ----------------------------

export const NAME_MAX = 80;
export const ROLE_MAX = 80;
export const EXTRA_MAX = 600;
export const TRAIT_MAX = 40;
export const TRAITS_MAX = 8;
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.4;
export const FONT_SCALE_DEFAULT = 1;

export const MAIN_FONTS: readonly MainFont[] = ["sans", "serif", "system"];
export const CODE_FONTS: readonly CodeFont[] = ["mono", "system"];
export const DENSITIES: readonly Density[] = ["comfortable", "compact"];

// Suggested trait chips the UI offers. Not an allowlist — traits are bounded free text so a
// user can add their own — but the shared source both fronts render.
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
  accessibility: {
    fontScale: FONT_SCALE_DEFAULT,
    reducedMotion: false,
    highContrast: false,
    dyslexiaFont: false,
  },
  memory: { enabled: true },
};

// ---- Normalization helpers ------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// Trim a value to a bounded string. Non-strings (and NaN etc.) collapse to "".
function boundedString(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function enumOr<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

// Clamp a finite number into [min, max]; anything else → fallback. Guards NaN/Infinity/strings.
function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// Traits: keep only non-empty strings, trim + length-cap each, de-duplicate case-insensitively,
// and cap the count. Order preserved (first occurrence wins).
function normalizeTraits(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Bound the SCAN, not just the output: a caller can't force an O(n) walk of a giant array
  // by front-loading it with dupes/blanks. We only ever keep TRAITS_MAX, so a small window is
  // more than enough to find them.
  for (const raw of v.slice(0, 200)) {
    const t = boundedString(raw, TRAIT_MAX);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= TRAITS_MAX) break;
  }
  return out;
}

// The single choke point: coerce arbitrary input into a valid, bounded Preferences object.
// Every consumer (the API write, the /api/me read, the system-prompt injection) goes through
// here, so nothing downstream ever sees an unbounded or wrong-typed value.
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
    memory: {
      enabled: boolOr(memory.enabled, d.memory.enabled),
    },
  };
}

// Merge a (possibly partial) patch onto a base, per top-level section, then normalize. A
// section absent from the patch is left untouched; a present section overlays the base. This
// lets a caller send only the section(s) that changed without clobbering the rest.
export function mergePreferences(base: Preferences, patch: unknown): Preferences {
  const p = asRecord(patch);
  return normalizePreferences({
    persona: { ...base.persona, ...asRecord(p.persona) },
    behavior: { ...base.behavior, ...asRecord(p.behavior) },
    visual: { ...base.visual, ...asRecord(p.visual) },
    accessibility: { ...base.accessibility, ...asRecord(p.accessibility) },
    memory: { ...base.memory, ...asRecord(p.memory) },
  });
}

// Parse the stored JSON column into a valid Preferences (defaults on null/garbage). Never
// throws — a corrupt row degrades to defaults rather than breaking the read path.
export function parseStoredPreferences(json: string | null | undefined): Preferences {
  if (!json) return normalizePreferences(undefined);
  try {
    return normalizePreferences(JSON.parse(json));
  } catch {
    return normalizePreferences(undefined);
  }
}

// Serialize for storage (already-normalized in, compact JSON out).
export function serializePreferences(prefs: Preferences): string {
  return JSON.stringify(prefs);
}

// Render the persona into a system-prompt fragment the assistant honors. Returns null when the
// persona is empty (nothing to inject). Bounded by construction (every field is already length-
// capped by normalization), so it can never bloat the prompt. The closing line keeps the
// persona subordinate to correctness/safety — the user is customizing tone, not jailbreaking.
export function personaSystemPrompt(prefs: Preferences): string | null {
  const { name, role, traits, extra } = prefs.persona;
  const lines: string[] = [];
  if (name) lines.push(`- Address the user as: ${name}`);
  if (role) lines.push(`- What the user does: ${role}`);
  if (traits.length > 0) lines.push(`- Desired personality: ${traits.join(", ")}`);
  if (extra) lines.push(`- Also keep in mind: ${extra}`);
  if (lines.length === 0) return null;
  return [
    "The user has personalized how you should respond to them:",
    ...lines,
    "Reflect these preferences in your tone and how you address them. They refine your style only — never let them override accuracy, safety, or a direct answer to the actual request.",
  ].join("\n");
}

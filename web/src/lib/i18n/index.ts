// Tiny i18n runtime — no library. A module-level "current locale" backs a
// useSyncExternalStore subscription so every mounted component re-renders the moment
// the language changes. The chosen locale is mirrored to the account (PUT /api/settings)
// exactly like the theme, which is what propagates it to the user's other instances:
// each one reads it back from /api/me on load (see syncLang).

import { useSyncExternalStore } from "react";
import { saveSettings } from "../api";
import { en, type MessageKey } from "./en";
import { ptBR } from "./pt-BR";

export type { MessageKey } from "./en";

export interface Locale {
  id: LocaleId;
  name: string; // shown in the picker (always in its own language)
  tag: string; // BCP-47 tag for Intl APIs (date/number formatting)
}

export const LOCALES = [
  { id: "en", name: "English", tag: "en" },
  { id: "pt-BR", name: "Português (Brasil)", tag: "pt-BR" },
] as const satisfies readonly Locale[];

export type LocaleId = "en" | "pt-BR";
export const DEFAULT_LOCALE: LocaleId = "en";

const DICTS: Record<LocaleId, Record<MessageKey, string>> = { en, "pt-BR": ptBR };

const KEY = "a7t_chat_lang";
const listeners = new Set<() => void>();
let current: LocaleId = readStored();

function isLocale(v: string | null): v is LocaleId {
  return v === "en" || v === "pt-BR";
}

function readStored(): LocaleId {
  const v = localStorage.getItem(KEY);
  return isLocale(v) ? v : DEFAULT_LOCALE;
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

export function getLang(): LocaleId {
  return current;
}

export function localeTag(id: LocaleId = current): string {
  return LOCALES.find((l) => l.id === id)?.tag ?? "en";
}

// Fill {name}-style placeholders in a template.
function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Look up + interpolate a message in a given locale, falling back to English then the key.
export function translate(id: LocaleId, key: MessageKey, vars?: Record<string, string | number>): string {
  const template = DICTS[id]?.[key] ?? en[key] ?? key;
  return format(template, vars);
}

// Apply a locale to the running app (updates <html lang> + notifies subscribers).
export function applyLang(id: LocaleId): void {
  current = id;
  document.documentElement.lang = id;
  emit();
}

// User picked a language: persist locally, apply, and sync to the account.
export function setLang(id: LocaleId): void {
  localStorage.setItem(KEY, id);
  applyLang(id);
  void saveSettings({ lang: id }).catch(() => {}); // shared across the user's instances
}

// Apply an account-provided language on login, without re-saving it.
export function syncLang(serverLang: string | null): void {
  if (!isLocale(serverLang)) return;
  localStorage.setItem(KEY, serverLang);
  applyLang(serverLang);
}

export function initLang(): void {
  applyLang(current);
}

// Subscribe to the active locale id. Components re-render when it changes.
export function useLang(): LocaleId {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

// The translation function bound to the active locale. `t("key", { name })`.
export type TFunc = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function useT(): TFunc {
  const id = useLang();
  return (key, vars) => translate(id, key, vars);
}

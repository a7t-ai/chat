import { saveSettings } from "./api";
import { DEFAULT_THEME_ID, type Theme, THEMES, type ThemeColors } from "./themes";

const KEY = "a7t_chat_theme";

const VAR: Record<keyof ThemeColors, string> = {
  bg: "--bg",
  surface: "--surface",
  surface2: "--surface-2",
  border: "--border",
  text: "--text",
  muted: "--muted",
  accent: "--accent",
  send: "--send",
};

export function getThemeId(): string {
  return localStorage.getItem(KEY) ?? DEFAULT_THEME_ID;
}

export function findTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function applyTheme(id: string): void {
  const t = findTheme(id);
  const root = document.documentElement;
  (Object.keys(VAR) as (keyof ThemeColors)[]).forEach((k) => {
    root.style.setProperty(VAR[k], t.colors[k]);
  });
  root.style.colorScheme = t.dark ? "dark" : "light";
  root.dataset.theme = t.id;
  root.dataset.mode = t.dark ? "dark" : "light"; // drives the dark/light lockup variant
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.colors.bg);
}

export function setTheme(id: string): void {
  localStorage.setItem(KEY, id);
  applyTheme(id);
  void saveSettings({ theme: id }).catch(() => {}); // persist to the account (shared across browsers)
}

// Apply a server-provided theme on login, without re-saving it.
export function syncTheme(serverTheme: string | null): void {
  if (!serverTheme) return;
  localStorage.setItem(KEY, serverTheme);
  applyTheme(serverTheme);
}

export function initTheme(): void {
  applyTheme(getThemeId());
}

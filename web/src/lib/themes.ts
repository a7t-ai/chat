// Theme registry. Each theme is a set of CSS-variable values applied to :root.
// a7t themes use the a7t.ai palette (foundations.jsx); the rest are our own takes on
// well-known color schemes (original names).

export interface ThemeColors {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  // Primary CTA color (the composer's "send" button). Picked per theme so the
  // affordance reads in the palette's own hue family; white icon sits on top, so
  // each value is saturated/dark enough to keep that arrow legible.
  send: string;
}

export interface Theme {
  id: string;
  name: string;
  group: "a7t" | "Classic";
  dark: boolean;
  colors: ThemeColors;
}

export const THEMES: Theme[] = [
  // --- a7t ---
  {
    id: "a7t-charcoal",
    name: "Charcoal",
    group: "a7t",
    dark: true,
    colors: { bg: "#101012", surface: "#19191c", surface2: "#212126", border: "#2b2b30", text: "#ececec", muted: "#9b9ba2", accent: "#2d9b9b", send: "#2d9b9b" },
  },
  {
    id: "a7t-teal-night",
    name: "Teal Night",
    group: "a7t",
    dark: true,
    colors: { bg: "#0b3838", surface: "#0f4444", surface2: "#135050", border: "#1f6b6b", text: "#d7ecec", muted: "#7fcdcd", accent: "#7fcdcd", send: "#2d9b9b" },
  },
  {
    id: "a7t-white",
    name: "White",
    group: "a7t",
    dark: false,
    colors: { bg: "#ffffff", surface: "#f5f4f1", surface2: "#ecebe6", border: "#e3e1da", text: "#0a0f0f", muted: "#4a5454", accent: "#1f6b6b", send: "#1f6b6b" },
  },
  {
    id: "a7t-pastel",
    name: "Pastel",
    group: "a7t",
    dark: false,
    colors: { bg: "#f7f1e8", surface: "#efe6d3", surface2: "#e7dcc4", border: "#dccfb4", text: "#0a0f0f", muted: "#4a5454", accent: "#1f6b6b", send: "#1f6b6b" },
  },
  {
    id: "a7t-green",
    name: "Green",
    group: "a7t",
    dark: false,
    colors: { bg: "#eef3ef", surface: "#e0ebe2", surface2: "#d3e2d6", border: "#c5d8c9", text: "#0a1f17", muted: "#45615a", accent: "#1f6b6b", send: "#1f6b6b" },
  },
  // --- Classic (our own names) ---
  {
    id: "dracula",
    name: "Nightshade",
    group: "Classic",
    dark: true,
    colors: { bg: "#282a36", surface: "#2f3140", surface2: "#383a4a", border: "#44475a", text: "#f8f8f2", muted: "#8b8fa3", accent: "#bd93f9", send: "#7c5cf6" },
  },
  {
    id: "nord",
    name: "Fjord",
    group: "Classic",
    dark: true,
    colors: { bg: "#2e3440", surface: "#353c4a", surface2: "#3b4252", border: "#434c5e", text: "#eceff4", muted: "#8893a8", accent: "#88c0d0", send: "#5e81ac" },
  },
  {
    id: "nord-light",
    name: "Fjord Light",
    group: "Classic",
    dark: false,
    colors: { bg: "#eceff4", surface: "#e5e9f0", surface2: "#d8dee9", border: "#c8d0de", text: "#2e3440", muted: "#4c566a", accent: "#5e81ac", send: "#5e81ac" },
  },
  {
    id: "tokyo-night",
    name: "Harbor",
    group: "Classic",
    dark: true,
    colors: { bg: "#1a1b26", surface: "#1f2335", surface2: "#24283b", border: "#2f334d", text: "#c0caf5", muted: "#787c99", accent: "#7aa2f7", send: "#5470d6" },
  },
  {
    id: "catppuccin-mocha",
    name: "Mocha",
    group: "Classic",
    dark: true,
    colors: { bg: "#1e1e2e", surface: "#242436", surface2: "#313244", border: "#45475a", text: "#cdd6f4", muted: "#9399b2", accent: "#cba6f7", send: "#8839ef" },
  },
  {
    id: "rose-pine",
    name: "Rosewood",
    group: "Classic",
    dark: true,
    colors: { bg: "#191724", surface: "#1f1d2e", surface2: "#26233a", border: "#403d52", text: "#e0def4", muted: "#908caa", accent: "#ebbcba", send: "#b4637a" },
  },
  {
    id: "gruvbox-dark",
    name: "Ember",
    group: "Classic",
    dark: true,
    colors: { bg: "#282828", surface: "#32302f", surface2: "#3c3836", border: "#504945", text: "#ebdbb2", muted: "#a89984", accent: "#fabd2f", send: "#d65d0e" },
  },
  {
    id: "gruvbox-light",
    name: "Parchment",
    group: "Classic",
    dark: false,
    colors: { bg: "#fbf1c7", surface: "#f2e5bc", surface2: "#ebdbb2", border: "#d5c4a1", text: "#3c3836", muted: "#7c6f64", accent: "#b57614", send: "#d65d0e" },
  },
  {
    id: "solarized-dark",
    name: "Deep Sea",
    group: "Classic",
    dark: true,
    colors: { bg: "#002b36", surface: "#073642", surface2: "#0a4250", border: "#0f4d5c", text: "#93a1a1", muted: "#657b83", accent: "#2aa198", send: "#268bd2" },
  },
  {
    id: "solarized-light",
    name: "Daybreak",
    group: "Classic",
    dark: false,
    colors: { bg: "#fdf6e3", surface: "#eee8d5", surface2: "#e4ddc8", border: "#d6cfb8", text: "#586e75", muted: "#93a1a1", accent: "#268bd2", send: "#268bd2" },
  },
  {
    id: "monokai",
    name: "Citrus",
    group: "Classic",
    dark: true,
    colors: { bg: "#272822", surface: "#2f302a", surface2: "#3a3b32", border: "#49483e", text: "#f8f8f2", muted: "#9a9682", accent: "#a6e22e", send: "#e8590c" },
  },
  {
    id: "everforest-dark",
    name: "Evergreen",
    group: "Classic",
    dark: true,
    colors: { bg: "#2d353b", surface: "#343f44", surface2: "#3d484d", border: "#4a555b", text: "#d3c6aa", muted: "#859289", accent: "#a7c080", send: "#4f9d5a" },
  },
];

export const DEFAULT_THEME_ID = "a7t-charcoal";

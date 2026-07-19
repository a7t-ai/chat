import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initLang } from "./lib/i18n";
import { initPreferences } from "./lib/preferences";
import { initTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/ui.css";
import "./styles/app.css";

initTheme();
initLang();
initPreferences();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

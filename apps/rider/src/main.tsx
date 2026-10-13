import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initI18n } from "@verify/shared";
import "@verify/shared/src/styles.css";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import { App } from "./App";

initI18n({ en: { translation: en }, fr: { translation: fr } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

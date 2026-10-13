import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configureSupabase, initI18n } from "@verify/shared";
import "@verify/shared/src/styles.css";
import "./dashboard.css";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import { App } from "./App";

// Staff stay signed in across reloads; the session never arrives through the URL (no magic links).
configureSupabase({ auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });

initI18n({ en: { translation: en }, fr: { translation: fr } });

const root = createRoot(document.getElementById("root")!);

// Dev-only screen preview with fake data (?screen=<name>), for screenshots. The whole branch,
// including the dynamic import, is removed from production builds.
const previewScreen = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("screen") : null;

if (import.meta.env.DEV && previewScreen) {
  void import("./dev/Preview").then(({ Preview }) =>
    root.render(
      <StrictMode>
        <Preview screen={previewScreen} />
      </StrictMode>,
    ),
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

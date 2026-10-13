import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configureSupabase, initI18n } from "@verify/shared";
import "@verify/shared/src/styles.css";
import "./rider.css";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import { App } from "./App";
import { AppErrorBoundary } from "./ErrorBoundary";
import { STORAGE_UPLOAD_TIMEOUT_MS, timeoutFetch } from "./flow/timeoutFetch";
import { reloadOnNewLink, takeSessionToken } from "./flow/token";

// Riders never sign in: no auth session to keep, refresh or read from the URL. The client is only
// used for the photo upload, which must not hang for ever on a stalled connection.
configureSupabase({
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: timeoutFetch(STORAGE_UPLOAD_TIMEOUT_MS) },
});

initI18n({ en: { translation: en }, fr: { translation: fr } });

const root = createRoot(document.getElementById("root")!);
const search = new URLSearchParams(window.location.search);

// Dev-only screen preview with fake data (?screen=<name>), for screenshots. The whole branch,
// including the dynamic import, is removed from production builds.
const previewScreen = import.meta.env.DEV ? search.get("screen") : null;

if (import.meta.env.DEV && previewScreen) {
  void import("./dev/Preview").then(({ Preview }) =>
    root.render(
      <StrictMode>
        <Preview screen={previewScreen} />
      </StrictMode>,
    ),
  );
} else {
  // Read the session token from #s=... and remove it from the address bar before anything renders.
  const boot = takeSessionToken();
  // A newer link opened in this same tab starts over with it.
  reloadOnNewLink();
  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <App boot={boot} debug={search.get("debug") === "1"} />
      </AppErrorBoundary>
    </StrictMode>,
  );
}

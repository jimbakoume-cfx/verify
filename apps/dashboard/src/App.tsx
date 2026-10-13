import { useTranslation } from "react-i18next";
import { Brand, LanguageToggle, ServerStatus } from "@verify/shared";

const MODULES = ["queue", "caseView", "search", "metrics", "thresholds", "audit"] as const;

export function App() {
  const { t } = useTranslation();
  return (
    <main className="page">
      <header className="topbar">
        <Brand product="Verify Ops" />
        <LanguageToggle />
      </header>

      <section className="card">
        <h1>{t("title")}</h1>
        <p>{t("intro")}</p>
        <p className="muted">{t("staffOnly")}</p>
      </section>

      <section className="card">
        <h2>{t("planned.title")}</h2>
        <ol className="steps">
          {MODULES.map((m) => (
            <li key={m}>{t(`planned.${m}`)}</li>
          ))}
        </ol>
      </section>

      <button type="button" className="primary" disabled>
        {t("signIn")}
      </button>
      <p className="muted">{t("comingSoon")}</p>

      <footer className="footer">
        <ServerStatus />
        <div>
          {t("build")}: {__BUILD_ID__}
        </div>
      </footer>
    </main>
  );
}

import { useTranslation } from "react-i18next";
import { Brand, LanguageToggle, ServerStatus, logoUrl } from "@verify/shared";

export function App() {
  const { t } = useTranslation();
  return (
    <main className="page">
      <header className="topbar">
        <Brand product="Verify" />
        <LanguageToggle />
      </header>

      <img className="hero-logo" src={logoUrl} alt="Confiance, la mobilité en toute sérénité" />

      <section className="card">
        <h1>{t("welcome.title")}</h1>
        <p>{t("welcome.intro")}</p>
      </section>

      <section className="card">
        <h2>{t("steps.title")}</h2>
        <ol className="steps">
          <li>{t("steps.consent")}</li>
          <li>{t("steps.document")}</li>
          <li>{t("steps.selfie")}</li>
          <li>{t("steps.result")}</li>
        </ol>
        <p className="muted">{t("steps.duration")}</p>
      </section>

      <button type="button" className="primary" disabled>
        {t("start")}
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

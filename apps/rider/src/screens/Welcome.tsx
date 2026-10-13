import { useTranslation } from "react-i18next";
import { ServerStatus, logoUrl, type FlowSession } from "@verify/shared";
import type { FlowErrorCode } from "../flow/errors";
import type { FlowState } from "../flow/machine";
import { ErrorNotice, Page } from "../ui";

interface Props {
  load: FlowState["load"];
  session: FlowSession | null;
  error: FlowErrorCode | null;
  onStart: () => void;
  onRetry: () => void;
}

export function WelcomeScreen({ load, session, error, onStart, onRetry }: Props) {
  const { t } = useTranslation();
  return (
    <Page>
      <img className="hero-logo" src={logoUrl} alt={t("welcome.logoAlt")} />

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

      <div className="welcome-status" aria-live="polite">
        {load === "loading" && <p className="muted">{t("welcome.loading")}</p>}
        {load === "none" && (
          <>
            <p>{t("welcome.noSession")}</p>
            <p className="muted">{t("welcome.noSessionTest")}</p>
          </>
        )}
        {load === "failed" && (
          <>
            {error && <ErrorNotice code={error} />}
            <button type="button" className="secondary" onClick={onRetry}>
              {t("common.retry")}
            </button>
          </>
        )}
        {load === "ready" && session?.isTest && <span className="badge">{t("welcome.testBadge")}</span>}
      </div>

      <button type="button" className="primary" disabled={load !== "ready"} onClick={onStart}>
        {t("start")}
      </button>

      <footer className="footer">
        <ServerStatus />
        <div>
          {t("build")}: {__BUILD_ID__}
        </div>
      </footer>
    </Page>
  );
}

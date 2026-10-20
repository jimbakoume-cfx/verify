// The result screen (automatic approval, PM 2026-10-20): after the submit, the rider is told whether
// their ID is verified ("Continue" then takes them on), or that a person is checking a few details.
// Nothing else: never a refusal, never a score or a reason.
import { useTranslation } from "react-i18next";
import type { ResultState } from "../flow/machine";
import { CheckIcon, Page, ScreenTitle } from "../ui";

export function ResultScreen({ result, onContinue }: { result: ResultState; onContinue: () => void }) {
  const { t } = useTranslation();
  if (result.state === "verified") {
    return (
      <Page>
        <div className="end-icon ok" aria-hidden="true">
          <CheckIcon />
        </div>
        <ScreenTitle>{t("result.verifiedTitle")}</ScreenTitle>
        <section className="card">
          <p role="status">{t("result.verifiedBody")}</p>
        </section>
        <button type="button" className="primary" onClick={onContinue} disabled={result.leaving}>
          {t("result.continue")}
        </button>
      </Page>
    );
  }
  if (result.state === "review") {
    return (
      <Page>
        <div className="end-icon info" aria-hidden="true">
          …
        </div>
        <ScreenTitle>{t("result.reviewTitle")}</ScreenTitle>
        <section className="card">
          <p role="status">{t("result.reviewBody")}</p>
          <p className="muted">{t("done.close")}</p>
        </section>
      </Page>
    );
  }
  return (
    <Page>
      <ScreenTitle>{t("result.pendingTitle")}</ScreenTitle>
      <section className="card result-pending">
        <span className="spinner" aria-hidden="true" />
        <p role="status">{t("result.pendingBody")}</p>
      </section>
      <p className="muted">{t("result.keepOpen")}</p>
    </Page>
  );
}

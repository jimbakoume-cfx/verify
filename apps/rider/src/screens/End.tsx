// Final screens: photos received, or a link that can no longer be used.
import { useTranslation } from "react-i18next";
import type { SessionErrorReason } from "../flow/errors";
import { CheckIcon, Page, ScreenTitle } from "../ui";

export function DoneScreen() {
  const { t } = useTranslation();
  return (
    <Page>
      <div className="end-icon ok" aria-hidden="true">
        <CheckIcon />
      </div>
      <ScreenTitle>{t("done.title")}</ScreenTitle>
      <section className="card">
        <p>{t("done.next")}</p>
        <p className="muted">{t("done.close")}</p>
      </section>
    </Page>
  );
}

export function SessionErrorScreen({ reason }: { reason: SessionErrorReason }) {
  const { t } = useTranslation();
  return (
    <Page>
      <div className={`end-icon ${reason === "already_submitted" ? "ok" : "bad"}`} aria-hidden="true">
        {reason === "already_submitted" ? <CheckIcon /> : "!"}
      </div>
      <ScreenTitle>{t(`sessionError.${reason}Title`)}</ScreenTitle>
      <section className="card">
        {reason === "already_submitted" ? (
          // The photos were received (e.g. the page was reloaded after Done): nothing more to do,
          // and above all no new link to ask for.
          <p>{t("sessionError.already_submittedClose")}</p>
        ) : (
          <>
            <p>{t(`sessionError.${reason}`)}</p>
            <p>{t("sessionError.hint")}</p>
            <p className="muted">{t("sessionError.testHint")}</p>
          </>
        )}
      </section>
    </Page>
  );
}

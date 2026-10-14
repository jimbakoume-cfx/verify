import { useTranslation } from "react-i18next";
import type { FlowErrorCode } from "../flow/errors";
import type { UploadProgress, UploadState } from "../flow/machine";
import { UPLOAD_RETRY } from "../flow/retry";
import { ErrorNotice, Page, ScreenTitle } from "../ui";

interface Props {
  upload: UploadState;
  error: FlowErrorCode | null;
  onRetry: () => void;
}

function useStatusText(progress: UploadProgress | null, stage: UploadState["stage"]): string {
  const { t } = useTranslation();
  // Before the first report: the first photo's link, or the submit after the checks.
  if (!progress) return stage === "submit" ? t("upload.submit") : t("upload.link", { n: 1, total: 1 });
  const step =
    progress.phase === "submit"
      ? t("upload.submit")
      : t(`upload.${progress.phase}`, { n: progress.photo, total: progress.photos });
  return progress.attempt > 1 ? t("upload.retrying", { attempt: progress.attempt, tries: UPLOAD_RETRY.tries }) : step;
}

export function UploadScreen({ upload, error, onRetry }: Props) {
  const { t } = useTranslation();
  const failed = upload.status === "failed";
  const { progress } = upload;
  const percent = progress ? Math.round((progress.done / progress.total) * 100) : 0;
  const status = useStatusText(progress, upload.stage);
  return (
    <Page>
      <ScreenTitle>{failed ? t("upload.failedTitle") : t("upload.title")}</ScreenTitle>
      <section className="card">
        <div
          className={`progress ${failed ? "failed" : ""}`}
          role="progressbar"
          aria-label={t("upload.progressLabel")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="progress-bar" style={{ width: `${percent}%` }} />
        </div>
        {failed ? (
          error && <ErrorNotice code={error} />
        ) : (
          <p className="upload-status" aria-live="polite">
            {status}
          </p>
        )}
      </section>
      {failed ? (
        <button type="button" className="primary" onClick={onRetry}>
          {t("common.retry")}
        </button>
      ) : (
        <p className="muted">{t("upload.keepOpen")}</p>
      )}
    </Page>
  );
}

import { useTranslation } from "react-i18next";
import type { DeclaredDocument } from "@verify/shared";
import type { Shot } from "../flow/machine";
import { sideLabelKey } from "../labels";
import { Page, ScreenTitle, useObjectUrl } from "../ui";

interface Props {
  shot: Shot;
  document: DeclaredDocument | null;
  /** Start-up progress of the reader, 0..1, while it gets ready (downloads the first time); else null. */
  progress: number | null;
  /** Stops reading and opens the camera again. */
  onBack: () => void;
}

/** "Reading the code lines…": a few seconds after the photo of the side that carries the MRZ. */
export function ReadingScreen({ shot, document, progress, onBack }: Props) {
  const { t } = useTranslation();
  const url = useObjectUrl(shot.blob);
  const side = t(sideLabelKey(document, shot.side));
  // The reader reports progress only while it first gets ready on this page, which downloads its
  // files the first time but is quick once they are cached: the text says so, without claiming
  // which case this is. Then it just reads. The live text names the step only: screen readers
  // announce it when it changes, and the percent, which changes several times a second, is left to
  // the progress bar (aria-valuenow) and shown beside it, hidden from them.
  const percent = progress !== null && progress < 1 ? Math.round(progress * 100) : null;

  return (
    <Page>
      <ScreenTitle>{t("reading.title")}</ScreenTitle>
      <p className="muted subtitle">
        {side}
        {document && ` · ${t(`documents.${document}`)}`}
      </p>

      <figure className="review-photo reading-photo">
        {url && <img src={url} width={shot.info.width} height={shot.info.height} alt={t("review.alt", { side })} />}
        <span className="reading-scan" aria-hidden="true" />
      </figure>

      <section className="card">
        <p className="reading-status" role="status">
          {percent === null ? t("reading.body") : t("reading.download")}
        </p>
        {percent !== null && (
          <>
            <div
              className="progress"
              role="progressbar"
              aria-label={t("reading.progressLabel")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="progress-bar" style={{ width: `${percent}%` }} />
            </div>
            <p className="reading-percent" aria-hidden="true">
              {t("reading.percent", { percent })}
            </p>
          </>
        )}
      </section>

      <button type="button" className="secondary" onClick={onBack}>
        {t("review.retake")}
      </button>
    </Page>
  );
}

import { useTranslation } from "react-i18next";
import type { DeclaredDocument } from "@verify/shared";
import type { Shot } from "../flow/machine";
import { sideLabelKey } from "../labels";
import { Page, ScreenTitle, useObjectUrl } from "../ui";

interface Props {
  /** The photos sent, in capture order. */
  shots: readonly Shot[];
  document: DeclaredDocument | null;
}

function CheckedPhoto({ shot, document }: { shot: Shot; document: DeclaredDocument | null }) {
  const { t } = useTranslation();
  const url = useObjectUrl(shot.blob);
  const side = t(sideLabelKey(document, shot.side));
  return (
    <figure className="review-photo reading-photo">
      {url && <img src={url} width={shot.info.width} height={shot.info.height} alt={t("review.alt", { side })} />}
      <span className="reading-scan" aria-hidden="true" />
    </figure>
  );
}

/**
 * "Checking your photos…": the server looks at the photos just sent, for at most about 20 seconds
 * (useFlow), then the case is submitted or a photo is retaken. Nothing to press: Back does nothing
 * here, and leaving the page asks first.
 */
export function CheckingScreen({ shots, document }: Props) {
  const { t } = useTranslation();
  return (
    <Page>
      <ScreenTitle>{t("checks.title")}</ScreenTitle>
      <div className={`checking-photos ${shots.length > 1 ? "two" : ""}`.trim()}>
        {shots.map((shot) => (
          <CheckedPhoto key={shot.side} shot={shot} document={document} />
        ))}
      </div>
      <section className="card">
        <p className="reading-status" role="status">
          {t("checks.body")}
        </p>
      </section>
      <p className="muted">{t("checks.keepOpen")}</p>
    </Page>
  );
}

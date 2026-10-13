import { useTranslation } from "react-i18next";
import type { DeclaredDocument } from "@verify/shared";
import { type Shot, refusalHints } from "../flow/machine";
import { sideLabelKey } from "../labels";
import { CheckIcon, Page, ScreenTitle, useObjectUrl } from "../ui";

interface Props {
  shot: Shot;
  document: DeclaredDocument | null;
  /**
   * "Use this photo" is offered: false for a photo under the server's minimum resolution, and for
   * a refused photo until repeated refusals.
   */
  canUse: boolean;
  debug: boolean;
  onUse: () => void;
  onRetake: () => void;
}

export function ReviewScreen({ shot, document, canUse, debug, onUse, onRetake }: Props) {
  const { t } = useTranslation();
  const url = useObjectUrl(shot.blob);
  const refusal = refusalHints(shot);
  const refused = refusal.length > 0;
  // Something is wrong with this photo: Retake comes first.
  const blocked = refused || shot.lowResolution || !canUse;
  const side = t(sideLabelKey(document, shot.side));

  const use = canUse && (
    <button type="button" className={blocked ? "secondary" : "primary"} onClick={onUse}>
      {refused ? t("review.useAnyway") : t("review.use")}
    </button>
  );
  const retake = (
    <button type="button" className={blocked ? "primary" : "secondary"} onClick={onRetake}>
      {t("review.retake")}
    </button>
  );

  return (
    <Page>
      <ScreenTitle>{t("review.title")}</ScreenTitle>
      <p className="muted subtitle">
        {side}
        {document && ` · ${t(`documents.${document}`)}`}
      </p>

      <figure className="review-photo">
        {/* width/height reserve the space before the image decodes: no layout shift. */}
        {url && <img src={url} width={shot.info.width} height={shot.info.height} alt={t("review.alt", { side })} />}
      </figure>

      {shot.lowResolution ? (
        // The server refuses such a photo every time: no "use anyway".
        <p className="notice warn" role="alert">
          {t("review.lowResolution")}
        </p>
      ) : (
        refused && (
          <div className="notice warn" role="alert">
            <strong>{t(`hints.${refusal[0]}`)}</strong>
            <p>{canUse ? t("review.refusedOverride") : t("review.refused")}</p>
          </div>
        )
      )}

      {!blocked && (
        <div>
          <p className="checklist-intro">{t("review.checkIntro")}</p>
          <ul className="checklist">
            {(["checkSharp", "checkGlare", "checkWhole"] as const).map((key) => (
              <li key={key}>
                <CheckIcon />
                <span>{t(`review.${key}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="actions">
        {blocked ? (
          <>
            {retake}
            {use}
          </>
        ) : (
          <>
            {use}
            {retake}
          </>
        )}
      </div>

      {debug && <StillDebug shot={shot} />}
    </Page>
  );
}

function StillDebug({ shot }: { shot: Shot }) {
  const { t } = useTranslation();
  const { info, quality } = shot;
  const rows: [string, string][] = [
    [t("debug.file"), `${(info.bytes / 1024).toFixed(1)} KB`],
    [t("debug.size"), `${info.width}×${info.height}`],
    [t("debug.quality"), info.jpegQuality.toFixed(2)],
    [t("debug.scale"), info.scale.toFixed(2)],
    [t("debug.attempts"), String(info.attempts)],
    [t("debug.sharpness"), quality.sharpness.toFixed(0)],
    [t("debug.glare"), `${(quality.glareRatio * 100).toFixed(2)}%`],
    [t("debug.luma"), quality.meanLuma.toFixed(0)],
    [t("debug.framing"), quality.framing.toFixed(2)],
    [t("debug.video"), `${quality.videoWidth}×${quality.videoHeight} · ${quality.source} · ${quality.elapsedMs} ms`],
    [t("debug.hints"), shot.hints.join(", ") || "—"],
  ];
  return (
    <details className="debug-box" open>
      <summary>{t("debug.title")}</summary>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

import { useTranslation } from "react-i18next";
import type { DeclaredDocument, MrzFormat } from "@verify/shared";
import { type MrzReview, type Shot, refusalHints } from "../flow/machine";
import { sideLabelKey } from "../labels";
import { CheckIcon, Page, ScreenTitle, useObjectUrl } from "../ui";
import { MrzDebug } from "./MrzDebug";

interface Props {
  shot: Shot;
  document: DeclaredDocument | null;
  /**
   * "Use this photo" is offered: false for a photo under the server's minimum resolution, for a
   * refused photo until repeated refusals, and for unread code lines until repeated tries.
   */
  canUse: boolean;
  /** The code lines of this photo (machine.ts mrzReview); null when there is nothing to say. */
  mrz: MrzReview | null;
  debug: boolean;
  onUse: () => void;
  onRetake: () => void;
}

/** The code lines could not be read: how to take a better photo, and whether the rider may go on. */
function MrzUnreadNotice({ format, canContinue }: { format: MrzFormat; canContinue: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="notice warn" role="alert">
      <strong>{t("mrz.unreadTitle")}</strong>
      <p>{canContinue ? t("mrz.retakeIfYouCan") : t("mrz.retake")}</p>
      <ul className="tips">
        {/* One text per format: "Both lines" (TD3) reads better than "All 2 lines". */}
        <li>{t(`mrz.tipLines.${format}`)}</li>
        <li>{t("mrz.tipGlare")}</li>
        <li>{t("mrz.tipSteady")}</li>
      </ul>
      {canContinue && <p>{t("mrz.continueNote")}</p>}
    </div>
  );
}

export function ReviewScreen({ shot, document, canUse, mrz, debug, onUse, onRetake }: Props) {
  const { t } = useTranslation();
  const url = useObjectUrl(shot.blob);
  const refusal = refusalHints(shot);
  const refused = refusal.length > 0;
  const unread = mrz?.status === "unread";
  // Something is wrong with this photo: Retake comes first.
  const blocked = refused || unread || shot.lowResolution || !canUse;
  const side = t(sideLabelKey(document, shot.side));

  const use = canUse && (
    <button type="button" className={blocked ? "secondary" : "primary"} onClick={onUse}>
      {unread ? t("mrz.continue") : refused ? t("review.useAnyway") : t("review.use")}
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
        <>
          {refused && (
            <div className="notice warn" role="alert">
              <strong>{t(`hints.${refusal[0]}`)}</strong>
              <p>{canUse ? t("review.refusedOverride") : t("review.refused")}</p>
            </div>
          )}
          {mrz?.status === "unread" && (
            // "You can continue" only when the blur/glare check allows it too.
            <MrzUnreadNotice format={mrz.format} canContinue={mrz.canContinue && canUse} />
          )}
          {mrz?.status === "read" && (
            // All the rider learns about the reading: the fields stay in ?debug=1 and on the dashboard.
            <p className="mrz-read" role="status">
              <CheckIcon />
              <span>{t("mrz.read")}</span>
            </p>
          )}
        </>
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

/** ?debug=1: how the photo was encoded and judged, and what was read from its code lines. */
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
      {shot.mrz && <MrzDebug read={shot.mrz} attempt={shot.mrzAttempt} />}
    </details>
  );
}

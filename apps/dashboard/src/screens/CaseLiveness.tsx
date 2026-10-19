// "Face check" section of the case page (M5): the challenge the server issued (actions in order, the
// one-time code shown on the rider's screen), what the server recorded about the frames, and the
// frames themselves, each opened through the audited 60-second viewer (supervisors and the assigned
// reviewer; never admins). Nothing here says whether the rider did the actions: that is M6.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LivenessAction } from "@verify/shared";
import { useServices } from "../api/services";
import { OutcomeBadge } from "../components/Checks";
import { ErrorText } from "../components/Feedback";
import { type OpenPhoto, PhotoViewer } from "../components/PhotoViewer";
import { formatBytes, formatDateTime, formatDimensions, formatNumber, toLanguage } from "../lib/format";
import { formatCode, type LivenessCheckRecord, livenessOverview } from "../lib/liveness";
import type { CaptureRecord, StaffProfile } from "../lib/records";
import { photoAccess } from "../lib/roles";

const seconds = (ms: number, lang: "fr" | "en") => formatNumber(ms / 1000, lang, 1);

export function LivenessSection({
  captures,
  check,
  error,
  loading,
  profile,
  onReload,
  initialPhotos,
}: {
  captures: CaptureRecord[];
  /** Undefined until the first load ends; null when the case has no face check yet. */
  check: LivenessCheckRecord | null | undefined;
  error: unknown;
  loading: boolean;
  profile: StaffProfile;
  onReload: () => void;
  /** Frames already open (dev screen preview only). */
  initialPhotos?: Record<string, OpenPhoto>;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const overview = livenessOverview(captures, check ?? null);
  const details = overview.check?.details ?? null;
  const [openAll, setOpenAll] = useState(0);

  return (
    <section className="card" aria-labelledby="liveness-title" aria-busy={loading || undefined}>
      <div className="dash-section-head">
        <h2 id="liveness-title">{t("liveness.title")}</h2>
        <button type="button" className="small" onClick={onReload} disabled={loading}>
          {loading ? t("loading") : t("recent.refresh")}
        </button>
      </div>
      <p className="muted">{t("liveness.intro")}</p>
      {error !== null && error !== undefined && <ErrorText error={error} />}

      {check === null && overview.frames.length === 0 && <p className="muted">{t("liveness.none")}</p>}

      {overview.check && (
        <article className="dash-capture" aria-label={t("liveness.challenge")}>
          <header className="dash-capture-head">
            <h3>{t("liveness.challenge")}</h3>
            <span className="dash-row-badges">
              <OutcomeBadge outcome={overview.check.outcome} />
              <span className="badge neutral">{t("liveness.notEvaluated")}</span>
            </span>
          </header>
          <p className="muted dash-small">{formatDateTime(overview.check.createdAt, lang)}</p>
          {details ? (
            <>
              <ol className="dash-liveness-actions">
                <li>{t("liveness.step0")}</li>
                {details.actions.map((action: LivenessAction, i) => (
                  <li key={action}>
                    {t(`liveness.actions.${action}`)}
                    <span className="muted"> · {t("liveness.framesCount", { count: details.framesPerStep[i + 1] ?? 0 })}</span>
                  </li>
                ))}
              </ol>
              <dl className="dash-facts compact">
                <div>
                  <dt>{t("liveness.code")}</dt>
                  <dd className="mono" translate="no">
                    {formatCode(details.code)}
                  </dd>
                </div>
                <div>
                  <dt>{t("liveness.frames")}</dt>
                  <dd>{details.frames}</dd>
                </div>
                <div>
                  <dt>{t("liveness.duration")}</dt>
                  <dd>{t("capture.seconds", { value: seconds(details.durationMs, lang) })}</dd>
                </div>
                <div>
                  <dt>{t("liveness.serverElapsed")}</dt>
                  <dd>{t("capture.seconds", { value: seconds(details.serverElapsedMs, lang) })}</dd>
                </div>
                <div>
                  <dt>{t("liveness.maxGap")}</dt>
                  <dd>{t("capture.seconds", { value: seconds(details.maxGapMs, lang) })}</dd>
                </div>
                <div>
                  <dt>{t("liveness.startedWithWarning")}</dt>
                  <dd>{details.startedWithWarning ? t("liveness.yes") : t("liveness.no")}</dd>
                </div>
              </dl>
              {details.problems.length > 0 ? (
                <ul className="dash-reasons">
                  {details.problems.map((problem) => (
                    <li key={problem}>
                      <strong>{t(`liveness.problems.${problem}.title`)}</strong> {t(`liveness.problems.${problem}.body`)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dash-small">{t("liveness.plausible")}</p>
              )}
            </>
          ) : (
            <p className="dash-alert info">{t("liveness.unreadable")}</p>
          )}
        </article>
      )}

      {overview.frames.length > 0 && (
        <>
          <div className="dash-section-head">
            <h3>{t("liveness.framesTitle")}</h3>
            {photoAccess(profile.role) === "view" && (
              <button type="button" className="small" onClick={() => setOpenAll((n) => n + 1)}>
                {t("liveness.viewAll")}
              </button>
            )}
          </div>
          {photoAccess(profile.role) === "view" ? (
            <p className="muted dash-small">{t("case.viewsLogged")}</p>
          ) : (
            <p className="dash-alert info">{t("errors.adminNoImageAccess")}</p>
          )}
          <ul className="dash-captures dash-frames">
            {overview.frames.map((frame) => (
              <li key={frame.id}>
                <FrameItem
                  frame={frame}
                  action={frame.liveness && frame.liveness.step > 0 ? details?.actions[frame.liveness.step - 1] ?? null : null}
                  profile={profile}
                  openSignal={openAll}
                  initialPhoto={initialPhotos?.[frame.id]}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {overview.replaced > 0 && <p className="muted dash-small">{t("liveness.replaced", { count: overview.replaced })}</p>}
    </section>
  );
}

type PhotoState =
  | { status: "closed" }
  | { status: "opening" }
  | { status: "open"; photo: OpenPhoto }
  | { status: "expired" }
  | { status: "error"; error: unknown };

function FrameItem({
  frame,
  action,
  profile,
  openSignal,
  initialPhoto,
}: {
  frame: CaptureRecord;
  action: LivenessAction | null;
  profile: StaffProfile;
  /** Changes when "View all frames" is pressed: each frame opens (each view audited). */
  openSignal: number;
  initialPhoto?: OpenPhoto;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const services = useServices();
  const [photo, setPhoto] = useState<PhotoState>(initialPhoto ? { status: "open", photo: initialPhoto } : { status: "closed" });
  const [seen, setSeen] = useState(openSignal);
  const label = t("liveness.frameLabel", { n: (frame.liveness?.index ?? 0) + 1 });
  const step = action ? t(`liveness.actions.${action}`) : t("liveness.step0");

  async function open() {
    setPhoto({ status: "opening" });
    const requestedAt = Date.now();
    try {
      const view = await services.viewCapture(frame.id);
      setPhoto({ status: "open", photo: { url: view.url, deadlineMs: requestedAt + view.expiresIn * 1000 } });
    } catch (error) {
      setPhoto({ status: "error", error });
    }
  }

  // "View all frames": open this one too, once per press, unless it is already open or opening.
  if (openSignal !== seen) {
    setSeen(openSignal);
    if (photo.status !== "open" && photo.status !== "opening" && photoAccess(profile.role) === "view") void open();
  }

  return (
    <article className="dash-capture" aria-label={label}>
      <header className="dash-capture-head">
        <h3>{label}</h3>
        <span className="muted dash-small">
          {step} · {t("capture.seconds", { value: seconds(frame.liveness?.atMs ?? 0, lang) })}
        </span>
      </header>
      <p className="muted dash-small">
        {formatDimensions(frame.width, frame.height)} · {formatBytes(frame.byteSize, lang)}
      </p>
      {photoAccess(profile.role) === "view" && photo.status !== "open" && (
        <div className="dash-capture-actions">
          <button type="button" className="small" onClick={() => void open()} disabled={photo.status === "opening"}>
            {photo.status === "opening" ? t("case.opening") : t("liveness.viewFrame")}
          </button>
          {photo.status === "expired" && (
            <p className="muted dash-small" role="status">
              {t("case.photoRemoved")}
            </p>
          )}
        </div>
      )}
      {photo.status === "error" && <ErrorText error={photo.error} context="photo" />}
      {photo.status === "open" && (
        <PhotoViewer
          key={photo.photo.url}
          photo={photo.photo}
          alt={t("liveness.frameAlt", { n: (frame.liveness?.index ?? 0) + 1 })}
          onExpire={() => setPhoto({ status: "expired" })}
          onClose={() => setPhoto({ status: "closed" })}
        />
      )}
    </article>
  );
}

// "Server face checks" section of the case page (M6/M7): the face worker's liveness evaluation (each
// action seen or not in its own step, the flat-plane test, the provisional cues) and the face match
// (similarity, threshold, "uncalibrated" and "review only"), with the ID portrait and the best frame
// side by side. Both photos open through the audited 60-second viewer (POST /admin/captures/view, one
// audit entry each), never for admins; only the face is shown (the photo is scaled and shifted by CSS,
// no crop is cut out or kept).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type FaceMatchDetails, type LivenessDetails, type LivenessMetrics } from "@verify/shared";
import { useServices } from "../api/services";
import { OutcomeBadge } from "../components/Checks";
import { Countdown } from "../components/Countdown";
import { ErrorText } from "../components/Feedback";
import type { OpenPhoto } from "../components/PhotoViewer";
import { type FaceChecks, type FaceJobState, cropStyle, isProvisionalProblem } from "../lib/faceChecks";
import { formatDateTime, formatNumber, toLanguage } from "../lib/format";
import { openPhotoSource } from "../lib/photo";
import type { CaptureRecord, StaffProfile } from "../lib/records";
import { photoAccess } from "../lib/roles";

export function FaceChecksSection({
  checks,
  captures,
  error,
  loading,
  profile,
  onReload,
  initialPhotos,
  faceMatchCounted = false,
}: {
  /** Undefined until the first load ends. */
  checks: FaceChecks | undefined;
  captures: CaptureRecord[];
  error: unknown;
  loading: boolean;
  profile: StaffProfile;
  onReload: () => void;
  /** Photos already open (dev screen preview only). */
  initialPhotos?: Record<string, OpenPhoto>;
  /**
   * Automatic approval: the case's assessment counted the (uncalibrated) face match, because the threshold
   * version it used sets faceMatchCountsForApproval. Otherwise the face match is review-only.
   */
  faceMatchCounted?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="card" aria-labelledby="face-title" aria-busy={loading || undefined}>
      <div className="dash-section-head">
        <h2 id="face-title">{t("face.title")}</h2>
        <button type="button" className="small" onClick={onReload} disabled={loading}>
          {loading ? t("loading") : t("recent.refresh")}
        </button>
      </div>
      <p className="muted">{t("face.intro")}</p>
      {error !== null && error !== undefined && <ErrorText error={error} />}
      {checks && (
        <>
          <LivenessEvaluation record={checks.liveness} job={checks.jobs.liveness} />
          <FaceMatch
            record={checks.faceMatch}
            job={checks.jobs.face_match}
            captures={captures}
            profile={profile}
            initialPhotos={initialPhotos}
            counted={faceMatchCounted}
          />
        </>
      )}
    </section>
  );
}

function JobState({ state, kind }: { state: FaceJobState; kind: "liveness" | "faceMatch" }) {
  const { t } = useTranslation();
  if (state === "waiting") return <p className="muted">{t("face.waiting")}</p>;
  if (state === "not_checked") return <p className="dash-alert info">{t(`face.notChecked.${kind}`)}</p>;
  return <p className="muted">{t(`face.none.${kind}`)}</p>;
}

function LivenessEvaluation({ record, job }: { record: FaceChecks["liveness"]; job: FaceJobState }) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  if (!record) {
    return (
      <article className="dash-capture" aria-label={t("face.livenessTitle")}>
        <h3>{t("face.livenessTitle")}</h3>
        <JobState state={job} kind="liveness" />
      </article>
    );
  }
  const d: LivenessDetails | null = record.details;
  return (
    <article className="dash-capture" aria-label={t("face.livenessTitle")}>
      <header className="dash-capture-head">
        <h3>{t("face.livenessTitle")}</h3>
        <span className="dash-row-badges">
          <OutcomeBadge outcome={record.outcome} />
          <span className="badge warn">{t("face.provisional")}</span>
        </span>
      </header>
      <p className="muted dash-small">
        {formatDateTime(record.createdAt, lang)} · {record.checkVersion}
      </p>
      {!d ? (
        <p className="dash-alert info">{t("face.unreadable")}</p>
      ) : (
        <>
          <table className="dash-table">
            <thead>
              <tr>
                <th>{t("face.action")}</th>
                <th>{t("face.result")}</th>
                <th>{t("face.peak")}</th>
                <th>{t("face.framesWithFace")}</th>
              </tr>
            </thead>
            <tbody>
              {d.actions.map((a, i) => (
                <tr key={`${a.action}-${i}`}>
                  <td>
                    {i + 1}. {t(`liveness.actions.${a.action}`)}
                  </td>
                  <td>
                    <span className={`badge ${a.result === "pass" ? "ok" : a.result === "fail" ? "bad" : "neutral"}`}>
                      {t(`face.actionResult.${a.result}`)}
                    </span>
                  </td>
                  <td>{a.peak === null ? "—" : peakText(a.action, a.peak, lang, t)}</td>
                  <td>{a.framesWithFace}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="dash-facts compact">
            <div>
              <dt>
                {t("face.flatPlane")} <span className="badge warn">{t("face.provisional")}</span>
              </dt>
              <dd>
                {t(`face.flatPlaneResult.${d.flatPlane}`)}
                {d.flatPlaneScore !== null && <span className="muted"> · {formatNumber(d.flatPlaneScore, lang, 3)}</span>}
              </dd>
            </div>
            <div>
              <dt>{t("face.framesWithFaceTotal")}</dt>
              <dd>{t("face.framesOf", { n: d.framesWithFace, total: d.frames })}</dd>
            </div>
            <div>
              <dt>{t("face.processing")}</dt>
              <dd>
                {t("capture.seconds", { value: formatNumber(d.timing.ms / 1000, lang, 1) })}
                {d.timing.cold && <span className="muted"> · {t("face.coldStart")}</span>}
              </dd>
            </div>
            {d.timing.sinceJobMs !== undefined && (
              <div>
                <dt>{t("face.sinceJob")}</dt>
                <dd>{t("capture.seconds", { value: formatNumber(d.timing.sinceJobMs / 1000, lang, 1) })}</dd>
              </div>
            )}
            <div>
              <dt>{t("face.engine")}</dt>
              <dd className="mono">{d.engine}</dd>
            </div>
          </dl>
          {d.metrics && <LivenessMetricsTable metrics={d.metrics} lang={lang} />}
          {d.problems.length > 0 ? (
            <ul className="dash-reasons">
              {d.problems.map((p) => (
                <li key={p}>
                  <span>
                    <strong>{t(`face.problems.${p}.title`)}</strong>
                    {isProvisionalProblem(p) && <span className="badge warn dash-inline-badge">{t("face.provisional")}</span>}
                  </span>
                  {t(`face.problems.${p}.body`)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="dash-small">{t("face.livenessClean")}</p>
          )}
        </>
      )}
    </article>
  );
}

/**
 * The per-frame numbers the decision used (liveness-eval-v2), folded away: angles and scores only, for
 * tuning the cut-offs on real riders. Never a picture.
 */
function LivenessMetricsTable({ metrics, lang }: { metrics: LivenessMetrics; lang: "fr" | "en" }) {
  const { t } = useTranslation();
  const n = (value: number | null, digits: number) => (value === null ? "—" : formatNumber(value, lang, digits));
  const b = metrics.baseline;
  return (
    <details className="dash-subsection">
      <summary>{t("face.metrics.title")}</summary>
      <p className="muted dash-small">{t("face.metrics.body")}</p>
      <table className="dash-table dash-small">
        <thead>
          <tr>
            <th>{t("face.metrics.frame")}</th>
            <th>{t("face.metrics.step")}</th>
            <th>{t("face.metrics.yaw")}</th>
            <th>{t("face.metrics.pitch")}</th>
            <th>{t("face.metrics.smile")}</th>
            <th>{t("face.metrics.mouthWidth")}</th>
            <th>{t("face.metrics.eyeOpenness")}</th>
            <th>{t("face.metrics.blink")}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" colSpan={2}>{t("face.metrics.neutral")}</th>
            <td>{n(b.yaw, 1)}</td>
            <td>{n(b.pitch, 1)}</td>
            <td>{n(b.smile, 3)}</td>
            <td>{n(b.mouthWidth, 3)}</td>
            <td>{n(b.eyeOpenness, 3)}</td>
            <td>—</td>
          </tr>
          {metrics.frames.map((f) => (
            <tr key={f.index}>
              <td>{f.index}</td>
              <td>{f.step ?? "—"}</td>
              <td>{n(f.yaw, 1)}</td>
              <td>{n(f.pitch, 1)}</td>
              <td>{n(f.smile, 3)}</td>
              <td>{n(f.mouthWidth, 3)}</td>
              <td>{n(f.eyeOpenness, 3)}</td>
              <td>{n(f.blink, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function peakText(action: string, peak: number, lang: "fr" | "en", t: (key: string, o?: Record<string, unknown>) => string) {
  if (action === "turn_left" || action === "turn_right" || action === "look_up") {
    return t("face.degrees", { value: formatNumber(peak, lang, 0) });
  }
  return formatNumber(peak, lang, 2);
}

function FaceMatch({
  record,
  job,
  captures,
  profile,
  initialPhotos,
  counted,
}: {
  record: FaceChecks["faceMatch"];
  job: FaceJobState;
  captures: CaptureRecord[];
  profile: StaffProfile;
  initialPhotos?: Record<string, OpenPhoto>;
  counted: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  if (!record) {
    return (
      <article className="dash-capture" aria-label={t("face.matchTitle")}>
        <h3>{t("face.matchTitle")}</h3>
        <JobState state={job} kind="faceMatch" />
      </article>
    );
  }
  const d: FaceMatchDetails | null = record.details;
  return (
    <article className="dash-capture" aria-label={t("face.matchTitle")}>
      <header className="dash-capture-head">
        <h3>{t("face.matchTitle")}</h3>
        <span className="dash-row-badges">
          <OutcomeBadge outcome={record.outcome} />
          <span className="badge bad">{t("face.uncalibrated")}</span>
          {counted
            ? <span className="badge warn">{t("face.countedForApproval")}</span>
            : <span className="badge neutral">{t("face.reviewOnly")}</span>}
        </span>
      </header>
      <p className="muted dash-small">
        {formatDateTime(record.createdAt, lang)} · {record.checkVersion}
      </p>
      {!d ? (
        <p className="dash-alert info">{t("face.unreadable")}</p>
      ) : (
        <>
          <p className="dash-alert warn">{t(counted ? "face.uncalibratedCountedBody" : "face.uncalibratedBody")}</p>
          <dl className="dash-facts compact">
            <div>
              <dt>{t("face.similarity")}</dt>
              <dd>{d.similarity === null ? t("face.notCompared") : formatNumber(d.similarity, lang, 3)}</dd>
            </div>
            <div>
              <dt>{t("face.threshold")}</dt>
              <dd>
                {formatNumber(d.threshold, lang, 2)} <span className="muted">({t("face.lowThreshold", { value: formatNumber(d.lowThreshold, lang, 2) })})</span>
              </dd>
            </div>
            <div>
              <dt>{t("face.model")}</dt>
              <dd className="mono">{d.model}</dd>
            </div>
            <div>
              <dt>{t("face.processing")}</dt>
              <dd>
                {t("capture.seconds", { value: formatNumber(d.timing.ms / 1000, lang, 1) })}
                {d.timing.cold && <span className="muted"> · {t("face.coldStart")}</span>}
              </dd>
            </div>
          </dl>
          {d.problems.length > 0 && (
            <ul className="dash-reasons">
              {d.problems.map((p) => (
                <li key={p}>
                  <strong>{t(`face.matchProblems.${p}.title`)}</strong> {t(`face.matchProblems.${p}.body`)}
                </li>
              ))}
            </ul>
          )}
          <SideBySide details={d} captures={captures} profile={profile} initialPhotos={initialPhotos} />
        </>
      )}
    </article>
  );
}

type PairState =
  | { status: "closed" }
  | { status: "opening" }
  | { status: "open"; portrait: OpenPhoto; selfie: OpenPhoto | null }
  | { status: "expired" }
  | { status: "error"; error: unknown };

/** The ID portrait and the best frame, next to each other, each opened through the audited viewer. */
function SideBySide({
  details,
  captures,
  profile,
  initialPhotos,
}: {
  details: FaceMatchDetails;
  captures: CaptureRecord[];
  profile: StaffProfile;
  initialPhotos?: Record<string, OpenPhoto>;
}) {
  const { t } = useTranslation();
  const services = useServices();
  const portraitCapture = captures.find((c) => c.id === details.portrait.captureId) ?? null;
  const selfieCapture = details.selfie.captureId ? captures.find((c) => c.id === details.selfie.captureId) ?? null : null;
  // Dev preview only: both photos already open.
  const initialPortrait = initialPhotos?.[details.portrait.captureId];
  const initialSelfie = details.selfie.captureId ? initialPhotos?.[details.selfie.captureId] : undefined;
  const [state, setState] = useState<PairState>(
    initialPortrait && initialSelfie ? { status: "open", portrait: initialPortrait, selfie: initialSelfie } : { status: "closed" },
  );

  if (photoAccess(profile.role) !== "view") return <p className="dash-alert info">{t("errors.adminNoImageAccess")}</p>;
  if (!portraitCapture || portraitCapture.deleted) return <p className="muted dash-small">{t("face.photosGone")}</p>;

  async function open() {
    setState({ status: "opening" });
    const requestedAt = Date.now();
    try {
      const portrait = await services.viewCapture(details.portrait.captureId);
      const selfie = details.selfie.captureId && selfieCapture && !selfieCapture.deleted ? await services.viewCapture(details.selfie.captureId) : null;
      setState({
        status: "open",
        portrait: { url: portrait.url, deadlineMs: requestedAt + portrait.expiresIn * 1000 },
        selfie: selfie ? { url: selfie.url, deadlineMs: requestedAt + selfie.expiresIn * 1000 } : null,
      });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <>
      <p className="muted dash-small">{t("face.sideBySideNote")}</p>
      {state.status !== "open" && (
        <div className="dash-capture-actions">
          <button type="button" onClick={() => void open()} disabled={state.status === "opening"}>
            {state.status === "opening" ? t("case.opening") : t("face.showBoth")}
          </button>
          {state.status === "expired" && (
            <p className="muted dash-small" role="status">
              {t("case.photoRemoved")}
            </p>
          )}
        </div>
      )}
      {state.status === "error" && <ErrorText error={state.error} context="photo" />}
      {state.status === "open" && (
        <div className="dash-face-pair">
          <CroppedPhoto
            photo={state.portrait}
            box={details.portrait.box}
            width={portraitCapture.width ?? 1}
            height={portraitCapture.height ?? 1}
            caption={t("face.portrait")}
            alt={t("face.portraitAlt")}
            onExpire={() => setState({ status: "expired" })}
          />
          {state.selfie && selfieCapture ? (
            <CroppedPhoto
              photo={state.selfie}
              box={details.selfie.box}
              width={selfieCapture.width ?? 1}
              height={selfieCapture.height ?? 1}
              caption={t("face.selfie", { n: (selfieCapture.liveness?.index ?? 0) + 1 })}
              alt={t("face.selfieAlt")}
              onExpire={() => setState({ status: "expired" })}
            />
          ) : (
            <p className="muted dash-small">{t("face.noSelfie")}</p>
          )}
          <div className="dash-face-pair-foot">
            <Countdown deadlineMs={state.portrait.deadlineMs} runningKey="case.photoExpiresIn" expiredKey="case.photoExpired" />
            <button type="button" className="small" onClick={() => setState({ status: "closed" })}>
              {t("case.hidePhoto")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** One photo, shown from memory (lib/photo.ts) and only around `box`; freed when hidden or expired. */
function CroppedPhoto({
  photo,
  box,
  width,
  height,
  caption,
  alt,
  onExpire,
}: {
  photo: OpenPhoto;
  box: number[] | null;
  width: number;
  height: number;
  caption: string;
  alt: string;
  onExpire: () => void;
}) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const source = openPhotoSource(photo.url);
    source.ready.then(
      (url) => active && setSrc(url),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
      source.close();
      setSrc(null);
    };
  }, [photo.url]);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  useEffect(() => {
    const id = window.setTimeout(() => onExpireRef.current(), Math.max(0, photo.deadlineMs - Date.now()));
    return () => window.clearTimeout(id);
  }, [photo.url, photo.deadlineMs]);

  const style = box ? cropStyle(box, width, height) : null;
  return (
    <figure className="dash-photo dash-face-crop">
      {failed ? (
        <p className="dash-alert error" role="alert">
          {t("case.photoLoadFailed")}
        </p>
      ) : src ? (
        style ? (
          <div className="dash-face-crop-box" style={style.container}>
            <img src={src} alt={alt} decoding="async" draggable={false} style={style.image} onError={() => setFailed(true)} />
          </div>
        ) : (
          <img src={src} alt={alt} decoding="async" draggable={false} onError={() => setFailed(true)} />
        )
      ) : (
        <p className="muted" role="status">
          {t("case.photoLoading")}
        </p>
      )}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

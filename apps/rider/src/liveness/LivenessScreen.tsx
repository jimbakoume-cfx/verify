// The face check (M5): the front camera with an oval guide, a short brightness check, then a random
// challenge from the server: "look at the camera", then three actions, each shown for 3 seconds while
// the app takes still frames. The frames go to private storage and the server records them. Nothing on
// the phone judges whether the actions were done: the server does that from the frames (M6).
// Loaded on demand (React.lazy), like the document camera.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageToggle, type LivenessChallengeResponse } from "@verify/shared";
import type { SelfieAnalysis } from "@verify/capture";
import { type CameraErrorKind, FRONT_CAMERA_CONSTRAINTS, classifyCameraError, openCamera, stopStream } from "../capture/camera";
import type { Size } from "../capture/geometry";
import { usePageVisible } from "../capture/usePageVisible";
import { type FlowErrorCode, errorMessageKey, sessionErrorReason, toFlowError } from "../flow/errors";
import { createPresenceSampler, encodeFrame, grabFrame, ovalRect, sha256OfBlob } from "./frames";
import { LIVENESS_TIMING, frameByteTarget, frameSchedule } from "./schedule";
import { type LivenessService, type TakenFrame, recoveryFor, sendFaceCheck } from "./send";

/** Presence samples per second while the rider gets ready. */
const SAMPLE_INTERVAL_MS = 250;
/** Good samples in a row (about a second) before "Start" is offered as ready. */
const READY_SAMPLES = 4;
/** After this long with the camera live, "Start" works whatever the hint says (never a dead end). */
const START_ANYWAY_AFTER_MS = 6_000;

export interface LivenessScreenProps {
  service: LivenessService | null;
  debug: boolean;
  /** An error from the step before (e.g. the server had no face check at submit). */
  error: FlowErrorCode | null;
  onDone: () => void;
  onFailed: (error: FlowErrorCode) => void;
}

type Phase =
  | { name: "camera" }
  | { name: "preparing" }
  | { name: "running"; challenge: LivenessChallengeResponse; step: number }
  | { name: "sending"; done: number; total: number }
  | { name: "failed"; error: FlowErrorCode; resend: Pending | null }
  | { name: "done" };

/** A capture whose sending failed for a moment: "Try again" sends the same frames. */
interface Pending {
  challenge: LivenessChallengeResponse;
  frames: TakenFrame[];
  stepStartsMs: number[];
  startedWithWarning: boolean;
  video: Size;
}

type CameraState = { state: "starting" } | { state: "live" } | { state: "off" } | { state: "error"; kind: CameraErrorKind };

function useStageSize(ref: React.RefObject<HTMLDivElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setSize((prev) => (prev && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5 ? prev : { width: r.width, height: r.height }));
      }
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref]);
  return size;
}

export default function LivenessScreen({ service, debug, error, onDone, onFailed }: LivenessScreenProps) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stage = useStageSize(stageRef);
  const stageRefValue = useRef<Size | null>(null);
  stageRefValue.current = stage;
  const visible = usePageVisible();

  const [camera, setCamera] = useState<CameraState>({ state: "starting" });
  const [restart, setRestart] = useState(0);
  const [phase, setPhase] = useState<Phase>({ name: "camera" });
  const [presence, setPresence] = useState<SelfieAnalysis | null>(null);
  const [goodSamples, setGoodSamples] = useState(0);
  const [startAnyway, setStartAnyway] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // The camera: on while the page is visible, until the frames are taken.
  const wantCamera = phase.name === "camera" || phase.name === "preparing" || phase.name === "running";
  useEffect(() => {
    const video = videoRef.current;
    if (!wantCamera || !visible || !video) {
      setCamera((c) => (c.state === "error" ? c : { state: "off" }));
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    setCamera({ state: "starting" });
    openCamera(navigator, window.isSecureContext, FRONT_CAMERA_CONSTRAINTS)
      .then(async (opened) => {
        if (cancelled) {
          stopStream(opened);
          return;
        }
        stream = opened;
        streamRef.current = opened;
        video.srcObject = opened;
        try {
          await video.play();
        } catch {
          // Muted inline video may autoplay anyway.
        }
        if (!cancelled) setCamera({ state: "live" });
      })
      .catch((err: unknown) => {
        if (!cancelled) setCamera({ state: "error", kind: classifyCameraError(err) });
      });
    return () => {
      cancelled = true;
      stopStream(stream);
      if (streamRef.current === stream) streamRef.current = null;
      video.srcObject = null;
    };
  }, [wantCamera, visible, restart]);

  // The page went away during the capture: those frames would have a hole. Start again later.
  useEffect(() => {
    if (!visible && phase.name === "running") {
      cancelRef.current?.();
      setPhase({ name: "failed", error: "interrupted", resend: null });
    }
  }, [visible, phase.name]);

  // The presence hint, four times a second while the rider gets ready.
  const live = camera.state === "live";
  useEffect(() => {
    if (!live || phase.name !== "camera") return;
    const video = videoRef.current;
    if (!video) return;
    const sampler = createPresenceSampler();
    const timer = window.setInterval(() => {
      const size = stageRefValue.current;
      if (!size) return;
      try {
        const result = sampler.sample(video, size);
        if (!result) return;
        setPresence(result);
        setGoodSamples((n) => (result.hint === null ? n + 1 : 0));
      } catch {
        // A dropped sample (no canvas this time): the next one may work.
      }
    }, SAMPLE_INTERVAL_MS);
    const anyway = window.setTimeout(() => setStartAnyway(true), START_ANYWAY_AFTER_MS);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(anyway);
      sampler.dispose();
    };
  }, [live, phase.name]);

  useEffect(() => () => cancelRef.current?.(), []);

  const ready = goodSamples >= READY_SAMPLES;
  const canStart = live && phase.name === "camera" && (ready || startAnyway) && service !== null;

  const fail = useCallback(
    (code: FlowErrorCode, resend: Pending | null = null) => {
      if (sessionErrorReason(code)) {
        onFailed(code);
        return;
      }
      setPhase({ name: "failed", error: code, resend });
    },
    [onFailed],
  );

  const send = useCallback(
    async (pending: Pending) => {
      if (!service) return;
      setPhase({ name: "sending", done: 0, total: pending.frames.length + 1 });
      const outcome = await sendFaceCheck(
        service,
        pending.challenge,
        pending.frames,
        {
          stepStartsMs: pending.stepStartsMs,
          startedWithWarning: pending.startedWithWarning,
          videoWidth: pending.video.width,
          videoHeight: pending.video.height,
        },
        { onProgress: (done, total) => setPhase({ name: "sending", done, total }) },
      );
      if (outcome.ok) {
        setPhase({ name: "done" });
        onDone();
      } else {
        fail(outcome.error, recoveryFor(outcome.error) === "resend" ? pending : null);
      }
    },
    [service, onDone, fail],
  );

  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!service || !video || !canStart) return;
    const startedWithWarning = !ready;
    setPhase({ name: "preparing" });
    let challenge: LivenessChallengeResponse;
    try {
      challenge = await service.challenge();
    } catch (err) {
      fail(toFlowError(err).code);
      return;
    }

    // The capture: step changes and frames on timers from one starting point, times measured.
    const plan = frameSchedule(challenge.actions.length);
    const target = frameByteTarget(plan.frames.length);
    const videoSize = { width: video.videoWidth, height: video.videoHeight };
    const startedAt = performance.now();
    const stepStartsMs: number[] = [0];
    const encoding: Promise<TakenFrame>[] = [];
    const timers: number[] = [];
    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
    setPhase({ name: "running", challenge, step: 0 });
    plan.stepStartsMs.slice(1).forEach((at, i) => {
      timers.push(window.setTimeout(() => {
        stepStartsMs[i + 1] = performance.now() - startedAt;
        setPhase({ name: "running", challenge, step: i + 1 });
      }, at));
    });
    plan.frames.forEach((frame) => {
      timers.push(window.setTimeout(() => {
        const atMs = performance.now() - startedAt;
        try {
          const canvas = grabFrame(video, LIVENESS_TIMING.frameLongSide);
          encoding.push(
            encodeFrame(canvas, target).then(async (blob) => ({ blob, sha256: await sha256OfBlob(blob), atMs, step: frame.step })),
          );
        } catch (err) {
          encoding.push(Promise.reject(err));
        }
      }, frame.atMs));
    });
    await new Promise<void>((resolve) => timers.push(window.setTimeout(resolve, plan.totalMs)));
    cancelRef.current = null;
    if (cancelled) return;
    // The frames are taken: the camera goes off at once (the phase change releases it).
    setPhase({ name: "sending", done: 0, total: plan.frames.length + 1 });
    let frames: TakenFrame[];
    try {
      frames = await Promise.all(encoding);
    } catch {
      fail("unexpected");
      return;
    }
    await send({ challenge, frames, stepStartsMs, startedWithWarning, video: videoSize });
  }, [service, canStart, ready, fail, send]);

  const restartCapture = useCallback(() => {
    setGoodSamples(0);
    setStartAnyway(false);
    setPresence(null);
    setPhase({ name: "camera" });
    setRestart((n) => n + 1);
  }, []);

  const step = phase.name === "running" ? phase.step : -1;
  const prompt =
    phase.name === "running"
      ? step === 0
        ? t("liveness.lookStraight")
        : t(`liveness.actions.${phase.challenge.actions[step - 1]}`)
      : phase.name === "preparing"
        ? t("liveness.preparing")
        : camera.state === "starting"
          ? t("capture.starting")
          : presence?.hint
            ? t(`liveness.hints.${presence.hint}`)
            : t(ready ? "liveness.hints.ready" : "liveness.hints.checking");
  const readiness = phase.name === "running" ? "ready" : presence?.hint ? "adjust" : ready ? "ready" : "searching";
  const oval = stage ? ovalRect(stage) : null;
  const showCamera = phase.name === "camera" || phase.name === "preparing" || phase.name === "running";

  return (
    <div className="capture liveness" ref={stageRef}>
      <video ref={videoRef} className="capture-video mirrored" playsInline muted autoPlay />
      {stage && oval && showCamera && (
        <svg className="guide-overlay" viewBox={`0 0 ${stage.width} ${stage.height}`} aria-hidden="true" focusable="false">
          <path
            className="guide-mask"
            fillRule="evenodd"
            d={`M0 0H${stage.width}V${stage.height}H0Z M${oval.x + oval.width / 2} ${oval.y} a${oval.width / 2} ${oval.height / 2} 0 1 0 0.01 0Z`}
          />
          <ellipse
            className={`oval-frame ${readiness}`}
            cx={oval.x + oval.width / 2}
            cy={oval.y + oval.height / 2}
            rx={oval.width / 2}
            ry={oval.height / 2}
          />
        </svg>
      )}

      <div className="capture-ui" inert={camera.state === "error" || !showCamera}>
        <header className="capture-top">
          <div className="capture-title">
            <h1 ref={titleRef} tabIndex={-1}>
              {t("liveness.title")}
            </h1>
            {phase.name === "running" ? (
              <span className="liveness-code" translate="no">
                {t("liveness.code", { code: `${phase.challenge.code.slice(0, 3)} ${phase.challenge.code.slice(3)}` })}
              </span>
            ) : (
              <span>{t("liveness.subtitle")}</span>
            )}
          </div>
          <LanguageToggle />
        </header>

        <div className="capture-hint">
          {error && phase.name === "camera" && (
            <p className="capture-alert" role="alert">
              {t(errorMessageKey(error))}
            </p>
          )}
          <div aria-live="polite" aria-atomic="true">
            <p className={`hint-pill ${readiness}`}>{prompt}</p>
            <p className="hint-tip">
              {phase.name === "running"
                ? t("liveness.stepOf", { step, total: phase.challenge.actions.length })
                : phase.name === "camera"
                  ? t("liveness.tip")
                  : " "}
            </p>
          </div>
        </div>

        <div className="capture-area" />
        {debug && presence && (
          <dl className="capture-debug">
            <div>
              <dt>{t("debug.luma")}</dt>
              <dd>{presence.meanLuma.toFixed(0)}</dd>
            </div>
            <div>
              <dt>{t("debug.contrast")}</dt>
              <dd>{presence.contrast.toFixed(1)}</dd>
            </div>
            <div>
              <dt>{t("debug.backlight")}</dt>
              <dd>{presence.backlight.toFixed(0)}</dd>
            </div>
            <div>
              <dt>{t("debug.video")}</dt>
              <dd>
                {videoRef.current?.videoWidth ?? 0}×{videoRef.current?.videoHeight ?? 0}
              </dd>
            </div>
          </dl>
        )}

        <footer className="capture-bottom">
          {phase.name === "camera" ? (
            <button type="button" className="primary liveness-start" disabled={!canStart} onClick={() => void start()}>
              {t("liveness.start")}
            </button>
          ) : phase.name === "running" ? (
            <p className="capture-auto">{t("liveness.holdPhone")}</p>
          ) : (
            <p className="capture-auto">{phase.name === "preparing" ? t("liveness.preparing") : " "}</p>
          )}
        </footer>
      </div>

      {(phase.name === "sending" || phase.name === "failed" || phase.name === "done") && (
        <div className="camera-error">
          <section className="card" role={phase.name === "failed" ? "alertdialog" : "status"} aria-labelledby="liveness-panel-title">
            {phase.name === "failed" ? (
              <FailedPanel
                error={phase.error}
                canResend={phase.resend !== null}
                onResend={() => phase.resend && void send(phase.resend)}
                onRestart={restartCapture}
              />
            ) : (
              <>
                <h2 id="liveness-panel-title">{t(phase.name === "done" ? "liveness.sent" : "liveness.sending")}</h2>
                {phase.name === "sending" && (
                  <div
                    className="progress"
                    role="progressbar"
                    aria-label={t("liveness.sending")}
                    aria-valuemin={0}
                    aria-valuemax={phase.total}
                    aria-valuenow={phase.done}
                  >
                    <div className="progress-bar" style={{ width: `${Math.round((phase.done / phase.total) * 100)}%` }} />
                  </div>
                )}
                <p className="muted">{t("upload.keepOpen")}</p>
              </>
            )}
          </section>
        </div>
      )}

      {camera.state === "error" && showCamera && (
        <div className="camera-error">
          <section className="card" role="alertdialog" aria-modal="true" aria-labelledby="liveness-camera-title">
            <h2 id="liveness-camera-title">{t(`camera.${camera.kind}Title`)}</h2>
            <p>{t(camera.kind === "no_camera" ? "liveness.noCamera" : `camera.${camera.kind}`)}</p>
            <div className="actions">
              <button type="button" className="primary" onClick={() => setRestart((n) => n + 1)}>
                {t("common.retry")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function FailedPanel({
  error,
  canResend,
  onResend,
  onRestart,
}: {
  error: FlowErrorCode;
  canResend: boolean;
  onResend: () => void;
  onRestart: () => void;
}) {
  const { t } = useTranslation();
  const recovery = canResend ? "resend" : recoveryFor(error);
  const messageKey = errorMessageKey(error);
  return (
    <>
      <h2 id="liveness-panel-title">{t("liveness.failedTitle")}</h2>
      <p role="alert">{t(messageKey)}</p>
      <div className="actions">
        {recovery === "resend" && (
          <button type="button" className="primary" onClick={onResend}>
            {t("common.retry")}
          </button>
        )}
        {recovery !== "stop" && (
          <button type="button" className={recovery === "resend" ? "secondary" : "primary"} onClick={onRestart}>
            {t("liveness.startAgain")}
          </button>
        )}
      </div>
    </>
  );
}

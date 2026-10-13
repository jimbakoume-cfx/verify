// Dev-only (never in production builds): every rider screen with fake data, for screenshots and
// layout checks without a camera or backend. Open /?screen=<name>; add &lang=en for English.
import { type CSSProperties, useEffect, useState } from "react";
import type { CaptureSide, FlowSession } from "@verify/shared";
import type { Hint } from "@verify/capture";
import { FlowView } from "../FlowView";
import type { FlowErrorCode } from "../flow/errors";
import { type FlowState, type Shot, initialFlowState } from "../flow/machine";
import type { FlowActions } from "../flow/useFlow";
import { type CameraErrorKind } from "../capture/camera";
import { CaptureDebug } from "../capture/CaptureDebug";
import { type CaptureMessage, CaptureView } from "../capture/CaptureView";
import type { Readiness } from "../capture/hints";

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const noop = () => undefined;

const ACTIONS: FlowActions = {
  start: noop,
  retryLoad: noop,
  acceptConsent: noop,
  declineConsent: noop,
  reviewConsent: noop,
  chooseDocument: noop,
  back: noop,
  captured: noop,
  retake: noop,
  useShot: noop,
  turnOverReady: noop,
  retryUpload: noop,
};

const SESSION: FlowSession = {
  verificationId: "7d0c1a52-3f0e-4c8e-9a51-2b6f4f1d9e10",
  status: "in_progress",
  locale: "fr",
  consentGiven: true,
  declaredDocument: "cni",
  requiredSides: ["document_front", "document_back"],
  captures: [],
  expiresAt: minutes(25),
  isTest: true,
};

const READY: FlowState = {
  ...initialFlowState({ hasToken: true, invalidLink: false }),
  load: "ready",
  session: { ...SESSION, status: "created", consentGiven: false, declaredDocument: null, requiredSides: null },
};

const CNI: FlowState = { ...READY, session: SESSION, document: "cni", sides: ["document_front", "document_back"] };

function state(patch: Partial<FlowState>): FlowState {
  return { ...CNI, ...patch };
}

const STATES: Record<string, FlowState> = {
  welcome: READY,
  "welcome-loading": { ...READY, load: "loading", session: null },
  "welcome-nosession": initialFlowState({ hasToken: false, invalidLink: false }),
  "welcome-failed": { ...READY, load: "failed", session: null, error: "network" },
  consent: { ...READY, screen: { name: "consent" } },
  "consent-error": { ...READY, screen: { name: "consent" }, error: "timeout" },
  declined: { ...READY, screen: { name: "declined" } },
  document: state({ screen: { name: "document" }, document: null }),
  "document-busy": state({ screen: { name: "document" }, busy: true }),
  turnover: state({ screen: { name: "turnOver", side: "document_back" } }),
  upload: state({
    screen: { name: "upload" },
    upload: { status: "running", progress: { done: 4, total: 7, phase: "send", photo: 2, photos: 2, attempt: 1 } },
  }),
  "upload-retrying": state({
    screen: { name: "upload" },
    upload: { status: "running", progress: { done: 1, total: 7, phase: "send", photo: 1, photos: 2, attempt: 2 } },
  }),
  "upload-failed": state({
    screen: { name: "upload" },
    error: "network",
    upload: { status: "failed", progress: { done: 3, total: 7, phase: "link", photo: 2, photos: 2, attempt: 3 } },
  }),
  done: state({ screen: { name: "done" } }),
  expired: state({ screen: { name: "sessionError", reason: "expired" } }),
  invalid: state({ screen: { name: "sessionError", reason: "invalid" } }),
  submitted: state({ screen: { name: "sessionError", reason: "already_submitted" } }),
};

interface CapturePreview {
  side?: CaptureSide;
  message: CaptureMessage;
  readiness: Readiness;
  progress?: number;
  tip?: boolean;
  shutter?: boolean;
  error?: FlowErrorCode;
  cameraError?: CameraErrorKind;
  debug?: boolean;
  card?: "small" | "fit" | "none";
}

const CAPTURES: Record<string, CapturePreview> = {
  capture: { message: "move_closer", readiness: "adjust", card: "small" },
  "capture-searching": { message: "no_document", readiness: "searching", tip: true, card: "none" },
  "capture-ready": { message: "ready", readiness: "ready", progress: 0.6, card: "fit" },
  "capture-shutter": { side: "document_back", message: "glare", readiness: "adjust", shutter: true, card: "fit" },
  "capture-rejected": { message: "no_document", readiness: "searching", error: "image_resolution_too_low", card: "none" },
  "capture-denied": { message: "starting", readiness: "searching", cameraError: "denied", card: "none" },
  "capture-debug": { message: "blurry", readiness: "adjust", debug: true, shutter: true, card: "fit" },
};

const REVIEWS: Record<string, { hints: Hint[]; source: "auto" | "manual"; refusals: number; lowResolution?: boolean }> = {
  review: { hints: [], source: "auto", refusals: 0 },
  "review-refused": { hints: ["blurry"], source: "manual", refusals: 1 },
  "review-override": { hints: ["glare"], source: "manual", refusals: 2 },
  "review-lowres": { hints: [], source: "auto", refusals: 0, lowResolution: true },
};

/** A specimen card drawn in a canvas: a real JPEG blob, no ID image involved. */
function useSpecimenBlob(): Blob | null {
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1040;
    canvas.height = 656;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#5b4636";
    ctx.fillRect(0, 0, 1040, 656);
    ctx.fillStyle = "#e9f0f7";
    ctx.beginPath();
    ctx.roundRect(20, 20, 1000, 616, 36);
    ctx.fill();
    ctx.fillStyle = "#1f4e9c";
    ctx.fillRect(20, 20, 1000, 90);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 44px sans-serif";
    ctx.fillText("SPECIMEN", 60, 82);
    ctx.fillStyle = "#c7d2e0";
    ctx.fillRect(60, 150, 240, 300);
    ctx.fillStyle = "#334";
    for (let i = 0; i < 6; i++) ctx.fillRect(340, 170 + i * 48, 300 + ((i * 97) % 280), 20);
    ctx.font = "32px monospace";
    ctx.fillText("IDCMR<<<<SPECIMEN<<<<<<<<<<<<<", 60, 540);
    ctx.fillText("<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<", 60, 590);
    canvas.toBlob((b) => setBlob(b), "image/jpeg", 0.85);
  }, []);
  return blob;
}

function previewShot(blob: Blob, preview: (typeof REVIEWS)[string]): Shot {
  return {
    side: "document_front",
    blob,
    quality: {
      source: preview.source,
      sharpness: 812.4,
      glareRatio: 0.0031,
      meanLuma: 168.2,
      framing: 0.86,
      videoWidth: 1080,
      videoHeight: 1920,
      elapsedMs: 5230,
    },
    hints: preview.hints,
    lowResolution: preview.lowResolution ?? false,
    info: { width: 1040, height: 656, bytes: blob.size, jpegQuality: 0.88, scale: 1, attempts: 1 },
  };
}

const TABLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "repeating-linear-gradient(115deg, #4a3a2c 0 14px, #55432f 14px 30px)",
};

function FakeCard({ size }: { size: "small" | "fit" }) {
  const width = size === "fit" ? "86%" : "58%";
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "52%",
        width,
        aspectRatio: "85.6 / 53.98",
        transform: "translate(-50%, -50%)",
        borderRadius: 14,
        background: "linear-gradient(#1f4e9c 0 18%, #e9f0f7 18%)",
        boxShadow: "0 6px 18px rgba(0,0,0,.45)",
      }}
    />
  );
}

function CapturePreviewScreen({ preview }: { preview: CapturePreview }) {
  return (
    <CaptureView
      side={preview.side ?? "document_front"}
      document="cni"
      media={
        <div style={TABLE}>{preview.card && preview.card !== "none" && <FakeCard size={preview.card} />}</div>
      }
      message={preview.message}
      readiness={preview.readiness}
      progress={preview.progress ?? 0}
      tip={preview.tip ?? false}
      showShutter={preview.shutter ?? false}
      error={preview.error ?? null}
      cameraError={preview.cameraError ?? null}
      debug={
        preview.debug ? (
          <CaptureDebug
            live={{
              mode: "worker",
              fps: 7.9,
              video: { width: 1080, height: 1920 },
              result: {
                hints: ["blurry"],
                ok: false,
                decision: "wait",
                progress: 0,
                ms: 21.4,
                metrics: {
                  sharpness: 412.3,
                  noise: 2.1,
                  contrast: 38,
                  focus: 3.2,
                  glareRatio: 0.004,
                  glareTileRatio: 0.012,
                  meanLuma: 171,
                  framing: 0.84,
                  coverage: 0.86,
                  centerOffset: 0.02,
                  overshoot: 0,
                  documentBox: null,
                  documentAngle: 0,
                  documentExtent: null,
                  documentConfidence: 0.93,
                  motion: 3.2,
                },
              },
            }}
          />
        ) : null
      }
      onShutter={noop}
      onBack={noop}
      onRetryCamera={noop}
    />
  );
}

function ReviewPreview({ name }: { name: string }) {
  const blob = useSpecimenBlob();
  if (!blob) return null;
  const preview = REVIEWS[name];
  const shot = previewShot(blob, preview);
  const reviewState = state({
    screen: { name: "review", side: "document_front" },
    shots: { document_front: shot },
    refusals: preview.refusals ? { document_front: preview.refusals } : {},
  });
  return <FlowView state={reviewState} actions={ACTIONS} debug={name === "review"} />;
}

export function Preview({ screen }: { screen: string }) {
  if (screen in CAPTURES) return <CapturePreviewScreen preview={CAPTURES[screen]} />;
  if (screen in REVIEWS) return <ReviewPreview name={screen} />;
  const preview = STATES[screen];
  if (!preview) {
    const names = [...Object.keys(STATES), ...Object.keys(CAPTURES), ...Object.keys(REVIEWS)];
    return (
      <main className="page">
        <h1>Unknown screen</h1>
        <ul>
          {names.map((n) => (
            <li key={n}>
              <a href={`?screen=${n}`}>{n}</a>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  return <FlowView state={preview} actions={ACTIONS} debug={false} />;
}

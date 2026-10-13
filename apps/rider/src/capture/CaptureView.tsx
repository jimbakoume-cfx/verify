// The camera screen's layout, without the camera: the live screen (CaptureScreen) and the dev
// preview both render it. CSS decides where the free area for the guide is (portrait or landscape);
// this component measures it and draws the guide there.
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DOCUMENT_ASPECT, LanguageToggle, type CaptureSide, type DeclaredDocument } from "@verify/shared";
import type { Rect } from "@verify/capture";
import { type FlowErrorCode, errorMessageKey } from "../flow/errors";
import { sideLabelKey } from "../labels";
import type { CameraErrorKind } from "./camera";
import { type Size, guideInArea } from "./geometry";
import { GuideOverlay } from "./GuideOverlay";
import type { Readiness, Shown } from "./hints";

export interface CaptureLayout {
  /** Size of the stage, which the <video> fills exactly. */
  stage: Size;
  /** The guide in stage (= video element) CSS pixels. */
  guide: Rect;
}

/**
 * What the big label says: a hint, "hold still", a camera state, or that the camera cannot give the
 * server's minimum resolution here: "turnUpright" (phone sideways) or "tooLittleDetail".
 */
export type CaptureMessage = Shown | "starting" | "processing" | "turnUpright" | "tooLittleDetail";

export interface CaptureViewProps {
  side: CaptureSide;
  document: DeclaredDocument;
  /** The <video> element (or a stand-in in the preview); it must fill the stage. */
  media: ReactNode;
  message: CaptureMessage;
  readiness: Readiness;
  progress: number;
  /** Suggest a plain surface (the card has not been found for a while). */
  tip: boolean;
  showShutter: boolean;
  /** Error from the previous attempt (e.g. the server refused the photo). */
  error: FlowErrorCode | null;
  cameraError: CameraErrorKind | null;
  debug?: ReactNode;
  onLayout?: (layout: CaptureLayout) => void;
  onShutter: () => void;
  onBack: () => void;
  onRetryCamera: () => void;
}

function messageKey(message: CaptureMessage): string {
  switch (message) {
    case "starting":
      return "capture.starting";
    case "processing":
      return "capture.processing";
    case "ready":
      return "capture.ready";
    case "turnUpright":
      return "capture.turnUpright";
    case "tooLittleDetail":
      return "capture.tooLittleDetail";
    default:
      return `hints.${message}`;
  }
}

function sameLayout(a: CaptureLayout | null, b: CaptureLayout): boolean {
  if (!a) return false;
  const near = (p: number, q: number) => Math.abs(p - q) < 0.5;
  return (
    near(a.stage.width, b.stage.width) &&
    near(a.stage.height, b.stage.height) &&
    near(a.guide.x, b.guide.x) &&
    near(a.guide.y, b.guide.y) &&
    near(a.guide.width, b.guide.width)
  );
}

function useGuideLayout(
  stageRef: RefObject<HTMLDivElement | null>,
  areaRef: RefObject<HTMLDivElement | null>,
  aspect: number,
): CaptureLayout | null {
  const [layout, setLayout] = useState<CaptureLayout | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const area = areaRef.current;
    if (!stage || !area) return;
    const measure = () => {
      const s = stage.getBoundingClientRect();
      const a = area.getBoundingClientRect();
      if (s.width <= 0 || s.height <= 0 || a.width <= 0 || a.height <= 0) return;
      const next: CaptureLayout = {
        stage: { width: s.width, height: s.height },
        guide: guideInArea({ x: a.left - s.left, y: a.top - s.top, width: a.width, height: a.height }, aspect),
      };
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(stage);
      observer.observe(area);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [stageRef, areaRef, aspect]);
  return layout;
}

export function CaptureView(props: CaptureViewProps) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const layout = useGuideLayout(stageRef, areaRef, DOCUMENT_ASPECT[props.document]);
  const { onLayout } = props;
  useEffect(() => {
    if (layout) onLayout?.(layout);
  }, [layout, onLayout]);

  // Screen readers: the title takes focus when the camera screen appears (as ScreenTitle does on
  // the other screens), and the camera-error card when it shows, the camera UI behind it inert.
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  const errorTitleId = useId();
  const errorRef = useRef<HTMLElement>(null);
  const { cameraError } = props;
  useEffect(() => {
    if (cameraError) errorRef.current?.focus({ preventScroll: true });
  }, [cameraError]);

  return (
    <div className="capture" ref={stageRef}>
      {props.media}
      {layout && (
        <GuideOverlay stage={layout.stage} guide={layout.guide} readiness={props.readiness} progress={props.progress} />
      )}

      <div className="capture-ui" inert={cameraError !== null}>
        <header className="capture-top">
          <button type="button" className="capture-back" onClick={props.onBack}>
            <span aria-hidden="true">‹</span> {t("common.back")}
          </button>
          <div className="capture-title">
            <h1 ref={titleRef} tabIndex={-1}>
              {t(sideLabelKey(props.document, props.side))}
            </h1>
            <span>{t(`documents.${props.document}`)}</span>
          </div>
          <LanguageToggle />
        </header>

        <div className="capture-hint">
          {props.error && (
            <p className="capture-alert" role="alert">
              {t(errorMessageKey(props.error))}
            </p>
          )}
          <div aria-live="polite" aria-atomic="true">
            <p className={`hint-pill ${props.readiness}`}>{t(messageKey(props.message))}</p>
            <p className="hint-tip">{props.tip ? t("capture.tipSurface") : " "}</p>
          </div>
        </div>

        <div className="capture-area" ref={areaRef} />
        {props.debug}

        <footer className="capture-bottom">
          {props.showShutter ? (
            <button
              type="button"
              className="shutter"
              aria-label={t("capture.shutter")}
              onClick={props.onShutter}
              disabled={props.message === "processing" || props.message === "starting"}
            >
              <span />
            </button>
          ) : (
            <p className="capture-auto">{t("capture.auto")}</p>
          )}
        </footer>
      </div>

      {cameraError && (
        <div className="camera-error">
          <section
            className="card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={errorTitleId}
            tabIndex={-1}
            ref={errorRef}
          >
            <h2 id={errorTitleId}>{t(`camera.${cameraError}Title`)}</h2>
            <p>{t(`camera.${cameraError}`)}</p>
            <div className="actions">
              <button type="button" className="primary" onClick={props.onRetryCamera}>
                {t("common.retry")}
              </button>
              <button type="button" className="secondary" onClick={props.onBack}>
                {t("common.back")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

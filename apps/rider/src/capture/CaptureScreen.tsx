// The live camera for one side of the document. Loaded on demand (React.lazy): the capture engine
// and this screen stay out of the first download; the analysis itself runs in a worker chunk.
//
// Camera lifecycle: the stream is opened when the screen shows, stopped on unmount, while the page
// is hidden, and right after the photo is grabbed. "Retake" mounts this screen again (new stream).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_THRESHOLDS } from "@verify/capture";
import type { CaptureSide, ClientQuality, DeclaredDocument } from "@verify/shared";
import type { FlowErrorCode } from "../flow/errors";
import { type Shot, mrzExpectationFor } from "../flow/machine";
import { type Analyzer, createAnalyzer } from "./analyzerClient";
import { type CameraErrorKind, classifyCameraError, openCamera, stopStream } from "./camera";
import { CaptureDebug, type LiveDebug } from "./CaptureDebug";
import { type CaptureLayout, type CaptureMessage, CaptureView } from "./CaptureView";
import { createFrameGrabber } from "./frameGrabber";
import { planFrame, planStill } from "./geometry";
import { HintStabilizer, type Readiness, SURFACE_TIP_AFTER_MS, readinessOf, topMessage } from "./hints";
import { parseThresholdOverrides } from "./overrides";
import { finishStill, grabStill } from "./still";
import { usePageVisible } from "./usePageVisible";

/** About 8 analysis frames per second (spec). */
const FRAME_INTERVAL_MS = 125;
/** The manual shutter appears when auto-capture has not fired within this time (spec: 8 s). */
const SHUTTER_AFTER_MS = 8000;

type CameraState =
  | { state: "starting" }
  | { state: "live" }
  | { state: "processing" }
  | { state: "error"; kind: CameraErrorKind };

interface LiveView {
  message: CaptureMessage;
  readiness: Readiness;
  progress: number;
  tip: boolean;
}

const STARTING_VIEW: LiveView = { message: "starting", readiness: "searching", progress: 0, tip: false };

function sameView(a: LiveView, b: LiveView): boolean {
  return a.message === b.message && a.readiness === b.readiness && a.progress === b.progress && a.tip === b.tip;
}

export interface CaptureScreenProps {
  side: CaptureSide;
  document: DeclaredDocument;
  error: FlowErrorCode | null;
  debug: boolean;
  onCaptured: (shot: Shot) => void;
  onBack: () => void;
}

export default function CaptureScreen({ side, document, error, debug, onCaptured, onBack }: CaptureScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const layoutRef = useRef<CaptureLayout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyzerRef = useRef<Analyzer | null>(null);
  const capturingRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const onCapturedRef = useRef(onCaptured);
  useEffect(() => {
    onCapturedRef.current = onCaptured;
  }, [onCaptured]);

  const visible = usePageVisible();
  const [camera, setCamera] = useState<CameraState>({ state: "starting" });
  const [restart, setRestart] = useState(0);
  const [view, setView] = useState<LiveView>(STARTING_VIEW);
  const [shutter, setShutter] = useState(false);
  const [live, setLive] = useState<LiveDebug | null>(null);

  const overrides = useMemo(
    () => (debug ? parseThresholdOverrides(window.location.search, DEFAULT_THRESHOLDS) : {}),
    [debug],
  );

  const onLayout = useCallback((layout: CaptureLayout) => {
    layoutRef.current = layout;
  }, []);

  // One analyzer (worker) for the screen's lifetime.
  useEffect(() => {
    const analyzer = createAnalyzer(overrides);
    analyzerRef.current = analyzer;
    return () => {
      analyzer.dispose();
      analyzerRef.current = null;
    };
  }, [overrides]);

  // The camera: open while the page is visible and no photo has been taken.
  useEffect(() => {
    const video = videoRef.current;
    if (!visible) {
      if (!capturingRef.current) setCamera({ state: "starting" });
      return;
    }
    if (capturingRef.current || !video) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    const onEnded = () => {
      // The system took the camera away (another app, a call): offer to restart it.
      if (!cancelled && !capturingRef.current) setCamera({ state: "error", kind: "busy" });
    };
    setCamera({ state: "starting" });
    openCamera()
      .then(async (opened) => {
        if (cancelled) {
          stopStream(opened);
          return;
        }
        stream = opened;
        streamRef.current = opened;
        opened.getVideoTracks().forEach((track) => track.addEventListener("ended", onEnded));
        video.srcObject = opened;
        try {
          await video.play();
        } catch {
          // Muted inline video may autoplay anyway; the loop waits until frames arrive.
        }
        if (cancelled) return;
        startedAtRef.current ??= performance.now();
        setCamera({ state: "live" });
      })
      .catch((err: unknown) => {
        if (!cancelled) setCamera({ state: "error", kind: classifyCameraError(err) });
      });
    return () => {
      cancelled = true;
      stream?.getVideoTracks().forEach((track) => track.removeEventListener("ended", onEnded));
      stopStream(stream);
      if (streamRef.current === stream) streamRef.current = null;
      video.srcObject = null;
    };
  }, [visible, restart]);

  // The manual shutter, after 8 s of live camera without an automatic photo.
  useEffect(() => {
    if (camera.state !== "live" || shutter) return;
    const timer = window.setTimeout(() => setShutter(true), SHUTTER_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [camera.state, shutter]);

  /**
   * Freezes the current frame and finishes the photo in the background. Returns whether a photo
   * was started: false when nothing could be grabbed (the analysis loop then keeps going).
   */
  const takePhoto = useCallback(
    (source: ClientQuality["source"]): boolean => {
      const video = videoRef.current;
      const layout = layoutRef.current;
      if (capturingRef.current || !video || !layout) return false;
      const plan = planFrame(layout.guide, layout.stage, { width: video.videoWidth, height: video.videoHeight });
      if (!plan) return false;
      capturingRef.current = true;
      const elapsedMs = performance.now() - (startedAtRef.current ?? performance.now());
      let grabbed: ReturnType<typeof grabStill>;
      try {
        grabbed = grabStill(video, plan.guideSrc);
      } catch {
        // No canvas (e.g. out of memory): say so, with a way to restart the camera.
        capturingRef.current = false;
        setCamera({ state: "error", kind: "unknown" });
        return false;
      }
      // The frame is safe in a canvas: release the camera at once.
      stopStream(streamRef.current);
      streamRef.current = null;
      setCamera({ state: "processing" });
      finishStill(grabbed, {
        source,
        elapsedMs,
        thresholds: { ...DEFAULT_THRESHOLDS, ...overrides },
        // Only the side with the MRZ: the copy costs memory until the lines are read.
        keepGray: mrzExpectationFor(document, side) !== null,
      }).then(
        (still) =>
          onCapturedRef.current({
            side,
            blob: still.blob,
            quality: still.quality,
            hints: still.hints,
            lowResolution: still.lowResolution,
            info: {
              width: still.width,
              height: still.height,
              bytes: still.blob.size,
              jpegQuality: still.jpegQuality,
              scale: still.scale,
              attempts: still.attempts,
            },
            gray: still.gray,
          }),
        () => {
          capturingRef.current = false;
          setCamera({ state: "error", kind: "unknown" });
        },
      );
      return true;
    },
    [side, document, overrides],
  );
  const takePhotoRef = useRef(takePhoto);
  useEffect(() => {
    takePhotoRef.current = takePhoto;
  }, [takePhoto]);

  // The analysis loop: about 8 frames per second while the camera is live.
  useEffect(() => {
    const video = videoRef.current;
    const analyzer = analyzerRef.current;
    if (camera.state !== "live" || !video || !analyzer) return;
    const grabber = createFrameGrabber();
    const stabilizer = new HintStabilizer();
    let stopped = false;
    let timer: number | undefined;
    let frames = 0;
    let windowStart = performance.now();
    let fps = 0;
    analyzer.reset();
    setView(STARTING_VIEW);

    const schedule = (delay: number) => {
      if (!stopped) timer = window.setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      const started = performance.now();
      const layout = layoutRef.current;
      // readyState 2 = HAVE_CURRENT_DATA: a frame can be drawn.
      const plan =
        layout && video.readyState >= 2
          ? planFrame(layout.guide, layout.stage, { width: video.videoWidth, height: video.videoHeight })
          : null;
      if (plan) {
        try {
          const frame = grabber.grab(video, plan.crop);
          const result = frame ? await analyzer.analyze(frame, plan.crop.guide) : null;
          if (stopped) return;
          if (result) {
            const now = performance.now();
            frames++;
            if (now - windowStart >= 1000) {
              fps = (frames * 1000) / (now - windowStart);
              frames = 0;
              windowStart = now;
            }
            // The photo would be under the server's minimum resolution (the camera gives too few
            // pixels for the guide here): say so before any shot, and never take it automatically.
            const lowResolution = planStill(plan.guideSrc, { width: video.videoWidth, height: video.videoHeight }).lowResolution;
            let next: LiveView;
            if (lowResolution) {
              stabilizer.reset();
              const sideways = layout !== null && layout.stage.width > layout.stage.height;
              next = { message: sideways ? "turnUpright" : "tooLittleDetail", readiness: "adjust", progress: 0, tip: false };
            } else {
              const shown = stabilizer.push(topMessage(result.hints), now);
              next = {
                message: shown,
                readiness: readinessOf(shown),
                progress: result.progress,
                tip: shown === "no_document" && stabilizer.shownFor(now) > SURFACE_TIP_AFTER_MS,
              };
            }
            setView((prev) => (sameView(prev, next) ? prev : next));
            if (debug) {
              setLive({ result, fps, mode: analyzer.mode, video: { width: video.videoWidth, height: video.videoHeight } });
            }
            if (result.decision === "capture") {
              if (!lowResolution && takePhotoRef.current("auto")) return;
              // Re-arm auto-capture: it fires once, then waits for a reset.
              analyzer.reset();
            }
          }
        } catch {
          // A dropped frame (e.g. the worker failed and analysis moved to the main thread).
        }
      }
      schedule(Math.max(0, FRAME_INTERVAL_MS - (performance.now() - started)));
    };
    schedule(0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      grabber.dispose();
    };
  }, [camera.state, debug]);

  const retryCamera = useCallback(() => {
    capturingRef.current = false;
    setRestart((n) => n + 1);
  }, []);

  const isLive = camera.state === "live";
  const message: CaptureMessage =
    camera.state === "processing" ? "processing" : isLive ? view.message : "starting";

  return (
    <CaptureView
      side={side}
      document={document}
      media={<video ref={videoRef} className="capture-video" playsInline muted autoPlay />}
      message={message}
      readiness={isLive ? view.readiness : "searching"}
      progress={isLive ? view.progress : 0}
      tip={isLive && view.tip}
      showShutter={shutter && camera.state !== "error"}
      error={error}
      cameraError={camera.state === "error" ? camera.kind : null}
      debug={debug && live ? <CaptureDebug live={live} /> : null}
      onLayout={onLayout}
      onShutter={() => takePhoto("manual")}
      onBack={onBack}
      onRetryCamera={retryCamera}
    />
  );
}

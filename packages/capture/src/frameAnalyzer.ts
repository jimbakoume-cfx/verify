import type { ClientQuality } from "../../../supabase/functions/_shared/contract";
import type { AutoCaptureDecision, FrameAnalysis, FrameMetrics, GrayImage, QualityThresholds, Rect } from "./types";
import { analyzeFrame } from "./analyze";
import { AutoCapture } from "./autoCapture";
import { toGray } from "./gray";
import { DEFAULT_THRESHOLDS } from "./thresholds";

/** RGBA pixels with their size; a canvas `ImageData` fits. */
export interface RgbaFrame {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** Result of {@link FrameAnalyzer.push}. */
export interface FrameStep {
  analysis: FrameAnalysis;
  /** "capture" exactly once, when enough good frames came in a row. */
  decision: AutoCaptureDecision;
}

/**
 * The live analysis loop in one object, for the Web Worker: converts each frame to gray, analyses
 * it against the previous one, and feeds {@link AutoCapture}. Keeps two gray buffers and swaps
 * them, so the loop allocates nothing per frame.
 *
 * @example
 * // analyzer.worker.ts
 * const analyzer = new FrameAnalyzer();
 * self.onmessage = (e) => {
 *   const { frame, guide } = e.data; // frame: ImageData of analysisCrop(...).width x height
 *   const { analysis, decision } = analyzer.push(frame, guide);
 *   self.postMessage({ hints: analysis.hints, metrics: analysis.metrics, decision });
 * };
 */
export class FrameAnalyzer {
  readonly thresholds: QualityThresholds;
  readonly autoCapture: AutoCapture;
  #buffers: [Uint8Array, Uint8Array] = [new Uint8Array(0), new Uint8Array(0)];
  #next = 0;
  #prev: GrayImage | null = null;

  constructor(thresholds: QualityThresholds = DEFAULT_THRESHOLDS) {
    this.thresholds = thresholds;
    this.autoCapture = new AutoCapture(thresholds.stableFramesRequired);
  }

  /** Analyses one frame. `guide` is the guide in the frame's pixels (`analysisCrop(...).guide`). */
  push(frame: RgbaFrame, guide: Rect): FrameStep {
    const n = frame.width * frame.height;
    if (this.#buffers[this.#next].length < n) this.#buffers[this.#next] = new Uint8Array(n);
    const gray = toGray(frame.data, frame.width, frame.height, this.#buffers[this.#next]);
    const analysis = analyzeFrame(gray, guide, this.#prev, this.thresholds);
    const decision = this.autoCapture.push(analysis);
    this.#prev = gray;
    this.#next ^= 1;
    return { analysis, decision };
  }

  /** Forgets the previous frame and re-arms auto-capture (after "Retake", or when the camera restarts). */
  reset(): void {
    this.#prev = null;
    this.autoCapture.reset();
  }
}

/** Capture context that the metrics do not know. */
export type CaptureContext = Pick<ClientQuality, "source" | "videoWidth" | "videoHeight" | "elapsedMs">;

/**
 * Builds the `ClientQuality` sent with `POST /flow/captures`, from the metrics of the still's
 * re-analysis (or of the frame that triggered auto-capture). Values are rounded for a tidy payload;
 * `sharpness` is the raw Laplacian variance, as the contract defines it.
 */
export function toClientQuality(
  metrics: Pick<FrameMetrics, "sharpness" | "glareRatio" | "meanLuma" | "framing">,
  context: CaptureContext,
): ClientQuality {
  return {
    source: context.source,
    sharpness: Math.round(metrics.sharpness * 10) / 10,
    glareRatio: Math.round(metrics.glareRatio * 10000) / 10000,
    meanLuma: Math.round(metrics.meanLuma * 10) / 10,
    framing: Math.round(Math.min(1, Math.max(0, metrics.framing)) * 1000) / 1000,
    videoWidth: Math.round(context.videoWidth),
    videoHeight: Math.round(context.videoHeight),
    elapsedMs: Math.max(0, Math.round(context.elapsedMs)),
  };
}

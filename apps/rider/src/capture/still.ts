// The final photo: cut the guide (+4%) from one video frame, size it, compress it under the target
// with canvas.toBlob, and re-check its quality on a small copy. For the side that carries the MRZ,
// also keep a full-resolution grayscale copy to read it from.
//
// The JPEG comes from a canvas, so it carries no EXIF or GPS data. Keep it that way: never upload
// the camera's original file.
import {
  ANALYSIS_WIDTH,
  DEFAULT_THRESHOLDS,
  type FrameMetrics,
  type GrayImage,
  type Hint,
  type QualityThresholds,
  type Rect,
  analyzeFrame,
  compressToTarget,
  compressionScales,
  toClientQuality,
  toGray,
} from "@verify/capture";
import { CAPTURE_LIMITS, type ClientQuality } from "@verify/shared";
import { type Size, type StillPlan, guideInStillCopy, planStill } from "./geometry";

/** A frozen frame: taken synchronously so the camera can be stopped right away. */
export interface GrabbedStill {
  canvas: HTMLCanvasElement;
  plan: StillPlan;
  guideSrc: Rect;
  video: Size;
}

export interface StillResult {
  blob: Blob;
  width: number;
  height: number;
  jpegQuality: number;
  scale: number;
  attempts: number;
  lowResolution: boolean;
  hints: Hint[];
  metrics: FrameMetrics;
  quality: ClientQuality;
  /** Full-resolution grayscale copy (FinishOptions.keepGray); null when not asked for or not possible. */
  gray: GrayImage | null;
}

function canvas2d(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return [canvas, ctx];
}

/** Draws the still crop of the current video frame at its output size. */
export function grabStill(video: HTMLVideoElement, guideSrc: Rect): GrabbedStill {
  const size = { width: video.videoWidth, height: video.videoHeight };
  const plan = planStill(guideSrc, size);
  const [canvas, ctx] = canvas2d(plan.size.width, plan.size.height);
  const { x, y, width, height } = plan.source;
  ctx.drawImage(video, x, y, width, height, 0, 0, plan.size.width, plan.size.height);
  return { canvas, plan, guideSrc, video: size };
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("JPEG encoding failed"))), "image/jpeg", quality),
  );
}

export interface FinishOptions {
  source: ClientQuality["source"];
  elapsedMs: number;
  thresholds?: QualityThresholds;
  /** Keep a full-resolution grayscale copy for reading the MRZ (only for the side that carries it). */
  keepGray?: boolean;
}

/**
 * Grayscale copy of the whole canvas at its own resolution. Null when the phone cannot spare the
 * memory: the MRZ is then not read, which never blocks the rider.
 */
function grayCopy(canvas: HTMLCanvasElement): GrayImage | null {
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return toGray(data, canvas.width, canvas.height);
  } catch {
    return null;
  }
}

/** Compresses the grabbed still and re-checks it. Frees the canvases afterwards. */
export async function finishStill(still: GrabbedStill, options: FinishOptions): Promise<StillResult> {
  const { canvas, plan } = still;
  const scaled = new Map<number, HTMLCanvasElement>();
  const at = (scale: number): HTMLCanvasElement => {
    if (scale === 1) return canvas;
    let copy = scaled.get(scale);
    if (!copy) {
      const [c, ctx] = canvas2d(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
      ctx.drawImage(canvas, 0, 0, c.width, c.height);
      scaled.set(scale, (copy = c));
    }
    return copy;
  };

  try {
    // The MRZ is read from these pixels, not from the JPEG: its characters are only about 15 px tall
    // on a passport held upright, and compression artefacts at that size cost characters. Taken
    // first, while the full-size canvas still exists.
    const gray = options.keepGray ? grayCopy(canvas) : null;

    const longSide = Math.max(canvas.width, canvas.height);
    const result = await compressToTarget((q, s) => toJpeg(at(s), q), undefined, { scales: compressionScales(longSide) });
    const encoded = at(result.scale);

    // Re-check the still itself: auto-capture judged a frame a moment earlier, and a manual shot
    // was never judged at all.
    const smallW = Math.min(ANALYSIS_WIDTH, canvas.width);
    const smallH = Math.max(1, Math.round((canvas.height * smallW) / canvas.width));
    const [small, smallCtx] = canvas2d(smallW, smallH);
    smallCtx.drawImage(canvas, 0, 0, smallW, smallH);
    const pixels = smallCtx.getImageData(0, 0, smallW, smallH);
    small.width = small.height = 1;
    const guide = guideInStillCopy(still.guideSrc, plan.source, { width: smallW, height: smallH });
    const analysis = analyzeFrame(toGray(pixels.data, smallW, smallH), guide, null, options.thresholds ?? DEFAULT_THRESHOLDS);

    return {
      blob: result.blob,
      width: encoded.width,
      height: encoded.height,
      jpegQuality: result.quality,
      scale: result.scale,
      attempts: result.attempts,
      lowResolution: Math.max(encoded.width, encoded.height) < CAPTURE_LIMITS.minLongSide,
      hints: analysis.hints,
      metrics: analysis.metrics,
      quality: toClientQuality(analysis.metrics, {
        source: options.source,
        videoWidth: still.video.width,
        videoHeight: still.video.height,
        elapsedMs: options.elapsedMs,
      }),
      gray,
    };
  } finally {
    // Free the full-size pixels at once: phones have little memory to spare.
    canvas.width = canvas.height = 1;
    for (const c of scaled.values()) c.width = c.height = 1;
  }
}

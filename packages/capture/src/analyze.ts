// One analysis step of the live camera loop: find the card, measure it, list what to fix.
import type { FrameAnalysis, FrameMetrics, GrayImage, Hint, QualityThresholds, Rect } from "./types";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import { detectDocumentBox } from "./detect";
import { clampRect, expandRect, intersectRect, rectArea, rectCenter } from "./geometry";
import {
  estimateNoise,
  frameMotion,
  glare,
  laplacianDetail,
  laplacianVariance,
  lumaStats,
  temporalNoise,
} from "./metrics";
import { assertGray } from "./pixels";

/** Every hint, most important first: `analysis.hints` is always in this order. */
export const HINT_PRIORITY: readonly Hint[] = Object.freeze([
  "no_document",
  "move_closer",
  "move_back",
  "center_document",
  "too_dark",
  "too_bright",
  "glare",
  "blurry",
  "hold_still",
]);

/**
 * Sharpness and noise are measured on the document area shrunk by this fraction (4% off each
 * side), so the card's own border, which is sharp against almost any background, does not
 * count as detail. Text and pattern inside the card are what OCR needs.
 */
const SHARPNESS_INSET = 0.08;

/**
 * Brightness and glare are measured on the document area shrunk by this fraction (3% off each
 * side): a slightly tilted card leaves slivers of the table in the corners of its box, and a
 * bright table (white paper in daylight) there would otherwise count as glare on the card.
 */
const SURFACE_INSET = 0.06;

/**
 * Contrast (luma standard deviation) of a typical light ID card at analysis size; the
 * synthetic test card measures 37-39. `focus` rescales sharpness to this contrast.
 */
export const FOCUS_REFERENCE_CONTRAST = 40;
/** Largest boost `focus` applies to a low-contrast (e.g. dim) document: 3x contrast = 9x variance. */
const FOCUS_MAX_GAIN = 3;

/** Mean |a - b| of two independent noise samples is 2 / sqrt(pi) = 1.128 times their standard deviation. */
const NOISE_MOTION_GAIN = 2 / Math.sqrt(Math.PI);

/**
 * Analyses one frame of the live camera loop.
 *
 * @param gray The analysis image (see `analysisCrop` and {@link toGray}).
 * @param guide The on-screen guide in `gray` pixels (`analysisCrop(...).guide`).
 * @param prev The previous frame, for the steadiness check; `null` for the first frame or for a
 *   still. A previous frame of a different size (e.g. after a rotation) is ignored. When reusing
 *   buffers with `toGray(..., out)`, alternate two of them (or use {@link FrameAnalyzer}).
 * @param thresholds Pass/fail limits; `{ ...DEFAULT_THRESHOLDS, ...overrides }` to tune.
 * @returns The measurements, the hints to show (most important first, see {@link HINT_PRIORITY})
 *   and `ok` when there is nothing to fix.
 */
export function analyzeFrame(
  gray: GrayImage,
  guide: Rect,
  prev: GrayImage | null,
  thresholds: QualityThresholds = DEFAULT_THRESHOLDS,
): FrameAnalysis {
  assertGray(gray);
  const t = thresholds;
  const detection = detectDocumentBox(gray, guide);
  const found = detection.box !== null && detection.confidence >= t.minDocumentConfidence;
  const box = found ? detection.box : null;
  // Where the card's corners reach: a tilted card's corners stick out beyond `box`.
  const extent = found ? (detection.extent ?? detection.box) : null;
  const angle = found ? detection.angle : 0;

  const area = clampRect(box ?? guide, gray.width, gray.height);
  const inner = expandRect(area, -SHARPNESS_INSET);
  const sharpness = laplacianVariance(gray, inner);
  const noise = estimateNoise(gray, inner);
  const contrast = Math.sqrt(Math.max(0, lumaStats(gray, inner).variance - noise * noise));
  const focus = focusScore(laplacianDetail(gray, inner), contrast);
  const surface = expandRect(area, -SURFACE_INSET);
  const luma = lumaStats(gray, surface).mean;
  const glareMeasure = glare(gray, surface, 4);
  const comparable = prev !== null && prev.width === gray.width && prev.height === gray.height;
  const motion = comparable ? frameMotion(prev, gray) : null;
  // Per-pixel noise as seen between the frames; the spatial estimate alone reads too low for the
  // correlated grain of real previews, which would make a steady phone look shaky in dim light.
  const motionNoise = comparable ? Math.max(noise, temporalNoise(prev, gray)) : noise;

  const guideArea = rectArea(guide);
  const framing = box && guideArea > 0 ? rectArea(intersectRect(box, guide)) / guideArea : 0;
  const coverage = box && guideArea > 0 ? rectArea(box) / guideArea : 0;
  let centerOffset = 0;
  let overshoot = 0;
  if (box && extent && guide.width > 0 && guide.height > 0) {
    const bc = rectCenter(box);
    const gc = rectCenter(guide);
    centerOffset = Math.hypot(bc.x - gc.x, bc.y - gc.y) / guide.width;
    overshoot = Math.max(
      0,
      (guide.x - extent.x) / guide.width,
      (extent.x + extent.width - guide.x - guide.width) / guide.width,
      (guide.y - extent.y) / guide.height,
      (extent.y + extent.height - guide.y - guide.height) / guide.height,
    );
  }

  const metrics: FrameMetrics = {
    sharpness,
    noise,
    contrast,
    focus,
    glareRatio: glareMeasure.ratio,
    glareTileRatio: glareMeasure.maxTileRatio,
    meanLuma: luma,
    framing,
    coverage,
    centerOffset,
    overshoot,
    documentBox: box,
    documentConfidence: detection.confidence,
    documentAngle: angle,
    documentExtent: extent,
    motion,
  };

  const hints: Hint[] = [];
  if (!box) {
    hints.push("no_document");
  } else {
    // Too big = cannot fit inside the guide plus the tolerated overshoot, however it is moved
    // (straightened, if tilted: only a tilted card's corners stick out further, and centring and
    // straightening is the fix for that).
    const limit = 1 + 2 * t.maxOvershoot;
    const tooBig = box.width > guide.width * limit || box.height > guide.height * limit;
    if (coverage < t.minFraming) hints.push("move_closer");
    if (tooBig) hints.push("move_back");
    if (
      centerOffset > t.maxCenterOffset ||
      (!tooBig && overshoot > t.maxOvershoot) ||
      (coverage >= t.minFraming && framing < t.minFraming) ||
      Math.abs(angle) > t.maxTiltDeg
    ) {
      hints.push("center_document");
    }
  }
  if (luma < t.minMeanLuma) hints.push("too_dark");
  if (luma > t.maxMeanLuma) hints.push("too_bright");
  if (metrics.glareRatio > t.maxGlareRatio || metrics.glareTileRatio > t.maxGlareTileRatio) {
    hints.push("glare");
  }
  if (focus < t.minSharpness) hints.push("blurry");
  if (motion !== null && motion - NOISE_MOTION_GAIN * motionNoise > t.maxMotion) hints.push("hold_still");

  return { metrics, hints, ok: hints.length === 0 };
}

/**
 * Noise-free fine detail ({@link laplacianDetail}) rescaled to {@link FOCUS_REFERENCE_CONTRAST}:
 * the Laplacian grows with contrast squared, so a dim or faded but sharp card would otherwise
 * look blurry.
 */
function focusScore(detail: number, contrast: number): number {
  const c = Math.max(contrast, FOCUS_REFERENCE_CONTRAST / FOCUS_MAX_GAIN);
  return detail * (FOCUS_REFERENCE_CONTRAST / c) ** 2;
}

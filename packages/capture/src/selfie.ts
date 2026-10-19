// Face check (M5): cheap checks on the front camera's picture before the rider starts. No face
// detector runs on the phone (see docs/M5_SPEC.md: MediaPipe, the only detector allowed, is too heavy
// a download for M5): these only catch a picture nobody could judge later, too dark, too bright, lit
// from behind, or flat (a covered lens, a wall). They never decide anything; the rider may start
// anyway after a short wait, and the server records that they did.
import { lumaStats } from "./metrics";
import type { GrayImage, Rect } from "./types";

export type SelfieHint = "too_dark" | "too_bright" | "backlit" | "no_face";

export interface SelfieThresholds {
  /** Mean brightness inside the oval, 0..255. */
  minMeanLuma: number;
  maxMeanLuma: number;
  /** Standard deviation of brightness inside the oval: below it, the picture is flat (no face to see). */
  minContrast: number;
  /** The oval darker than its surroundings by more than this (a window or lamp behind the rider). */
  maxBacklight: number;
}

/**
 * Chosen on synthetic pictures (selfie.test.ts) and checked against the e2e fake cameras; to tune on
 * real phones. A face under room light sits around 90-170; a covered lens has a deviation under 5.
 */
export const SELFIE_THRESHOLDS: SelfieThresholds = {
  minMeanLuma: 45,
  maxMeanLuma: 215,
  minContrast: 12,
  maxBacklight: 70,
};

export interface SelfieAnalysis {
  meanLuma: number;
  contrast: number;
  /** Mean brightness around the oval minus inside it (positive: the background is brighter). */
  backlight: number;
  /** The most important problem, or null when the picture is usable. */
  hint: SelfieHint | null;
}

/** The middle of the oval's box (its inner 70%), where a face fills the picture. */
function innerRect(oval: Rect): Rect {
  return {
    x: oval.x + oval.width * 0.15,
    y: oval.y + oval.height * 0.15,
    width: oval.width * 0.7,
    height: oval.height * 0.7,
  };
}

/** Measures `gray` inside the oval's box (`oval`, in the image's pixels) and around it. */
export function analyzeSelfie(gray: GrayImage, oval: Rect, thresholds: SelfieThresholds = SELFIE_THRESHOLDS): SelfieAnalysis {
  const inside = lumaStats(gray, innerRect(oval));
  const whole = lumaStats(gray, null);
  // Around = the whole picture without the inner box (counts and sums, so no second pass is needed).
  const aroundCount = whole.count - inside.count;
  const aroundMean = aroundCount > 0 ? (whole.mean * whole.count - inside.mean * inside.count) / aroundCount : inside.mean;
  const meanLuma = inside.mean;
  const contrast = Math.sqrt(Math.max(0, inside.variance));
  const backlight = aroundMean - meanLuma;
  let hint: SelfieHint | null = null;
  if (meanLuma < thresholds.minMeanLuma) hint = "too_dark";
  else if (meanLuma > thresholds.maxMeanLuma) hint = "too_bright";
  else if (backlight > thresholds.maxBacklight) hint = "backlit";
  else if (contrast < thresholds.minContrast) hint = "no_face";
  return { meanLuma, contrast, backlight, hint };
}

// Public types of the on-device capture quality engine. Pure data, no DOM.

/** 8-bit grayscale image, row-major. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Axis-aligned rectangle in pixels (x, y = top-left). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Things the rider should fix, in the order they are shown (first = most important). */
export type Hint =
  | "no_document"
  | "move_closer"
  | "move_back"
  | "center_document"
  | "too_dark"
  | "too_bright"
  | "glare"
  | "blurry"
  | "hold_still";

export interface QualityThresholds {
  /** Minimum Laplacian variance on the analysis-size document area. */
  minSharpness: number;
  /** Maximum share of saturated pixels over the whole document area. */
  maxGlareRatio: number;
  /** Maximum share of saturated pixels in any single tile (catches a small hotspot). */
  maxGlareTileRatio: number;
  /** Acceptable mean brightness range (0..255). */
  minMeanLuma: number;
  maxMeanLuma: number;
  /** Detected document must cover at least this share of the guide area. */
  minFraming: number;
  /** Detected document must not exceed the guide by more than this share (too close / cut off). */
  maxOvershoot: number;
  /** Max distance between detected and guide centres, as a share of guide width. */
  maxCenterOffset: number;
  /** Max mean absolute pixel difference between consecutive frames to count as steady. */
  maxMotion: number;
  /** Consecutive good frames needed before auto-capture fires. */
  stableFramesRequired: number;
}

export interface FrameMetrics {
  sharpness: number;
  glareRatio: number;
  glareTileRatio: number;
  meanLuma: number;
  /** Share of the guide area covered by the detected document (0..1+). */
  framing: number;
  /** Detected document box in analysis-image coordinates, or null when none found. */
  documentBox: Rect | null;
  /** 0..1 confidence that documentBox is a real document edge. */
  documentConfidence: number;
  /** Mean absolute difference vs previous frame (0..255), or null for the first frame. */
  motion: number | null;
}

export interface FrameAnalysis {
  metrics: FrameMetrics;
  /** Problems to show, most important first. Empty when the frame is good. */
  hints: Hint[];
  ok: boolean;
}

export type AutoCaptureDecision = "wait" | "capture";

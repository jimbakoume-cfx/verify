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

/**
 * Pass/fail limits used by {@link analyzeFrame}. Start from `DEFAULT_THRESHOLDS` and override
 * single values: `{ ...DEFAULT_THRESHOLDS, minSharpness: 8 }`.
 */
export interface QualityThresholds {
  /**
   * Minimum `focus` (see {@link FrameMetrics.focus}): the fine detail of the analysis-size
   * document area, after removing sensor noise and normalising for contrast.
   */
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
  /**
   * Detected document must not exceed the guide by more than this share (too close / cut off),
   * measured per side as a share of the guide's width (left/right) or height (top/bottom).
   */
  maxOvershoot: number;
  /** Max distance between detected and guide centres, as a share of guide width. */
  maxCenterOffset: number;
  /** Max tilt of the card, in degrees either way, before asking to straighten it (`center_document`). */
  maxTiltDeg: number;
  /**
   * Max mean absolute pixel difference between consecutive frames to count as steady,
   * after removing the part that sensor noise alone explains.
   */
  maxMotion: number;
  /** Consecutive good frames needed before auto-capture fires. */
  stableFramesRequired: number;
  /** Minimum detection confidence (0..1) for a box to count as a document. */
  minDocumentConfidence: number;
}

export interface FrameMetrics {
  /** Variance of the Laplacian inside the document area (raw, includes sensor noise). */
  sharpness: number;
  /**
   * Estimated sensor noise (standard deviation, 0..255 levels) inside the document area, assuming
   * pixel-independent grain (it reads low for the correlated grain of real previews). Used to
   * measure `contrast`, and as a floor for the steadiness check's noise allowance.
   */
  noise: number;
  /** Standard deviation of brightness inside the document area, noise removed (0..255 levels). */
  contrast: number;
  /**
   * The value the blur check compares with `minSharpness`: the detail of the document area
   * smoothed by sigma 1 px, minus the part a noise-like response explains (see `laplacianDetail`),
   * rescaled as if the document had a standard contrast. Dim but sharp frames therefore are not
   * mistaken for blurry ones, and camera grain, white or correlated, cannot make a blurry frame
   * look sharp.
   */
  focus: number;
  glareRatio: number;
  glareTileRatio: number;
  meanLuma: number;
  /** Share of the guide area covered by the detected document (0..1+). */
  framing: number;
  /** Area of the detected box divided by the guide area (size only, ignores position); 0 without a box. */
  coverage: number;
  /** Distance between the box and guide centres, as a share of guide width; 0 without a box. */
  centerOffset: number;
  /**
   * How far the card sticks out of the guide on its worst side, as a share of the guide's width
   * (left/right) or height (top/bottom); 0 when it is inside the guide or there is no box.
   * Measured on the card's corners (`documentExtent`), so a tilted card's corners count.
   */
  overshoot: number;
  /**
   * Detected document box in analysis-image coordinates, or null when none was found with at
   * least `minDocumentConfidence`.
   */
  documentBox: Rect | null;
  /** 0..1 confidence that the best candidate box is a real document edge (reported even when too low). */
  documentConfidence: number;
  /** Clockwise tilt of the detected document, degrees; 0 without a box. */
  documentAngle: number;
  /** Bounds of the detected document's corners in analysis-image coordinates; null without a box. */
  documentExtent: Rect | null;
  /** Mean absolute difference vs previous frame (0..255), or null for the first frame. */
  motion: number | null;
}

/** Result of {@link detectDocumentBox}. */
export interface DocumentDetection {
  /** Best rectangle found in image coordinates, or null when no edge pair exists at all. */
  box: Rect | null;
  /** 0..1. Low values mean the box is probably texture or background, not a card. */
  confidence: number;
  /** "light": card brighter than its background; "dark": darker; null without a box. */
  polarity: "light" | "dark" | null;
  /**
   * Clockwise tilt of the card in degrees (median of its four edges, measured up to about 12
   * degrees either way); 0 without a box.
   */
  angle: number;
  /**
   * Axis-aligned bounds of the card's four corners, where its edge lines meet. Larger than `box`
   * (which joins the edges' midpoints) when the card is tilted or seen at an angle; null without
   * a box.
   */
  extent: Rect | null;
}

export interface FrameAnalysis {
  metrics: FrameMetrics;
  /** Problems to show, most important first. Empty when the frame is good. */
  hints: Hint[];
  ok: boolean;
}

export type AutoCaptureDecision = "wait" | "capture";

/** Result of {@link glare}. */
export interface GlareMeasure {
  /** Share of saturated pixels (luma >= 250) in the whole region, 0..1. */
  ratio: number;
  /** Highest share of saturated pixels in any one tile of the region, 0..1. */
  maxTileRatio: number;
}

/** Brightness statistics of a region (see {@link lumaStats}). */
export interface LumaStats {
  /** Mean luma, 0..255. */
  mean: number;
  /** Variance of luma (levels squared). */
  variance: number;
  /** Number of pixels measured. */
  count: number;
}

/** Pixel size of the uploaded image (see {@link outputSize}). */
export interface OutputSize {
  width: number;
  height: number;
  /** Output pixels per crop pixel (1 when the crop is already small enough; never above 1). */
  scale: number;
}

/** Result of {@link compressToTarget}. */
export interface CompressionResult<B> {
  /** The chosen encoding. */
  blob: B;
  /** JPEG quality it was encoded with (0..1). */
  quality: number;
  /** Extra downscale applied on top of {@link outputSize} (1 or less). */
  scale: number;
  /** How many encodings were tried, including the chosen one. */
  attempts: number;
}

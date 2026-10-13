// @verify/capture: on-device ID capture quality engine (pure TypeScript, no DOM, worker-safe).
// See README.md for what each check means and how the thresholds were chosen.
export type {
  AutoCaptureDecision,
  CompressionResult,
  DocumentDetection,
  FrameAnalysis,
  FrameMetrics,
  GlareMeasure,
  GrayImage,
  Hint,
  LumaStats,
  OutputSize,
  QualityThresholds,
  Rect,
} from "./types";
export { toGray } from "./gray";
export {
  LAPLACIAN_NOISE_GAIN,
  SATURATED_LUMA,
  estimateNoise,
  frameMotion,
  glare,
  laplacianDetail,
  laplacianVariance,
  lumaStats,
  meanLuma,
  temporalNoise,
} from "./metrics";
export { DETECTION_SEARCH_EXPANSION, detectDocumentBox } from "./detect";
export { FOCUS_REFERENCE_CONTRAST, HINT_PRIORITY, analyzeFrame } from "./analyze";
export { DEFAULT_THRESHOLDS } from "./thresholds";
export { AutoCapture } from "./autoCapture";
export { FrameAnalyzer, toClientQuality } from "./frameAnalyzer";
export type { CaptureContext, FrameStep, RgbaFrame } from "./frameAnalyzer";
export {
  ANALYSIS_CROP_EXPANSION,
  ANALYSIS_WIDTH,
  STILL_CROP_EXPANSION,
  analysisCrop,
  analysisRectToSource,
  clampRect,
  expandRect,
  guideInStill,
  guideRect,
  intersectRect,
  mapSourceRectToView,
  mapViewRectToSource,
  rectArea,
  rectCenter,
  scaleRect,
  translateRect,
} from "./geometry";
export type { AnalysisCrop } from "./geometry";
export {
  COMPRESSION_QUALITIES,
  COMPRESSION_SCALES,
  compressToTarget,
  compressionScales,
  outputSize,
} from "./compress";
export type { CompressionOptions } from "./compress";

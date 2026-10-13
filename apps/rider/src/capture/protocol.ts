// Messages between the capture screen and analyzer.worker.ts. Types only.
import type { AutoCaptureDecision, FrameMetrics, Hint, QualityThresholds, Rect } from "@verify/capture";

export type ToWorker =
  | { type: "configure"; thresholds: Partial<QualityThresholds> }
  | { type: "frame"; id: number; width: number; height: number; buffer: ArrayBuffer; guide: Rect }
  | { type: "reset" };

export interface AnalysisResult {
  hints: Hint[];
  ok: boolean;
  metrics: FrameMetrics;
  decision: AutoCaptureDecision;
  /** 0..1 progress towards auto-capture. */
  progress: number;
  /** Time the analysis itself took. */
  ms: number;
}

export type FromWorker =
  | ({ type: "result"; id: number } & AnalysisResult)
  | { type: "error"; id: number };

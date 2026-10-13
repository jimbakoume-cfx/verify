import type { AutoCaptureDecision, FrameAnalysis } from "./types";
import { DEFAULT_THRESHOLDS } from "./thresholds";

/**
 * Decides when to take the photo by itself: after `required` good frames in a row.
 * It fires once, then stays quiet until {@link AutoCapture.reset} (e.g. after "Retake").
 *
 * @example
 * const auto = new AutoCapture();
 * // in the analysis loop:
 * if (auto.push(analysis) === "capture") takeStill();
 */
export class AutoCapture {
  /** Good frames in a row needed before firing. */
  readonly required: number;
  #streak = 0;
  #fired = false;

  constructor(required: number = DEFAULT_THRESHOLDS.stableFramesRequired) {
    if (!Number.isInteger(required) || required < 1) {
      throw new RangeError(`required must be a positive integer, got ${required}`);
    }
    this.required = required;
  }

  /** Feeds one frame's analysis. Returns "capture" exactly once, on the frame that completes the run. */
  push(analysis: Pick<FrameAnalysis, "ok">): AutoCaptureDecision {
    if (this.#fired) return "wait";
    this.#streak = analysis.ok ? this.#streak + 1 : 0;
    if (this.#streak < this.required) return "wait";
    this.#fired = true;
    return "capture";
  }

  /** Forgets the current run and allows firing again. */
  reset(): void {
    this.#streak = 0;
    this.#fired = false;
  }

  /** 0..1 progress towards the next capture (1 once fired), e.g. to fill a ring around the guide. */
  get progress(): number {
    return this.#fired ? 1 : this.#streak / this.required;
  }

  /** True after "capture" was returned and before the next reset. */
  get fired(): boolean {
    return this.#fired;
  }
}

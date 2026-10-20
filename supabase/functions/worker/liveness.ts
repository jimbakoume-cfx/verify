// The liveness_capture check (M5): whether a face check's frames arrived complete and with plausible
// timings. Pure, so it can be tested with tables. No model and no pixels: nothing here judges whether
// the rider really did the actions (M6 plugs its evaluation in beside this check). The `flow` Edge
// Function decides it as it records the frames; it lives with the worker's other decisions because
// M6's evaluation will run there.
import {
  type LivenessAction,
  type LivenessCaptureDetails,
  LIVENESS_LIMITS,
  LIVENESS_PROBLEMS,
  type LivenessProblem,
} from "../_shared/contract.ts";

export const LIVENESS_CHECK_VERSION = "liveness-capture-v1";

/** Each action needs at least this long: a capture that is shorter was not done by a person following prompts. */
export const MIN_ACTION_MS = 1_000;
/** Phone and server clocks, and the request's travel time, may disagree by this much. */
export const CLOCK_TOLERANCE_MS = 2_000;
/** A longer pause between two frames (or before the first one) is suspicious: the phone stalled, or frames were assembled. */
export const MAX_GAP_MS = 4_000;

export interface LivenessFrameInput {
  index: number;
  step: number;
  atMs: number;
  sha256: string;
}

export interface LivenessAssessmentInput {
  challengeId: string;
  actions: readonly LivenessAction[];
  code: string;
  /** In index order, 0..n-1 (the flow function's validation guarantees it). */
  frames: readonly LivenessFrameInput[];
  /** When each step started, in ms from the start of the capture (step 0 first). */
  stepStartsMs: readonly number[];
  /** Time on the server from the challenge's issue to the frames' arrival. */
  serverElapsedMs: number;
  /** A frame's file was already sent in another verification (same SHA-256). */
  reusedElsewhere: boolean;
  startedWithWarning: boolean;
}

export interface LivenessAssessment {
  outcome: "pass" | "flag";
  details: LivenessCaptureDetails;
}

/**
 * "pass": the frames are complete and their timings plausible (still not evaluated: see `evaluated`).
 * "flag": something about them needs a person's eye; `problems` says what, in the contract's order.
 */
export function assessLivenessCapture(input: LivenessAssessmentInput): LivenessAssessment {
  const { frames, actions, stepStartsMs } = input;
  const problems = new Set<LivenessProblem>();

  const framesPerStep = Array.from({ length: actions.length + 1 }, () => 0);
  for (const frame of frames) {
    if (frame.step >= 0 && frame.step < framesPerStep.length) framesPerStep[frame.step]++;
  }
  if (framesPerStep[0] < 1 || framesPerStep.slice(1).some((n) => n < LIVENESS_LIMITS.minFramesPerAction)) {
    problems.add("step_missing_frames");
  }

  let maxGapMs = frames.length > 0 ? Math.max(0, frames[0].atMs) : 0;
  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1];
    const frame = frames[i];
    if (frame.atMs <= previous.atMs || frame.step < previous.step) problems.add("out_of_order");
    maxGapMs = Math.max(maxGapMs, frame.atMs - previous.atMs);
  }
  for (let i = 1; i < stepStartsMs.length; i++) {
    if (stepStartsMs[i] < stepStartsMs[i - 1]) problems.add("out_of_order");
  }
  // A frame taken before its step began, or after the next step began, does not belong to it.
  for (const frame of frames) {
    const start = stepStartsMs[frame.step];
    const next = stepStartsMs[frame.step + 1];
    if (start === undefined || frame.atMs < start || (next !== undefined && frame.atMs >= next)) {
      problems.add("out_of_order");
    }
  }
  if (maxGapMs > MAX_GAP_MS) problems.add("gap_too_long");

  const durationMs = frames.length > 0 ? frames[frames.length - 1].atMs : 0;
  if (durationMs < actions.length * MIN_ACTION_MS) problems.add("too_fast");
  if (durationMs > input.serverElapsedMs + CLOCK_TOLERANCE_MS) problems.add("longer_than_challenge");

  if (new Set(frames.map((frame) => frame.sha256)).size < frames.length) problems.add("duplicate_frames");
  if (input.reusedElsewhere) problems.add("frames_reused");

  const ordered = LIVENESS_PROBLEMS.filter((problem) => problems.has(problem));
  return {
    outcome: ordered.length === 0 ? "pass" : "flag",
    // Built key by key: only the contract's keys reach check_result (the database refuses any other).
    details: {
      evaluated: false,
      challengeId: input.challengeId,
      actions: [...actions],
      code: input.code,
      frames: frames.length,
      framesPerStep,
      durationMs: Math.round(durationMs),
      serverElapsedMs: Math.max(0, Math.round(input.serverElapsedMs)),
      maxGapMs: Math.round(maxGapMs),
      startedWithWarning: input.startedWithWarning,
      problems: ordered,
    },
  };
}

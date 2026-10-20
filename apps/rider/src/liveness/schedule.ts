// When the face check takes its frames, and how small they must be. Pure: the screen runs it with
// real timers, the tests with numbers.
import { LIVENESS_LIMITS } from "@verify/shared";

export const LIVENESS_TIMING = {
  /** "Look at the camera" before the first action. */
  neutralMs: 1_500,
  /** The one frame of step 0, once the rider has settled. */
  neutralFrameAtMs: 900,
  /** Each action's prompt stays this long. */
  actionMs: 3_000,
  /** Frames taken during each action, evenly spread (at 0.6, 1.2, 1.8 and 2.4 s). */
  framesPerAction: 4,
  /** Long side of each frame, in pixels: enough for a face, light on slow networks. */
  frameLongSide: 480,
} as const;

export interface PlannedFrame {
  /** Milliseconds from the start of the capture (step 0). */
  atMs: number;
  /** 0: before the first action; n: during action n. */
  step: number;
}

export interface FrameSchedule {
  frames: PlannedFrame[];
  /** When each step starts: step 0 first, at 0. */
  stepStartsMs: number[];
  /** When the capture ends. */
  totalMs: number;
}

/** The plan for `actions` actions: 1 + 4 per action frames (13 for 3 actions). */
export function frameSchedule(actions: number, timing = LIVENESS_TIMING): FrameSchedule {
  const stepStartsMs = [0];
  const frames: PlannedFrame[] = [{ atMs: timing.neutralFrameAtMs, step: 0 }];
  for (let step = 1; step <= actions; step++) {
    const start = timing.neutralMs + (step - 1) * timing.actionMs;
    stepStartsMs.push(start);
    for (let k = 1; k <= timing.framesPerAction; k++) {
      frames.push({ atMs: start + Math.round((k * timing.actionMs) / (timing.framesPerAction + 1)), step });
    }
  }
  return { frames, stepStartsMs, totalMs: timing.neutralMs + actions * timing.actionMs };
}

/** Bytes each frame should stay under so that all of them fit the server's limits, with room to spare. */
export function frameByteTarget(frameCount: number): number {
  const share = Math.floor((LIVENESS_LIMITS.maxTotalBytes * 0.9) / Math.max(1, frameCount));
  return Math.min(40_000, share, LIVENESS_LIMITS.maxFrameBytes);
}

/** The step running at `elapsedMs` from the start (the last one once the capture is over). */
export function stepAt(schedule: FrameSchedule, elapsedMs: number): number {
  let step = 0;
  schedule.stepStartsMs.forEach((start, i) => {
    if (elapsedMs >= start) step = i;
  });
  return step;
}

import { describe, expect, it } from "vitest";
import { LIVENESS_PROBLEMS } from "../_shared/contract.ts";
import {
  assessLivenessCapture,
  CLOCK_TOLERANCE_MS,
  type LivenessAssessmentInput,
  type LivenessFrameInput,
  MAX_GAP_MS,
} from "./liveness.ts";

const STARTS = [0, 1500, 4500, 7500];

/** The app's schedule: 1 frame before the first action, then 4 during each 3-second action. */
function schedule(): LivenessFrameInput[] {
  const frames: LivenessFrameInput[] = [{ index: 0, step: 0, atMs: 900, sha256: "h0" }];
  for (let step = 1; step <= 3; step++) {
    for (let k = 1; k <= 4; k++) {
      const index = frames.length;
      frames.push({ index, step, atMs: STARTS[step] + k * 600, sha256: `h${index}` });
    }
  }
  return frames;
}

function input(overrides: Partial<LivenessAssessmentInput> = {}): LivenessAssessmentInput {
  return {
    challengeId: "0d9f6a8e-1b7c-4c11-9b0e-6f2b8a2f4f10",
    actions: ["blink", "turn_left", "smile"],
    code: "482913",
    frames: schedule(),
    stepStartsMs: STARTS,
    serverElapsedMs: 25_000,
    reusedElsewhere: false,
    startedWithWarning: false,
    ...overrides,
  };
}

describe("assessLivenessCapture", () => {
  it("passes the app's own schedule, with every detail the contract lists and nothing else", () => {
    const { outcome, details } = assessLivenessCapture(input());
    expect(outcome).toBe("pass");
    expect(details).toEqual({
      evaluated: false,
      challengeId: "0d9f6a8e-1b7c-4c11-9b0e-6f2b8a2f4f10",
      actions: ["blink", "turn_left", "smile"],
      code: "482913",
      frames: 13,
      framesPerStep: [1, 4, 4, 4],
      durationMs: 9_900,
      serverElapsedMs: 25_000,
      maxGapMs: 1_200,
      startedWithWarning: false,
      problems: [],
    });
  });

  it("keeps startedWithWarning as information only", () => {
    const { outcome, details } = assessLivenessCapture(input({ startedWithWarning: true }));
    expect(outcome).toBe("pass");
    expect(details.startedWithWarning).toBe(true);
  });

  const squeeze = (factor: number) =>
    input({
      frames: schedule().map((f) => ({ ...f, atMs: Math.round(f.atMs * factor) })),
      stepStartsMs: STARTS.map((ms) => Math.round(ms * factor)),
      serverElapsedMs: 60_000,
    });

  it.each<[string, LivenessAssessmentInput, string[]]>([
    ["shorter than 1 s per action", squeeze(0.25), ["too_fast"]],
    ["more time than has passed since the challenge", input({ serverElapsedMs: 9_900 - CLOCK_TOLERANCE_MS - 1 }), [
      "longer_than_challenge",
    ]],
    ["a long pause", squeeze(MAX_GAP_MS / 1_000), ["gap_too_long"]],
    [
      "times that go backwards",
      input({ frames: schedule().map((f) => (f.index === 6 ? { ...f, atMs: 3_000 } : f)) }),
      ["out_of_order"],
    ],
    [
      "a frame taken before its step began",
      input({ frames: schedule().map((f) => (f.index === 4 ? { ...f, step: 2 } : f)) }),
      ["out_of_order"],
    ],
    ["step starts that go backwards", input({ stepStartsMs: [0, 4500, 1500, 7500] }), ["out_of_order"]],
    [
      "an action with a single frame",
      input({ frames: schedule().filter((f) => f.step !== 3 || f.index === 9).map((f, i) => ({ ...f, index: i })) }),
      ["step_missing_frames"],
    ],
    ["two identical files", input({ frames: schedule().map((f) => (f.index === 7 ? { ...f, sha256: "h6" } : f)) }), [
      "duplicate_frames",
    ]],
    ["a file seen in another verification", input({ reusedElsewhere: true }), ["frames_reused"]],
  ])("flags %s", (_label, given, problems) => {
    const { outcome, details } = assessLivenessCapture(given);
    expect(outcome).toBe("flag");
    expect(details.problems).toEqual(problems);
  });

  it("lists several problems in the contract's order", () => {
    const { details } = assessLivenessCapture(input({
      reusedElsewhere: true,
      frames: schedule().map((f) => ({ ...f, sha256: "same" })),
      serverElapsedMs: 0,
    }));
    expect(details.problems).toEqual(["longer_than_challenge", "duplicate_frames", "frames_reused"]);
    expect(LIVENESS_PROBLEMS.filter((p) => details.problems.includes(p))).toEqual(details.problems);
  });

  it("rounds timings and never reports a negative server time", () => {
    const { details } = assessLivenessCapture(input({ serverElapsedMs: -5.4 }));
    expect(details.serverElapsedMs).toBe(0);
  });
});

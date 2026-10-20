import { describe, expect, it } from "vitest";
import {
  FACE_MATCH_DETAIL_KEYS,
  FACE_MATCH_PROBLEMS,
  type FaceFrameMeasure,
  type FaceMatchEvidence,
  LIVENESS_EVAL_DETAIL_KEYS,
  LIVENESS_EVAL_PROBLEMS,
  LIVENESS_BASELINE_KEYS,
  LIVENESS_FRAME_METRIC_KEYS,
  PROVISIONAL_LIVENESS_PROBLEMS,
} from "../_shared/contract.ts";
import {
  ACTION_LAG_FRAMES,
  baselineOf,
  BLINK_MIN_SCORE,
  consistencyProblems,
  decideFaceMatch,
  decideLiveness,
  FACE_MATCH_LOW_THRESHOLD,
  FACE_MATCH_MIN_PORTRAIT_EYES,
  FACE_MATCH_MODEL,
  FACE_MATCH_THRESHOLD,
  flatPlane,
  judgeAction,
  LOOK_UP_MIN_DEG,
  passiveCues,
  SMILE_MIN_SCORE,
  TURN_LEFT_YAW_SIGN,
  TURN_MIN_DEG,
} from "./decide.ts";

/** A frame with one face, looking straight, eyes open, not smiling, with clean passive cues. */
function frame(index: number, overrides: Partial<FaceFrameMeasure> = {}): FaceFrameMeasure {
  return {
    index,
    faces: 1,
    yaw: 0,
    pitch: 0,
    roll: 0,
    blink: 0.05,
    eyeOpenness: 0.3,
    smile: 0.05,
    mouthWidth: 0.57,
    faceSize: 0.2,
    centerX: 0.5,
    centerY: 0.45,
    planarResidual: index === 0 ? 0 : 0.008,
    shapeDistance: index === 0 ? 0 : 0.015,
    moire: 0.4,
    glare: 0,
    detail: 0.02,
    ...overrides,
  };
}

const noFace = (index: number): FaceFrameMeasure => ({
  index,
  faces: 0,
  yaw: null,
  pitch: null,
  roll: null,
  blink: null,
  eyeOpenness: null,
  smile: null,
  mouthWidth: null,
  faceSize: null,
  centerX: null,
  centerY: null,
  planarResidual: null,
  shapeDistance: null,
  moire: null,
  glare: null,
  detail: null,
});

const LEFT = TURN_LEFT_YAW_SIGN * 24; // the yaw of a rider turned to their own left
const REFERENCE = frame(0);
const NEUTRAL = baselineOf(REFERENCE);

describe("judgeAction", () => {
  it.each([
    ["turn_left", [frame(1, { yaw: LEFT / 2 }), frame(2, { yaw: LEFT })], "pass", null],
    ["turn_left", [frame(1, { yaw: -LEFT })], "fail", "wrong_direction"],
    ["turn_left", [frame(1, { yaw: TURN_LEFT_YAW_SIGN * (TURN_MIN_DEG - 1) })], "fail", "action_not_done"],
    ["turn_right", [frame(1, { yaw: -LEFT })], "pass", null],
    ["turn_right", [frame(1, { yaw: LEFT })], "fail", "wrong_direction"],
    ["look_up", [frame(1, { pitch: LOOK_UP_MIN_DEG + 2 })], "pass", null],
    ["look_up", [frame(1, { pitch: -(LOOK_UP_MIN_DEG + 2) })], "fail", "wrong_direction"],
    ["look_up", [frame(1, { pitch: 3 })], "fail", "action_not_done"],
    ["blink", [frame(1), frame(2, { blink: BLINK_MIN_SCORE + 0.1 })], "pass", null],
    // The blendshape misses a blink the eye aspect ratio sees (as on the drawn test face).
    ["blink", [frame(1, { blink: 0.4, eyeOpenness: 0.1 })], "pass", null],
    ["blink", [frame(1, { blink: 0.2, eyeOpenness: 0.28 })], "fail", "action_not_done"],
    ["smile", [frame(1, { smile: SMILE_MIN_SCORE + 0.2 })], "pass", null],
    // A closed-lip smile: a low score, but the mouth 14% wider than in the reference frame.
    ["smile", [frame(1, { smile: 0.4, mouthWidth: 0.65 })], "pass", null],
    ["smile", [frame(1, { smile: 0.3, mouthWidth: 0.58 })], "fail", "action_not_done"],
    ["turn_left", [noFace(1), frame(2, { faces: 2, yaw: LEFT })], "unclear", "action_unclear"],
    ["turn_left", [], "unclear", "action_unclear"],
  ] as const)("%s on %j: %s", (action, frames, result, problem) => {
    const judged = judgeAction(action, frames, NEUTRAL);
    expect(judged.details.result).toBe(result);
    expect(judged.problem).toBe(problem);
    expect(judged.details.action).toBe(action);
  });

  it("measures turns from the rider's neutral, not from zero", () => {
    // The rider already faced the camera a little to the left: the turn must go further.
    const neutral = baselineOf(frame(0, { yaw: LEFT / 2 }));
    expect(judgeAction("turn_left", [frame(1, { yaw: LEFT / 2 + TURN_MIN_DEG - 1 })], neutral).details.result).toBe("fail");
    expect(judgeAction("turn_left", [frame(1, { yaw: LEFT / 2 + TURN_MIN_DEG })], neutral).details.result).toBe("pass");
  });

  it("judges a smile or a blink by the mesh only on frames facing the camera (a turn narrows the mouth against the eyes)", () => {
    expect(judgeAction("smile", [frame(1, { yaw: 35, smile: 0.05, mouthWidth: 0.7 })], NEUTRAL).details.result).toBe("fail");
    expect(judgeAction("blink", [frame(1, { yaw: 35, blink: 0.1, eyeOpenness: 0.1 })], NEUTRAL).details.result).toBe("fail");
  });

  it("wrong_direction only from the frames it is given for that (its own step)", () => {
    const window = [frame(1, { yaw: 0 }), frame(2, { yaw: -LEFT })];
    expect(judgeAction("turn_left", window, NEUTRAL).problem).toBe("wrong_direction");
    expect(judgeAction("turn_left", window, NEUTRAL, [window[0]]).problem).toBe("action_not_done");
  });

  it("reports the peak in the asked direction, rounded, and the frames with one face", () => {
    const judged = judgeAction("turn_right", [frame(1, { yaw: -20.12345 }), frame(2, { faces: 2, yaw: -40 }), noFace(3)], NEUTRAL);
    expect(judged.details).toEqual({ action: "turn_right", result: "pass", framesWithFace: 1, peak: 20.123 });
  });

  it("a smile needs to rise from the reference: a rider smiling throughout does not pass", () => {
    const neutral = baselineOf(frame(0, { smile: 0.6 }));
    expect(judgeAction("smile", [frame(1, { smile: 0.7 })], neutral).details.result).toBe("fail");
  });
});

describe("flatPlane", () => {
  it("not measured when no frame turned or tilted enough", () => {
    expect(flatPlane([REFERENCE, frame(1, { yaw: 5, planarResidual: 0.001 })], REFERENCE)).toEqual({ result: "not_measured", score: null });
  });

  it("depth: a real head turning shows parallax (canonical face at 20°: about 0.06)", () => {
    const frames = [REFERENCE, frame(1, { yaw: 20, planarResidual: 0.061 }), frame(2, { yaw: -18, planarResidual: 0.055 })];
    expect(flatPlane(frames, REFERENCE)).toEqual({ result: "depth", score: 0.058 });
  });

  it("flat: the face moved as one plane (a photo or a screen bent or tilted)", () => {
    const frames = [REFERENCE, frame(1, { pitch: 12, planarResidual: 0.004 }), frame(2, { yaw: 16, planarResidual: 0.006 })];
    expect(flatPlane(frames, REFERENCE).result).toBe("flat");
  });

  it("never measured without a reference", () => {
    expect(flatPlane([frame(1, { yaw: 20, planarResidual: 0.001 })], null).result).toBe("not_measured");
  });
});

describe("consistencyProblems", () => {
  it("nothing for a steady single face", () => {
    expect(consistencyProblems([REFERENCE, frame(1), frame(2)], REFERENCE)).toEqual([]);
  });

  it("missing and extra faces", () => {
    expect(consistencyProblems([REFERENCE, noFace(1), frame(2, { faces: 2 })], REFERENCE)).toEqual(["face_missing", "multiple_faces"]);
  });

  it("a cut: the face jumps across the frame, or changes size at once", () => {
    expect(consistencyProblems([REFERENCE, frame(1, { centerX: 0.85 })], REFERENCE)).toEqual(["face_jump"]);
    expect(consistencyProblems([REFERENCE, frame(1, { faceSize: 0.35 })], REFERENCE)).toEqual(["face_jump"]);
    // A frame without a face in between does not hide the jump.
    expect(consistencyProblems([REFERENCE, noFace(1), frame(2, { centerX: 0.1 })], REFERENCE)).toContain("face_jump");
  });

  it("another face's shape, judged only near the reference pose", () => {
    expect(consistencyProblems([REFERENCE, frame(1, { shapeDistance: 0.09 })], REFERENCE)).toEqual(["shape_change"]);
    // Turned far, the model's own error grows: not judged.
    expect(consistencyProblems([REFERENCE, frame(1, { yaw: 30, shapeDistance: 0.09 })], REFERENCE)).toEqual([]);
  });
});

describe("passiveCues (provisional)", () => {
  it("each on the median over the frames with a face, so one odd frame does not count", () => {
    expect(passiveCues([REFERENCE, frame(1, { moire: 1.7 }), frame(2)])).toEqual([]);
    expect(passiveCues([frame(0, { moire: 1.7 }), frame(1, { moire: 1.6 }), frame(2)])).toEqual(["moire"]);
    expect(passiveCues([frame(0, { glare: 0.06 }), frame(1, { glare: 0.07 })])).toEqual(["screen_glare"]);
    expect(passiveCues([frame(0, { detail: 0.001 }), frame(1, { detail: 0.0015 })])).toEqual(["low_detail"]);
  });

  it("are all marked provisional in the contract", () => {
    for (const cue of ["moire", "screen_glare", "low_detail", "flat_plane", "shape_change"] as const) {
      expect(PROVISIONAL_LIVENESS_PROBLEMS).toContain(cue);
    }
  });
});

describe("decideLiveness", () => {
  const actions = ["turn_left", "blink", "smile"] as const;
  // The app's schedule: 1 frame before the actions, then 4 per action.
  const steps = Array.from({ length: 13 }, (_, i) => ({ index: i, step: i === 0 ? 0 : Math.floor((i - 1) / 4) + 1 }));
  const context = { challengeId: "c0ffee00-0000-4000-8000-000000000001", actions, frames: steps, engine: "face-1/test", timing: { ms: 900, cold: false } };

  function done(): FaceFrameMeasure[] {
    return steps.map(({ index, step }) => {
      if (step === 1) return frame(index, { yaw: index === 2 ? LEFT : LEFT / 3, planarResidual: index === 2 ? 0.06 : 0.01 });
      if (step === 2) return frame(index, index === 6 ? { blink: 0.8, eyeOpenness: 0.08 } : {});
      if (step === 3) return frame(index, index >= 11 ? { smile: 0.8, mouthWidth: 0.68 } : {});
      return frame(index);
    });
  }

  it("pass: every action in its own step, depth seen, nothing else", () => {
    const decision = decideLiveness({ referenceIndex: 0, frames: done() }, context);
    expect(decision.outcome).toBe("pass");
    expect(decision.score).toBe(1);
    expect(decision.details).toEqual({
      evaluated: true,
      provisional: true,
      challengeId: context.challengeId,
      engine: "face-1/test",
      actions: [
        { action: "turn_left", result: "pass", framesWithFace: 6, peak: 24 },
        { action: "blink", result: "pass", framesWithFace: 6, peak: 0.8 },
        { action: "smile", result: "pass", framesWithFace: 4, peak: 0.8 },
      ],
      frames: 13,
      framesWithFace: 13,
      flatPlane: "depth",
      flatPlaneScore: 0.06,
      problems: [],
      timing: { ms: 900, cold: false },
      metrics: decision.details.metrics,
    });
    expect(Object.keys(decision.details)).toEqual([...LIVENESS_EVAL_DETAIL_KEYS]);
    // Each action's window: its own step, then the first frames of the next one (the rider reacts late).
    expect(decision.details.metrics?.windows).toEqual([[1, 2, 3, 4, 5, 6], [5, 6, 7, 8, 9, 10], [9, 10, 11, 12]]);
    expect(decision.details.metrics?.baseline).toEqual({ yaw: 0, pitch: 0, smile: 0.05, mouthWidth: 0.57, eyeOpenness: 0.3 });
    expect(decision.details.metrics?.frames).toHaveLength(13);
    expect(decision.details.metrics?.frames[2]).toEqual({
      index: 2, step: 1, faces: 1, yaw: 24, pitch: 0, blink: 0.05, eyeOpenness: 0.3, smile: 0.05, mouthWidth: 0.57,
    });
    expect(Object.keys(decision.details.metrics!.frames[0])).toEqual([...LIVENESS_FRAME_METRIC_KEYS]);
  });

  // The PM's first real test (2026-10-20, the PM's own face, a low-end phone): the per-frame measures the
  // worker sent (generic angles and scores only), challenge look_up, turn_left, smile, frames 1 + 4 + 4 + 4.
  // The rider was a step late: the turn asked in step 2 shows in step 3's frames (yaw +35: the sign
  // convention held), and neither the look up nor the smile is in any frame.
  const PM_ACTIONS = ["look_up", "turn_left", "smile"] as const;
  const PM: [number, number, number, number, number][] = [
    // [yaw, pitch, smile, mouthWidth, eyeOpenness]
    [-1.67, -4.79, 0.0046, 0.6118, 0.2712],
    [-1.93, -4.43, 0.0035, 0.6198, 0.279], [-1.96, -3.59, 0.0037, 0.6086, 0.2797], [-2.1, -3.39, 0.0038, 0.6092, 0.2757],
    [-1.93, -3.68, 0.0034, 0.6136, 0.2861],
    [-2.54, -4.86, 0.0014, 0.602, 0.3208], [-2.14, -3.17, 0.0021, 0.6219, 0.2382], [-1.98, -1.7, 0.0035, 0.6164, 0.2666],
    [-2.12, -2.49, 0.0028, 0.6119, 0.256],
    [14.49, 0.73, 0.0036, 0.6169, 0.2744], [34.45, 5.25, 0.0031, 0.6405, 0.2641], [35.23, 5.19, 0.0018, 0.6317, 0.2754],
    [5.22, -3.7, 0.0044, 0.6117, 0.2533],
  ];
  const pmFrames = PM.map(([yaw, pitch, smile, mouthWidth, eyeOpenness], index) =>
    frame(index, { yaw, pitch, smile, mouthWidth, eyeOpenness, blink: 0.12, planarResidual: index === 0 ? 0 : index >= 9 && index <= 11 ? 0.13 : 0.006 })
  );

  it("the PM's first real test: v1 saw no action at all; v2 sees the late turn, and still fails what was never done", () => {
    const decision = decideLiveness({ referenceIndex: 0, frames: pmFrames }, { ...context, actions: PM_ACTIONS });
    expect(decision.details.actions.map((a) => [a.action, a.result])).toEqual([["look_up", "fail"], ["turn_left", "pass"], ["smile", "fail"]]);
    expect(decision.details.actions[1].peak).toBeGreaterThan(30);
    // Never rejects on its own: "fail" is the provisional liveness_flag for M8 (review).
    expect(decision.outcome).toBe("fail");
    expect(decision.details.problems).toEqual(["action_not_done"]);
    expect(decision.details.flatPlane).toBe("depth");
    // The neutral is the rider's own resting pose, not moved by the late turn.
    expect(decision.details.metrics?.baseline.yaw).toBeCloseTo(-1.96, 1);
    expect(decision.details.metrics?.baseline.pitch).toBeLessThan(-3);
  });

  it("the same rider on the v2 schedule (late but complete): every action passes", () => {
    // 1 + 4 + 4 + 5 frames (the app's tail frame); each action done about one frame late.
    const steps14 = Array.from({ length: 14 }, (_, i) => ({ index: i, step: i === 0 ? 0 : Math.min(3, Math.floor((i - 1) / 4) + 1) }));
    const at = (i: number, o: Partial<FaceFrameMeasure>) => frame(i, { yaw: -2, pitch: -4.8, smile: 0.004, mouthWidth: 0.61, eyeOpenness: 0.27, ...o });
    const frames = steps14.map(({ index }) =>
      [2, 3, 4, 5].includes(index) ? at(index, { pitch: 7, planarResidual: 0.05 })
      : [6, 7, 8, 9].includes(index) ? at(index, { yaw: 30, planarResidual: 0.12 })
      : [11, 12, 13].includes(index) ? at(index, { smile: 0.62, mouthWidth: 0.69 })
      : at(index, {})
    );
    const decision = decideLiveness({ referenceIndex: 0, frames }, { ...context, actions: PM_ACTIONS, frames: steps14 });
    expect(decision.details.actions.map((a) => a.result)).toEqual(["pass", "pass", "pass"]);
    expect(decision.outcome).toBe("pass");
  });

  it("frames are the camera's own picture: a rider's left turn is a positive yaw; a mirrored frame would read the other way", () => {
    // The rider app grabs frames from the unmirrored video (only its preview is mirrored): a turn to the
    // rider's own left points the nose to the image's right, a positive yaw (worker-face test_geometry.py
    // checks the same on synthetic landmarks, mirrored and not).
    const turned = (yaw: number) => steps.map(({ index, step }) => frame(index, step === 1 ? { yaw, planarResidual: 0.06 } : step === 2 ? { blink: 0.8 } : step === 3 ? { smile: 0.8 } : {}));
    expect(decideLiveness({ referenceIndex: 0, frames: turned(TURN_LEFT_YAW_SIGN * 25) }, context).outcome).toBe("pass");
    const mirrored = decideLiveness({ referenceIndex: 0, frames: turned(-TURN_LEFT_YAW_SIGN * 25) }, context);
    expect(mirrored.details.problems).toContain("wrong_direction");
  });

  it("an action may still be seen in the first frames of the next step, never later", () => {
    const late = (lag: number) =>
      steps.map(({ index, step }) =>
        index === 4 + lag ? frame(index, { yaw: LEFT, planarResidual: 0.06 }) : frame(index, step === 2 ? { blink: 0.8 } : step === 3 ? { smile: 0.8 } : {})
      );
    expect(decideLiveness({ referenceIndex: 0, frames: late(ACTION_LAG_FRAMES) }, context).details.actions[0].result).toBe("pass");
    expect(decideLiveness({ referenceIndex: 0, frames: late(ACTION_LAG_FRAMES + 1) }, context).details.actions[0].result).toBe("fail");
  });

  it("a turn back after the opposite turn is not a wrong direction", () => {
    const lr = ["turn_left", "turn_right", "smile"] as const;
    const frames = steps.map(({ index, step }) =>
      step === 1 ? frame(index, { yaw: LEFT, planarResidual: 0.06 })
      // The rider is still turned left in the first frames of the turn right, then turns right.
      : step === 2 ? frame(index, { yaw: index <= 6 ? LEFT : -LEFT, planarResidual: 0.06 })
      : step === 3 ? frame(index, { smile: 0.8 }) : frame(index)
    );
    const decision = decideLiveness({ referenceIndex: 0, frames }, { ...context, actions: lr });
    expect(decision.details.actions.map((a) => a.result)).toEqual(["pass", "pass", "pass"]);
  });

  it("fail: the actions in the wrong order (each is judged in its own step)", () => {
    // The rider smiled during the turn step and turned during the smile step.
    const frames = steps.map(({ index, step }) =>
      step === 1 ? frame(index, { smile: 0.8 }) : step === 3 ? frame(index, { yaw: LEFT }) : frame(index, step === 2 ? { blink: 0.9 } : {})
    );
    const decision = decideLiveness({ referenceIndex: 0, frames }, context);
    expect(decision.outcome).toBe("fail");
    expect(decision.details.actions.map((a) => a.result)).toEqual(["fail", "pass", "fail"]);
    expect(decision.details.problems).toContain("action_not_done");
    expect(decision.score).toBe(0.3333);
  });

  it("fail: a printed photo held up does nothing (no turn, no blink, no smile)", () => {
    const frames = steps.map(({ index }) => frame(index, { planarResidual: 0.003 }));
    const decision = decideLiveness({ referenceIndex: 0, frames }, context);
    expect(decision.outcome).toBe("fail");
    expect(decision.details.actions.every((a) => a.result === "fail")).toBe(true);
    expect(decision.details.flatPlane).toBe("not_measured");
  });

  it("flag: everything done but the face moved as a flat plane (provisional)", () => {
    const frames = done().map((m) => (m.index === 0 ? m : { ...m, planarResidual: 0.004 }));
    const decision = decideLiveness({ referenceIndex: 0, frames }, context);
    expect(decision.outcome).toBe("flag");
    expect(decision.details.problems).toEqual(["flat_plane"]);
    expect(decision.details.flatPlane).toBe("flat");
  });

  it("flag: no face in an action's frames, and no reference", () => {
    // No face in the blink's step nor in its late frames (the first two of the smile's step).
    const frames = done().map((m) => (m.index === 0 || (m.index >= 5 && m.index <= 10) ? noFace(m.index) : m));
    const decision = decideLiveness({ referenceIndex: null, frames }, context);
    expect(decision.outcome).toBe("flag");
    expect(decision.details.problems).toEqual(["action_unclear", "no_reference", "face_missing"]);
    expect(decision.details.actions[1]).toEqual({ action: "blink", result: "unclear", framesWithFace: 0, peak: null });
  });

  it("lists problems in the contract's order", () => {
    const frames = done().map((m) => ({ ...m, moire: 1.8, glare: 0.06 }));
    const decision = decideLiveness({ referenceIndex: 0, frames }, context);
    expect(decision.details.problems).toEqual(LIVENESS_EVAL_PROBLEMS.filter((p) => ["moire", "screen_glare"].includes(p)));
  });

  it("ignores measures of frames the database does not know as a step (they count for no action)", () => {
    const decision = decideLiveness({ referenceIndex: 0, frames: done() }, { ...context, frames: steps.slice(0, 5) });
    expect(decision.details.actions.map((a) => a.result)).toEqual(["pass", "unclear", "unclear"]);
  });
});

describe("decideFaceMatch", () => {
  const evidence = (overrides: { similarity?: number | null; portrait?: Partial<FaceMatchEvidence["portrait"]>; selfie?: Partial<FaceMatchEvidence["selfie"]> } = {}): FaceMatchEvidence => ({
    portrait: { found: true, faces: 2, box: [0.1, 0.3, 0.15, 0.2], faceSize: 60, method: "mesh", detectionScore: 0.95, ...overrides.portrait },
    selfie: {
      captureId: "c0ffee00-0000-4000-8000-0000000000f0",
      frameIndex: 0,
      found: true,
      box: [0.3, 0.2, 0.4, 0.35],
      faceSize: 80,
      yaw: 2,
      pitch: -1,
      ...overrides.selfie,
    },
    similarity: overrides.similarity === undefined ? 0.6 : overrides.similarity,
  });
  const context = { documentCaptureId: "c0ffee00-0000-4000-8000-0000000000d0", engine: "face-1/test", timing: { ms: 1500, cold: true } };

  it("the threshold is a named constant, uncalibrated, and every result says so", () => {
    expect(FACE_MATCH_THRESHOLD).toBe(0.35);
    expect(FACE_MATCH_LOW_THRESHOLD).toBeLessThan(FACE_MATCH_THRESHOLD);
    const decision = decideFaceMatch(evidence(), context);
    expect(decision.details.calibrated).toBe(false);
    expect(decision.details.reviewOnly).toBe(true);
    expect(decision.details.threshold).toBe(FACE_MATCH_THRESHOLD);
    expect(decision.details.model).toBe(FACE_MATCH_MODEL);
    expect(Object.keys(decision.details)).toEqual([...FACE_MATCH_DETAIL_KEYS]);
  });

  it.each([
    ["a likely match", evidence({ similarity: 0.6 }), "pass", []],
    ["exactly the threshold", evidence({ similarity: FACE_MATCH_THRESHOLD }), "pass", []],
    ["between the thresholds", evidence({ similarity: 0.25 }), "flag", []],
    ["clearly different", evidence({ similarity: 0.05 }), "fail", []],
    ["no portrait found", evidence({ similarity: null, portrait: { found: false, box: null, faceSize: null, method: null, detectionScore: null } }), "flag", ["portrait_not_found"]],
    ["no selfie frame", evidence({ similarity: null, selfie: { found: false, captureId: null, frameIndex: null, box: null, faceSize: null, yaw: null, pitch: null } }), "flag", ["selfie_not_found"]],
    ["a tiny portrait: a match is only a flag", evidence({ portrait: { faceSize: FACE_MATCH_MIN_PORTRAIT_EYES - 1 } }), "flag", ["portrait_small"]],
    ["aligned without the mesh", evidence({ portrait: { method: "detector" } }), "flag", ["detector_alignment"]],
    ["a turned selfie", evidence({ selfie: { yaw: 30 } }), "flag", ["selfie_not_frontal"]],
    ["a doubtful portrait does not soften a clear mismatch", evidence({ similarity: 0.02, portrait: { method: "detector" } }), "fail", ["detector_alignment"]],
  ] as const)("%s: %s", (_name, ev, outcome, problems) => {
    const decision = decideFaceMatch(ev, context);
    expect(decision.outcome).toBe(outcome);
    expect(decision.details.problems).toEqual(problems);
  });

  it("names the photos the faces came from, never an embedding", () => {
    const decision = decideFaceMatch(evidence(), context);
    expect(decision.details.portrait).toEqual({ captureId: context.documentCaptureId, box: [0.1, 0.3, 0.15, 0.2] });
    expect(decision.details.selfie).toEqual({ captureId: "c0ffee00-0000-4000-8000-0000000000f0", box: [0.3, 0.2, 0.4, 0.35] });
    expect(decision.score).toBe(0.6);
    expect(JSON.stringify(decision.details)).not.toMatch(/embedding/i);
  });
});

// node:fs through a variable, so that type checkers without Node's types (deno check) skip it.
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL, encoding: "utf8"): string };
const sql = readFileSync(new URL("../../migrations/20261022000000_real_test_fixes.sql", import.meta.url), "utf8");

describe("the database refuses any other key or code (supabase/migrations/20261022000000_real_test_fixes.sql)", () => {
  const list = (values: readonly string[]) => `array[${values.map((v) => `'${v}'`).join(", ")}]`;
  const sorted = (values: readonly string[]) => [...values].sort();
  const squash = (text: string) => text.replace(/\s+/g, " ");

  it("the liveness details' keys, sorted as private.face_details_valid compares them", () => {
    expect(squash(sql)).toContain(squash(list(sorted(LIVENESS_EVAL_DETAIL_KEYS))));
    // A result of liveness-eval-v1 (no metrics) stays valid.
    expect(squash(sql)).toContain(squash(list(sorted(LIVENESS_EVAL_DETAIL_KEYS.filter((k) => k !== "metrics")))));
    expect(squash(sql)).toContain(squash(list(sorted(LIVENESS_FRAME_METRIC_KEYS))));
    expect(squash(sql)).toContain(squash(list(sorted(LIVENESS_BASELINE_KEYS))));
  });

  it("the face match details' keys", () => {
    expect(squash(sql)).toContain(squash(list(sorted(FACE_MATCH_DETAIL_KEYS))));
  });

  it("every liveness problem and face match problem code, in the contract's order", () => {
    const codes = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
    expect(squash(sql)).toContain(squash(codes(LIVENESS_EVAL_PROBLEMS)));
    expect(squash(sql)).toContain(squash(codes(FACE_MATCH_PROBLEMS)));
  });
});

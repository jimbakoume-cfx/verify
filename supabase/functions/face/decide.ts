// Decisions of the face checks (M6 liveness, M7 face match), from the face worker's measures. Pure, so
// every rule is tested with tables (decide.test.ts). The worker measures; only this file decides.
//
// Every cut-off below is a FIRST GUESS: none has been measured on real riders, real attacks or
// Cameroonian faces yet. They are named constants so that the calibration (M12, and the volunteer test
// set of PLAN.md §5) changes them in one place; the details say `provisional: true` (liveness) and
// `calibrated: false` (face match) until then.
import {
  FACE_MATCH_PROBLEMS,
  type FaceFrameMeasure,
  type FaceLivenessEvidence,
  type FaceMatchDetails,
  type FaceMatchEvidence,
  type FaceMatchProblem,
  type FlatPlaneResult,
  type LivenessAction,
  type LivenessActionDetails,
  type LivenessDetails,
  LIVENESS_EVAL_PROBLEMS,
  type LivenessEvalProblem,
} from "../_shared/contract.ts";

export const LIVENESS_EVAL_VERSION = "liveness-eval-v1";
export const FACE_MATCH_VERSION = "face-match-v1";
/** The model behind every similarity (stored with each result, so a model change is never mixed up). */
export const FACE_MATCH_MODEL = "auraface-v1/glintr100";

// ---------------------------------------------------------------------------
// Face match (M7)
// ---------------------------------------------------------------------------
/**
 * Cosine similarity at or above which the two faces are taken to be the same person.
 * UNCALIBRATED — must be set on Cameroonian impostor pairs (NIST shows ~14x higher false-match rate
 * for West Africans at fixed thresholds). 0.35 is a common starting point for ArcFace-type models on
 * web photos, nothing more. Until it is calibrated, every face_match result is review-only: the
 * database never lets it approve a case (risk.ts REVIEW_ONLY_CHECKS, private.risk_facts).
 */
export const FACE_MATCH_THRESHOLD = 0.35;
/** Below this the faces are taken to be different people (outcome "fail"). UNCALIBRATED, as above. */
export const FACE_MATCH_LOW_THRESHOLD = 0.15;
/** A portrait whose eyes are closer than this (pixels of the document photo) is too small to trust. */
export const FACE_MATCH_MIN_PORTRAIT_EYES = 24;
/** The chosen selfie frame should face the camera within these angles (degrees). */
export const SELFIE_MAX_YAW = 20;
export const SELFIE_MAX_PITCH = 20;

export interface FaceMatchDecision {
  outcome: "pass" | "flag" | "fail";
  score: number | null;
  details: FaceMatchDetails;
}

/**
 * pass: similarity at or above the threshold with nothing doubtful. fail: under the low threshold.
 * flag: anything else, including no comparison. All three are review-only until calibrated.
 */
export function decideFaceMatch(
  evidence: FaceMatchEvidence,
  context: { documentCaptureId: string; engine: string; timing: { ms: number; cold: boolean } },
): FaceMatchDecision {
  const problems = new Set<FaceMatchProblem>();
  const { portrait, selfie, similarity } = evidence;
  if (!portrait.found) problems.add("portrait_not_found");
  if (!selfie.found) problems.add("selfie_not_found");
  if (portrait.found && portrait.faceSize !== null && portrait.faceSize < FACE_MATCH_MIN_PORTRAIT_EYES) {
    problems.add("portrait_small");
  }
  if (portrait.found && portrait.method === "detector") problems.add("detector_alignment");
  if (
    selfie.found &&
    ((selfie.yaw !== null && Math.abs(selfie.yaw) > SELFIE_MAX_YAW) ||
      (selfie.pitch !== null && Math.abs(selfie.pitch) > SELFIE_MAX_PITCH))
  ) {
    problems.add("selfie_not_frontal");
  }
  const compared = portrait.found && selfie.found && similarity !== null;
  let outcome: FaceMatchDecision["outcome"] = "flag";
  if (compared && similarity! < FACE_MATCH_LOW_THRESHOLD) outcome = "fail";
  else if (compared && similarity! >= FACE_MATCH_THRESHOLD && problems.size === 0) outcome = "pass";

  return {
    outcome,
    score: compared ? round(similarity!, 4) : null,
    details: {
      model: FACE_MATCH_MODEL,
      engine: context.engine,
      similarity: compared ? round(similarity!, 4) : null,
      threshold: FACE_MATCH_THRESHOLD,
      lowThreshold: FACE_MATCH_LOW_THRESHOLD,
      calibrated: false,
      reviewOnly: true,
      problems: FACE_MATCH_PROBLEMS.filter((p) => problems.has(p)),
      portrait: { captureId: context.documentCaptureId, box: portrait.found ? portrait.box : null },
      selfie: { captureId: selfie.found ? selfie.captureId : null, box: selfie.found ? selfie.box : null },
      timing: context.timing,
    },
  };
}

// ---------------------------------------------------------------------------
// Liveness (M6)
// ---------------------------------------------------------------------------
/**
 * Yaw sign of a rider's own "left": the frames are the camera's own picture (not mirrored), so turning
 * to one's left points the nose to the image's right, a positive yaw (contract.ts FaceFrameMeasure).
 */
export const TURN_LEFT_YAW_SIGN = 1;
/** A head turn counts from this many degrees away from the reference frame. */
export const TURN_MIN_DEG = 15;
/** Looking up counts from this many degrees above the reference frame. */
export const LOOK_UP_MIN_DEG = 10;
/** A blink: MediaPipe's eyeBlink score at least this, or the eye aspect ratio down to this share of the reference's. */
export const BLINK_MIN_SCORE = 0.5;
export const BLINK_OPENNESS_RATIO = 0.6;
/**
 * A smile: MediaPipe's mouthSmile score at least this and this much above the reference frame's, or the
 * mouth at least this much wider than in the reference frame (a closed-lip smile scores lower).
 */
export const SMILE_MIN_SCORE = 0.5;
export const SMILE_MIN_RISE = 0.2;
export const SMILE_WIDTH_RATIO = 1.08;
/** The flat-plane test is measured on frames turned or tilted at least this far from the reference. */
export const FLAT_PLANE_MIN_YAW_DEG = 12;
export const FLAT_PLANE_MIN_PITCH_DEG = 8;
/**
 * Median planar residual under this: the face moved as one flat plane (a print or a screen). On the
 * canonical face, a real head turned 12° gives about 0.035 and a flat one stays at the landmark noise
 * (under 0.02 with 1 px of noise on a 100 px face): worker-face/tests/test_geometry.py. PROVISIONAL.
 */
export const FLAT_PLANE_MAX_RESIDUAL = 0.025;
/**
 * 3-D shape distance from the reference above this, on a frame posed close to the reference (the
 * model's own error grows with the turn: about 0.036 at 20° on the drawn test face): possibly another
 * face. PROVISIONAL.
 */
export const SHAPE_CHANGE_MAX = 0.06;
export const SHAPE_POSE_MAX_YAW_DEG = 15;
export const SHAPE_POSE_MAX_PITCH_DEG = 10;
/** Between two consecutive frames with a face: a jump of the face's centre (fraction of the frame), or of its size (ratio). */
export const FACE_JUMP_CENTER = 0.25;
export const FACE_JUMP_SIZE_RATIO = 1.6;
/**
 * Passive cues, on the median over the frames with a face. PROVISIONAL (worker-face/verify_face/spoof.py),
 * set from drawn test faces and simulated attacks only: a pixel grid gives moire 1.5-1.8 against
 * 0.3-0.5 for a camera picture; a blurred "print" detail under 0.002 against 0.01-0.04; a reflection
 * 0.05-0.07 of the face blown out. To be replaced by our own detectors (training/antispoof/).
 */
export const MOIRE_MIN = 1.0;
export const SCREEN_GLARE_MIN = 0.04;
export const LOW_DETAIL_MAX = 0.002;

/** One frame as the database knows it: its index and step (from the job's inputs). */
export interface FrameStep {
  index: number;
  step: number;
}

export interface LivenessDecision {
  outcome: "pass" | "flag" | "fail";
  /** Share of actions seen, 0..1 (check_result.score). */
  score: number;
  details: LivenessDetails;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function round(value: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

const single = (m: FaceFrameMeasure) => m.faces === 1;
const num = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** One action, judged on the frames of its own step against the reference frame. */
export function judgeAction(
  action: LivenessAction,
  stepFrames: readonly FaceFrameMeasure[],
  reference: FaceFrameMeasure | null,
): { details: LivenessActionDetails; problem: LivenessEvalProblem | null } {
  const frames = stepFrames.filter(single);
  const base = (pick: (m: FaceFrameMeasure) => number | null, fallback: number) => {
    const value = reference ? pick(reference) : null;
    return num(value) ? value : fallback;
  };
  const result = (outcome: LivenessActionDetails["result"], peak: number | null, problem: LivenessEvalProblem | null) => ({
    details: { action, result: outcome, framesWithFace: frames.length, peak: peak === null ? null : round(peak, 3) },
    problem,
  });
  if (frames.length === 0) return result("unclear", null, "action_unclear");

  if (action === "turn_left" || action === "turn_right" || action === "look_up") {
    const isTurn = action !== "look_up";
    const sign = action === "turn_left" ? TURN_LEFT_YAW_SIGN : action === "turn_right" ? -TURN_LEFT_YAW_SIGN : 1;
    const minimum = isTurn ? TURN_MIN_DEG : LOOK_UP_MIN_DEG;
    const baseline = base((m) => (isTurn ? m.yaw : m.pitch), 0);
    const moves = frames.map((m) => (isTurn ? m.yaw : m.pitch)).filter(num).map((v) => sign * (v - baseline));
    if (moves.length === 0) return result("unclear", null, "action_unclear");
    const peak = Math.max(...moves);
    if (peak >= minimum) return result("pass", peak, null);
    if (Math.min(...moves) <= -minimum) return result("fail", peak, "wrong_direction");
    return result("fail", peak, "action_not_done");
  }

  if (action === "blink") {
    const scores = frames.map((m) => m.blink).filter(num);
    const openness = frames.map((m) => m.eyeOpenness).filter(num);
    if (scores.length === 0 && openness.length === 0) return result("unclear", null, "action_unclear");
    const peak = scores.length ? Math.max(...scores) : null;
    const reference_openness = reference && num(reference.eyeOpenness) ? reference.eyeOpenness : null;
    const closed = reference_openness !== null && openness.length > 0 &&
      Math.min(...openness) <= BLINK_OPENNESS_RATIO * reference_openness;
    if ((peak !== null && peak >= BLINK_MIN_SCORE) || closed) return result("pass", peak, null);
    return result("fail", peak, "action_not_done");
  }

  // smile
  const scores = frames.map((m) => m.smile).filter(num);
  const widths = frames.map((m) => m.mouthWidth).filter(num);
  if (scores.length === 0 && widths.length === 0) return result("unclear", null, "action_unclear");
  const peak = scores.length ? Math.max(...scores) : null;
  const baseline = base((m) => m.smile, 0);
  const referenceWidth = reference && num(reference.mouthWidth) ? reference.mouthWidth : null;
  const wider = referenceWidth !== null && widths.length > 0 && Math.max(...widths) >= SMILE_WIDTH_RATIO * referenceWidth;
  if ((peak !== null && peak >= SMILE_MIN_SCORE && peak - baseline >= SMILE_MIN_RISE) || wider) return result("pass", peak, null);
  return result("fail", peak, "action_not_done");
}

/** The flat-plane test over every frame that turned or tilted enough from the reference. */
export function flatPlane(
  frames: readonly FaceFrameMeasure[],
  reference: FaceFrameMeasure | null,
): { result: FlatPlaneResult; score: number | null } {
  if (!reference || !num(reference.yaw) || !num(reference.pitch)) return { result: "not_measured", score: null };
  const residuals = frames
    .filter((m) => single(m) && m.index !== reference.index && num(m.planarResidual) && num(m.yaw) && num(m.pitch))
    .filter((m) =>
      Math.abs(m.yaw! - reference.yaw!) >= FLAT_PLANE_MIN_YAW_DEG ||
      Math.abs(m.pitch! - reference.pitch!) >= FLAT_PLANE_MIN_PITCH_DEG
    )
    .map((m) => m.planarResidual!);
  const score = median(residuals);
  if (score === null) return { result: "not_measured", score: null };
  return { result: score < FLAT_PLANE_MAX_RESIDUAL ? "flat" : "depth", score: round(score, 5) };
}

/** Same face throughout, no cut: missing or extra faces, jumps between consecutive frames, shape changes. */
export function consistencyProblems(
  frames: readonly FaceFrameMeasure[],
  reference: FaceFrameMeasure | null,
): LivenessEvalProblem[] {
  const problems: LivenessEvalProblem[] = [];
  if (frames.some((m) => m.faces === 0)) problems.push("face_missing");
  if (frames.some((m) => m.faces >= 2)) problems.push("multiple_faces");
  const withFace = frames.filter((m) => m.faces >= 1 && num(m.centerX) && num(m.centerY) && num(m.faceSize));
  for (let i = 1; i < withFace.length; i++) {
    const a = withFace[i - 1];
    const b = withFace[i];
    const moved = Math.hypot(b.centerX! - a.centerX!, b.centerY! - a.centerY!);
    const ratio = Math.max(a.faceSize!, b.faceSize!) / Math.max(1e-6, Math.min(a.faceSize!, b.faceSize!));
    if (moved > FACE_JUMP_CENTER || ratio > FACE_JUMP_SIZE_RATIO) {
      problems.push("face_jump");
      break;
    }
  }
  const nearReference = (m: FaceFrameMeasure) =>
    reference !== null && num(reference.yaw) && num(reference.pitch) && num(m.yaw) && num(m.pitch) &&
    Math.abs(m.yaw - reference.yaw) <= SHAPE_POSE_MAX_YAW_DEG && Math.abs(m.pitch - reference.pitch) <= SHAPE_POSE_MAX_PITCH_DEG;
  if (frames.some((m) => single(m) && nearReference(m) && num(m.shapeDistance) && m.shapeDistance > SHAPE_CHANGE_MAX)) {
    problems.push("shape_change");
  }
  return problems;
}

/** The provisional passive cues, each on its median over the frames with exactly one face. */
export function passiveCues(frames: readonly FaceFrameMeasure[]): LivenessEvalProblem[] {
  const faces = frames.filter(single);
  const med = (pick: (m: FaceFrameMeasure) => number | null) => median(faces.map(pick).filter(num));
  const problems: LivenessEvalProblem[] = [];
  const moire = med((m) => m.moire);
  const glare = med((m) => m.glare);
  const detail = med((m) => m.detail);
  if (moire !== null && moire >= MOIRE_MIN) problems.push("moire");
  if (glare !== null && glare >= SCREEN_GLARE_MIN) problems.push("screen_glare");
  if (detail !== null && detail <= LOW_DETAIL_MAX) problems.push("low_detail");
  return problems;
}

/**
 * fail: an action was not done, or done the other way (the landmarks saw the face and it did not do
 * what was asked, in its step). flag: anything else that needs a person's eye (an action without a
 * face, a missing reference, the consistency and the provisional cues). pass: every action seen,
 * nothing else.
 */
export function decideLiveness(
  evidence: FaceLivenessEvidence,
  context: {
    challengeId: string;
    actions: readonly LivenessAction[];
    /** Every frame of the job, from the database (index and step). */
    frames: readonly FrameStep[];
    engine: string;
    timing: { ms: number; cold: boolean };
  },
): LivenessDecision {
  const stepOf = new Map(context.frames.map((f) => [f.index, f.step]));
  const measures = [...evidence.frames].sort((a, b) => a.index - b.index);
  const reference = measures.find((m) => m.index === evidence.referenceIndex && single(m)) ?? null;
  const problems = new Set<LivenessEvalProblem>();
  if (!reference) problems.add("no_reference");

  const actions = context.actions.map((action, i) => {
    const judged = judgeAction(action, measures.filter((m) => stepOf.get(m.index) === i + 1), reference);
    if (judged.problem) problems.add(judged.problem);
    return judged.details;
  });
  const plane = flatPlane(measures, reference);
  if (plane.result === "flat") problems.add("flat_plane");
  for (const p of consistencyProblems(measures, reference)) problems.add(p);
  for (const p of passiveCues(measures)) problems.add(p);

  const ordered = LIVENESS_EVAL_PROBLEMS.filter((p) => problems.has(p));
  const failed = ordered.includes("action_not_done") || ordered.includes("wrong_direction");
  const passed = actions.filter((a) => a.result === "pass").length;
  return {
    outcome: failed ? "fail" : ordered.length > 0 ? "flag" : "pass",
    score: context.actions.length ? round(passed / context.actions.length, 4) : 0,
    details: {
      evaluated: true,
      provisional: true,
      challengeId: context.challengeId,
      engine: context.engine,
      actions,
      frames: measures.length,
      framesWithFace: measures.filter(single).length,
      flatPlane: plane.result,
      flatPlaneScore: plane.score,
      problems: ordered,
      timing: context.timing,
    },
  };
}

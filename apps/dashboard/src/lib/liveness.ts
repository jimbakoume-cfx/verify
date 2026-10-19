// The face check on the case page (M5): its liveness_capture check (read directly, RLS decides) and
// its frames (capture rows of kind liveness_frame). Codes, counts and timings only; the frames
// themselves open through the audited 60-second viewer, like the document photos.
import {
  LIVENESS_ACTIONS,
  LIVENESS_CHECK_NAME,
  LIVENESS_PROBLEMS,
  type LivenessAction,
  type LivenessCaptureDetails,
  type LivenessProblem,
} from "@verify/shared";
import { type CaptureRecord, type CheckRecord, toCheckRow } from "./records";

export type LivenessCheckRecord = CheckRecord<LivenessCaptureDetails>;

export const LIVENESS_FRAME_KIND = "liveness_frame";

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** The stored details, when they have the shape this dashboard knows; null otherwise. */
export function toLivenessDetails(value: unknown): LivenessCaptureDetails | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  const frames = count(d.frames);
  const durationMs = count(d.durationMs);
  const serverElapsedMs = count(d.serverElapsedMs);
  const maxGapMs = count(d.maxGapMs);
  if (
    d.evaluated !== false || typeof d.challengeId !== "string" || typeof d.code !== "string" ||
    !Array.isArray(d.actions) || !d.actions.every((a) => isOneOf(LIVENESS_ACTIONS, a)) ||
    !Array.isArray(d.framesPerStep) || !d.framesPerStep.every((n) => count(n) !== null) ||
    !Array.isArray(d.problems) || !d.problems.every((p) => isOneOf(LIVENESS_PROBLEMS, p)) ||
    typeof d.startedWithWarning !== "boolean" ||
    frames === null || durationMs === null || serverElapsedMs === null || maxGapMs === null
  ) {
    return null;
  }
  return {
    evaluated: false,
    challengeId: d.challengeId,
    actions: d.actions as LivenessAction[],
    code: d.code,
    frames,
    framesPerStep: d.framesPerStep as number[],
    durationMs,
    serverElapsedMs,
    maxGapMs,
    startedWithWarning: d.startedWithWarning,
    problems: LIVENESS_PROBLEMS.filter((p) => (d.problems as LivenessProblem[]).includes(p)),
  };
}

/** A liveness_capture row; null for any other row. Unknown details are kept as null ("cannot read"). */
export function toLivenessCheck(value: unknown): LivenessCheckRecord | null {
  const row = toCheckRow(value);
  if (!row || row.name !== LIVENESS_CHECK_NAME) return null;
  return { ...row.check, details: toLivenessDetails(row.details) };
}

export function isLivenessFrame(capture: CaptureRecord): boolean {
  return capture.kind === LIVENESS_FRAME_KIND;
}

export interface LivenessOverview {
  check: LivenessCheckRecord | null;
  /** The recorded face check's frames, in order (the newest face check's when the check is missing). */
  frames: CaptureRecord[];
  /** Frames of earlier face checks, replaced and erased. */
  replaced: number;
}

/** The face check of a case: its check, and the frames of the challenge the check names. */
export function livenessOverview(captures: readonly CaptureRecord[], check: LivenessCheckRecord | null): LivenessOverview {
  const all = captures.filter(isLivenessFrame);
  const live = all.filter((c) => !c.deleted);
  const challenge = check?.details?.challengeId ?? live[0]?.livenessChallengeId ?? null;
  const frames = live
    .filter((c) => c.livenessChallengeId === challenge)
    .sort((a, b) => (a.liveness?.index ?? 0) - (b.liveness?.index ?? 0));
  return { check, frames, replaced: all.filter((c) => c.deleted).length };
}

/** "482 913": the code as the rider saw it. */
export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

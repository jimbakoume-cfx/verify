// The face worker's checks on the case page (M6 liveness evaluation, M7 face match): the case-level
// check_result rows "liveness" and "face_match" (RLS decides who reads them) and each face job's
// status (face_job: verification_id, kind and status only are granted). Parsed field by field: only
// the contract's codes and scores get through; anything else makes the details unreadable (null).
import {
  FACE_JOB_KINDS,
  FACE_MATCH_CHECK_NAME,
  FACE_MATCH_PROBLEMS,
  type FaceJobKind,
  type FaceMatchDetails,
  FLAT_PLANE_RESULTS,
  LIVENESS_ACTION_RESULTS,
  LIVENESS_ACTIONS,
  LIVENESS_EVAL_CHECK_NAME,
  LIVENESS_EVAL_PROBLEMS,
  type LivenessActionDetails,
  LIVENESS_BASELINE_KEYS,
  LIVENESS_FRAME_METRIC_KEYS,
  FACE_TIMING_KEYS,
  type LivenessDetails,
  type LivenessFrameMetric,
  type LivenessMetrics,
  type LivenessTiming,
  PROVISIONAL_LIVENESS_PROBLEMS,
} from "@verify/shared";
import { type CheckRecord, toCheckRow } from "./records";

export const FACE_CHECK_NAMES: readonly string[] = [LIVENESS_EVAL_CHECK_NAME, FACE_MATCH_CHECK_NAME];
export const FACE_JOB_COLUMNS = "verification_id, kind, status";

export type LivenessEvalRecord = CheckRecord<LivenessDetails>;
export type FaceMatchRecord = CheckRecord<FaceMatchDetails>;

/** What the dashboard says about a face job: none yet, waiting for the face worker, done, or given up. */
export type FaceJobState = "none" | "waiting" | "done" | "not_checked";

export interface FaceChecks {
  liveness: LivenessEvalRecord | null;
  faceMatch: FaceMatchRecord | null;
  jobs: Record<FaceJobKind, FaceJobState>;
}

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
const exactKeys = (row: Row, keys: readonly string[]) =>
  Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key));
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** ms and cold always; fetchMs, wallMs and sinceJobMs since the fixes after the PM's first real test. */
function timing(value: unknown): LivenessTiming | null {
  const t = asRow(value);
  const ms = num(t?.ms);
  if (!t || ms === null || typeof t.cold !== "boolean") return null;
  if (Object.keys(t).some((key) => !(FACE_TIMING_KEYS as readonly string[]).includes(key))) return null;
  const out: LivenessTiming = { ms, cold: t.cold };
  for (const key of ["fetchMs", "wallMs", "sinceJobMs"] as const) {
    if (t[key] === undefined) continue;
    const n = num(t[key]);
    if (n === null) return null;
    out[key] = n;
  }
  return out;
}

/** The per-frame numbers of liveness-eval-v2 (for tuning); null when absent or not of the contract's shape. */
function toMetrics(value: unknown): LivenessMetrics | null {
  const m = asRow(value);
  const baseline = asRow(m?.baseline);
  if (!m || !baseline || !Array.isArray(m.frames) || !Array.isArray(m.windows)) return null;
  const numOrNull = (v: unknown) => (v === null ? null : num(v));
  const base = {} as LivenessMetrics["baseline"];
  for (const key of LIVENESS_BASELINE_KEYS) {
    if (baseline[key] !== null && num(baseline[key]) === null) return null;
    base[key] = numOrNull(baseline[key]);
  }
  const frames: LivenessFrameMetric[] = [];
  for (const raw of m.frames) {
    const f = asRow(raw);
    if (!f || !exactKeys(f, LIVENESS_FRAME_METRIC_KEYS)) return null;
    if (LIVENESS_FRAME_METRIC_KEYS.some((key) => f[key] !== null && num(f[key]) === null)) return null;
    const index = num(f.index);
    const faces = num(f.faces);
    if (index === null || faces === null) return null;
    frames.push({
      index, step: numOrNull(f.step), faces, yaw: numOrNull(f.yaw), pitch: numOrNull(f.pitch), blink: numOrNull(f.blink),
      eyeOpenness: numOrNull(f.eyeOpenness), smile: numOrNull(f.smile), mouthWidth: numOrNull(f.mouthWidth),
    });
  }
  const windows = m.windows.map((w) => (Array.isArray(w) && w.every((i) => num(i) !== null) ? (w as number[]) : null));
  if (windows.some((w) => w === null)) return null;
  return { baseline: base, windows: windows as number[][], frames };
}

/** [x, y, width, height] as fractions of the photo, or null. */
export function toBox(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const box = value.map(num);
  if (box.some((n) => n === null || n < 0 || n > 1)) return null;
  return box as number[];
}

function toAction(value: unknown): LivenessActionDetails | null {
  const a = asRow(value);
  if (!a || !exactKeys(a, ["action", "result", "framesWithFace", "peak"])) return null;
  const frames = num(a.framesWithFace);
  if (!isOneOf(LIVENESS_ACTIONS, a.action) || !isOneOf(LIVENESS_ACTION_RESULTS, a.result) || frames === null) return null;
  if (a.peak !== null && num(a.peak) === null) return null;
  return { action: a.action, result: a.result, framesWithFace: frames, peak: a.peak as number | null };
}

export function toLivenessEvalDetails(value: unknown): LivenessDetails | null {
  const d = asRow(value);
  if (!d) return null;
  const frames = num(d.frames);
  const framesWithFace = num(d.framesWithFace);
  const t = timing(d.timing);
  if (
    d.evaluated !== true || d.provisional !== true || !isUuid(d.challengeId) || typeof d.engine !== "string" ||
    !Array.isArray(d.actions) || frames === null || framesWithFace === null || !isOneOf(FLAT_PLANE_RESULTS, d.flatPlane) ||
    (d.flatPlaneScore !== null && num(d.flatPlaneScore) === null) || !Array.isArray(d.problems) ||
    !d.problems.every((p) => isOneOf(LIVENESS_EVAL_PROBLEMS, p)) || !t
  ) {
    return null;
  }
  const actions = d.actions.map(toAction);
  if (actions.some((a) => a === null)) return null;
  return {
    evaluated: true,
    provisional: true,
    challengeId: d.challengeId,
    engine: d.engine,
    actions: actions as LivenessActionDetails[],
    frames,
    framesWithFace,
    flatPlane: d.flatPlane,
    flatPlaneScore: d.flatPlaneScore as number | null,
    problems: LIVENESS_EVAL_PROBLEMS.filter((p) => (d.problems as string[]).includes(p)),
    timing: t,
    ...(d.metrics === undefined ? {} : { metrics: toMetrics(d.metrics) ?? undefined }),
  };
}

export function toFaceMatchDetails(value: unknown): FaceMatchDetails | null {
  const d = asRow(value);
  if (!d) return null;
  const threshold = num(d.threshold);
  const lowThreshold = num(d.lowThreshold);
  const portrait = asRow(d.portrait);
  const selfie = asRow(d.selfie);
  const t = timing(d.timing);
  if (
    typeof d.model !== "string" || typeof d.engine !== "string" || threshold === null || lowThreshold === null ||
    (d.similarity !== null && num(d.similarity) === null) || d.calibrated !== false || d.reviewOnly !== true ||
    !Array.isArray(d.problems) || !d.problems.every((p) => isOneOf(FACE_MATCH_PROBLEMS, p)) || !t ||
    !portrait || !exactKeys(portrait, ["captureId", "box"]) || !isUuid(portrait.captureId) ||
    !selfie || !exactKeys(selfie, ["captureId", "box"]) || (selfie.captureId !== null && !isUuid(selfie.captureId))
  ) {
    return null;
  }
  return {
    model: d.model,
    engine: d.engine,
    similarity: d.similarity as number | null,
    threshold,
    lowThreshold,
    calibrated: false,
    reviewOnly: true,
    problems: FACE_MATCH_PROBLEMS.filter((p) => (d.problems as string[]).includes(p)),
    portrait: { captureId: portrait.captureId, box: toBox(portrait.box) },
    selfie: { captureId: selfie.captureId as string | null, box: toBox(selfie.box) },
    timing: t,
  };
}

/**
 * The face jobs' rows to one state per kind. A job's result is removed when its inputs change (a newer
 * face check or front), so the page shows a check when there is one; without it, what the jobs say:
 * one waiting beats one given up, which beats a done job of older inputs. Superseded jobs are ignored.
 */
export function faceJobStates(rows: readonly unknown[]): Record<FaceJobKind, FaceJobState> {
  const rank: Record<FaceJobState, number> = { none: 0, done: 1, not_checked: 2, waiting: 3 };
  const out: Record<FaceJobKind, FaceJobState> = { liveness: "none", face_match: "none" };
  for (const value of rows) {
    const row = asRow(value);
    if (!row || !isOneOf(FACE_JOB_KINDS, row.kind) || typeof row.status !== "string") continue;
    const state: FaceJobState | null = row.status === "pending" || row.status === "claimed"
      ? "waiting"
      : row.status === "done"
      ? "done"
      : row.status === "failed"
      ? "not_checked"
      : null;
    if (state && rank[state] > rank[out[row.kind]]) out[row.kind] = state;
  }
  return out;
}

export function toFaceChecks(checkRows: readonly unknown[], jobRows: readonly unknown[]): FaceChecks {
  const out: FaceChecks = { liveness: null, faceMatch: null, jobs: faceJobStates(jobRows) };
  for (const value of checkRows) {
    const row = toCheckRow(value);
    if (!row || row.check.captureId !== null) continue;
    if (row.name === LIVENESS_EVAL_CHECK_NAME) out.liveness = { ...row.check, details: toLivenessEvalDetails(row.details) };
    if (row.name === FACE_MATCH_CHECK_NAME) out.faceMatch = { ...row.check, details: toFaceMatchDetails(row.details) };
  }
  return out;
}

export function isProvisionalProblem(problem: string): boolean {
  return (PROVISIONAL_LIVENESS_PROBLEMS as readonly string[]).includes(problem);
}

/**
 * CSS for showing only `box` of a photo (fractions of it), enlarged by `margin` on each side and
 * clamped to the photo: the container keeps the crop's aspect ratio, the image is scaled and shifted
 * inside it. No pixel is cut out or stored: the whole photo is loaded through the audited viewer.
 */
export function cropStyle(box: readonly number[], photoWidth: number, photoHeight: number, margin = 0.25) {
  const [bx, by, bw, bh] = box;
  const x = Math.max(0, bx - bw * margin);
  const y = Math.max(0, by - bh * margin);
  const w = Math.min(1 - x, bw * (1 + 2 * margin));
  const h = Math.min(1 - y, bh * (1 + 2 * margin));
  const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;
  return {
    container: { aspectRatio: `${Math.max(1, Math.round(w * photoWidth))} / ${Math.max(1, Math.round(h * photoHeight))}` },
    image: { width: pct(1 / w), height: pct(1 / h), left: pct(-x / w), top: pct(-y / h) },
  };
}

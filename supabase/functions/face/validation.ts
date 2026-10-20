// Strict validation of the face worker's request bodies (contract.ts, "Face worker API"). As for the
// AI worker (worker/validation.ts): each validator rebuilds the object from known fields only, and an
// unknown key, a wrong type or a value out of range is refused, never dropped. Messages name the
// field, never its value.
import {
  FACE_JOB_KINDS,
  FACE_LIMITS,
  type FaceFrameMeasure,
  type FaceImageRequest,
  type FaceLivenessEvidence,
  type FaceMatchEvidence,
  type FaceResultRequest,
  LIVENESS_LIMITS,
} from "../_shared/contract.ts";
import { isOneOf, isPlainObject, isUuid } from "../_shared/http.ts";

/** A face job is given up after this many claims (face_job.attempts in the M6/M7 migration). */
export const MAX_ATTEMPTS = 3;
const MAX_TIMING_MS = 300_000;
const ENGINE_RE = /^[A-Za-z0-9._/-]+$/;

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

const bad = <T>(message: string): Validation<T> => ({ ok: false, message });
const extraKey = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).find((key) => !allowed.includes(key));
const isIntegerIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isNumberIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isNullableNumberIn = (v: unknown, min: number, max: number): v is number | null => v === null || isNumberIn(v, min, max);

export function validateClaimBody(body: Record<string, unknown> | null): Validation<Record<string, never>> {
  if (body !== null && Object.keys(body).length > 0) return bad("The claim body must be empty or {}.");
  return { ok: true, value: {} };
}

export function validateImageRequest(body: Record<string, unknown>): Validation<FaceImageRequest> {
  if (extraKey(body, ["jobId", "attempt", "captureId"]) !== undefined) return bad("Unknown field in the image request.");
  if (!isUuid(body.jobId)) return bad("jobId must be a UUID.");
  if (!isIntegerIn(body.attempt, 1, MAX_ATTEMPTS)) return bad(`attempt must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  if (!isUuid(body.captureId)) return bad("captureId must be a UUID.");
  return { ok: true, value: { jobId: body.jobId.toLowerCase(), attempt: body.attempt, captureId: body.captureId.toLowerCase() } };
}

/** [x, y, width, height], each a fraction of the photo. */
function isBox(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 4 && value.every((n) => isNumberIn(n, 0, 1)) &&
    (value[0] as number) + (value[2] as number) <= 1.0001 && (value[1] as number) + (value[3] as number) <= 1.0001;
}

// Ranges a measure can take: wide enough for any real value, narrow enough to refuse garbage.
const FRAME_RANGES: Record<Exclude<keyof FaceFrameMeasure, "index" | "faces">, [number, number]> = {
  yaw: [-180, 180],
  pitch: [-90, 90],
  roll: [-180, 180],
  blink: [0, 1],
  eyeOpenness: [0, 5],
  smile: [0, 1],
  mouthWidth: [0, 20],
  faceSize: [0, 1],
  centerX: [-1, 2],
  centerY: [-1, 2],
  planarResidual: [0, 1000],
  shapeDistance: [0, 1000],
  moire: [0, 100],
  glare: [0, 1],
  detail: [0, 1000],
};
const FRAME_KEYS = ["index", "faces", ...Object.keys(FRAME_RANGES)];

function validateFrame(value: unknown): Validation<FaceFrameMeasure> {
  if (!isPlainObject(value)) return bad("Each frame measure must be an object.");
  if (extraKey(value, FRAME_KEYS) !== undefined) return bad("Unknown field in a frame measure.");
  if (FRAME_KEYS.some((key) => !Object.hasOwn(value, key))) return bad("A frame measure is missing a field.");
  if (!isIntegerIn(value.index, 0, LIVENESS_LIMITS.maxFrames - 1)) return bad("frames[].index is out of range.");
  if (!isIntegerIn(value.faces, 0, 2)) return bad("frames[].faces must be 0, 1 or 2.");
  const out = { index: value.index, faces: value.faces } as FaceFrameMeasure;
  for (const [key, [min, max]] of Object.entries(FRAME_RANGES)) {
    const v = value[key];
    if (!isNullableNumberIn(v, min, max)) return bad(`frames[].${key} must be null or a number from ${min} to ${max}.`);
    if (value.faces === 0 && v !== null) return bad(`frames[].${key} must be null without a face.`);
    (out as unknown as Record<string, number | null>)[key] = v;
  }
  return { ok: true, value: out };
}

function validateLiveness(value: unknown): Validation<FaceLivenessEvidence> {
  if (!isPlainObject(value)) return bad("liveness must be an object.");
  if (extraKey(value, ["referenceIndex", "frames"]) !== undefined) return bad("Unknown field in liveness.");
  if (value.referenceIndex !== null && !isIntegerIn(value.referenceIndex, 0, LIVENESS_LIMITS.maxFrames - 1)) {
    return bad("liveness.referenceIndex is out of range.");
  }
  if (!Array.isArray(value.frames) || value.frames.length < 1 || value.frames.length > LIVENESS_LIMITS.maxFrames) {
    return bad(`liveness.frames must hold 1 to ${LIVENESS_LIMITS.maxFrames} measures.`);
  }
  const frames: FaceFrameMeasure[] = [];
  for (const item of value.frames) {
    const frame = validateFrame(item);
    if (!frame.ok) return frame;
    frames.push(frame.value);
  }
  if (new Set(frames.map((f) => f.index)).size !== frames.length) return bad("liveness.frames repeats an index.");
  if (value.referenceIndex !== null && !frames.some((f) => f.index === value.referenceIndex)) {
    return bad("liveness.referenceIndex is not one of the frames.");
  }
  return { ok: true, value: { referenceIndex: value.referenceIndex as number | null, frames } };
}

function validateFaceMatch(value: unknown): Validation<FaceMatchEvidence> {
  if (!isPlainObject(value)) return bad("faceMatch must be an object.");
  if (extraKey(value, ["portrait", "selfie", "similarity"]) !== undefined) return bad("Unknown field in faceMatch.");
  const { portrait, selfie, similarity } = value;
  if (!isPlainObject(portrait)) return bad("faceMatch.portrait must be an object.");
  const portraitKeys = ["found", "faces", "box", "faceSize", "method", "detectionScore"];
  if (extraKey(portrait, portraitKeys) !== undefined || portraitKeys.some((k) => !Object.hasOwn(portrait, k))) {
    return bad("faceMatch.portrait must hold exactly its fields.");
  }
  if (typeof portrait.found !== "boolean") return bad("faceMatch.portrait.found must be a boolean.");
  if (!isIntegerIn(portrait.faces, 0, 50)) return bad("faceMatch.portrait.faces must be an integer from 0 to 50.");
  if (portrait.found) {
    if (!isBox(portrait.box)) return bad("faceMatch.portrait.box must be 4 fractions.");
    if (!isNumberIn(portrait.faceSize, 0, 10_000)) return bad("faceMatch.portrait.faceSize must be a number.");
    if (portrait.method !== "mesh" && portrait.method !== "detector") return bad("faceMatch.portrait.method must be mesh or detector.");
    if (!isNumberIn(portrait.detectionScore, 0, 1)) return bad("faceMatch.portrait.detectionScore must be from 0 to 1.");
  } else if (portrait.box !== null || portrait.faceSize !== null || portrait.method !== null || portrait.detectionScore !== null) {
    return bad("faceMatch.portrait must be empty when not found.");
  }

  if (!isPlainObject(selfie)) return bad("faceMatch.selfie must be an object.");
  const selfieKeys = ["captureId", "frameIndex", "found", "box", "faceSize", "yaw", "pitch"];
  if (extraKey(selfie, selfieKeys) !== undefined || selfieKeys.some((k) => !Object.hasOwn(selfie, k))) {
    return bad("faceMatch.selfie must hold exactly its fields.");
  }
  if (typeof selfie.found !== "boolean") return bad("faceMatch.selfie.found must be a boolean.");
  if (selfie.found) {
    if (!isUuid(selfie.captureId)) return bad("faceMatch.selfie.captureId must be a UUID.");
    if (!isIntegerIn(selfie.frameIndex, 0, LIVENESS_LIMITS.maxFrames - 1)) return bad("faceMatch.selfie.frameIndex is out of range.");
    if (!isBox(selfie.box)) return bad("faceMatch.selfie.box must be 4 fractions.");
    if (!isNumberIn(selfie.faceSize, 0, 10_000)) return bad("faceMatch.selfie.faceSize must be a number.");
    if (!isNumberIn(selfie.yaw, -180, 180) || !isNumberIn(selfie.pitch, -90, 90)) return bad("faceMatch.selfie.yaw and pitch must be angles.");
  } else if (
    selfie.captureId !== null || selfie.frameIndex !== null || selfie.box !== null || selfie.faceSize !== null ||
    selfie.yaw !== null || selfie.pitch !== null
  ) {
    return bad("faceMatch.selfie must be empty when not found.");
  }
  if (!isNullableNumberIn(similarity, -1, 1)) return bad("faceMatch.similarity must be null or from -1 to 1.");
  if (similarity !== null && !(portrait.found && selfie.found)) return bad("faceMatch.similarity needs both faces.");
  return {
    ok: true,
    value: {
      portrait: {
        found: portrait.found,
        faces: portrait.faces,
        box: portrait.found ? [...(portrait.box as number[])] : null,
        faceSize: portrait.faceSize as number | null,
        method: portrait.method as "mesh" | "detector" | null,
        detectionScore: portrait.detectionScore as number | null,
      },
      selfie: {
        captureId: selfie.found ? (selfie.captureId as string).toLowerCase() : null,
        frameIndex: selfie.frameIndex as number | null,
        found: selfie.found,
        box: selfie.found ? [...(selfie.box as number[])] : null,
        faceSize: selfie.faceSize as number | null,
        yaw: selfie.yaw as number | null,
        pitch: selfie.pitch as number | null,
      },
      similarity: similarity as number | null,
    },
  };
}

export function validateResultRequest(body: Record<string, unknown>): Validation<FaceResultRequest> {
  const keys = ["jobId", "attempt", "kind", "engine", "liveness", "faceMatch", "timing"];
  if (extraKey(body, keys) !== undefined) return bad("Unknown field in the result.");
  if (!isUuid(body.jobId)) return bad("jobId must be a UUID.");
  if (!isIntegerIn(body.attempt, 1, MAX_ATTEMPTS)) return bad(`attempt must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  if (!isOneOf(FACE_JOB_KINDS, body.kind)) return bad("kind must be liveness or face_match.");
  if (typeof body.engine !== "string" || body.engine.length < 1 || body.engine.length > FACE_LIMITS.maxEngineLength || !ENGINE_RE.test(body.engine)) {
    return bad("engine must be a short build label.");
  }
  if (!isPlainObject(body.timing) || extraKey(body.timing, ["ms", "cold"]) !== undefined) return bad("timing must be {ms, cold}.");
  if (!isIntegerIn(body.timing.ms, 0, MAX_TIMING_MS) || typeof body.timing.cold !== "boolean") {
    return bad(`timing.ms must be an integer from 0 to ${MAX_TIMING_MS}, timing.cold a boolean.`);
  }
  const timing = { ms: body.timing.ms, cold: body.timing.cold };
  const base = { jobId: body.jobId.toLowerCase(), attempt: body.attempt, kind: body.kind, engine: body.engine, timing };
  if (body.kind === "liveness") {
    if (body.faceMatch !== null) return bad("faceMatch must be null for a liveness job.");
    const liveness = validateLiveness(body.liveness);
    if (!liveness.ok) return liveness;
    return { ok: true, value: { ...base, liveness: liveness.value, faceMatch: null } };
  }
  if (body.liveness !== null) return bad("liveness must be null for a face_match job.");
  const faceMatch = validateFaceMatch(body.faceMatch);
  if (!faceMatch.ok) return faceMatch;
  return { ok: true, value: { ...base, liveness: null, faceMatch: faceMatch.value } };
}

// Strict validation of the worker's request bodies (contract.ts, "Worker API"). Each validator returns
// a fresh object holding only the known fields: an unknown key, a wrong type or a value out of range is
// refused rather than dropped, so a mismatch between the worker and this function shows at once.
// Messages name the field, never its value: the body carries data read from a document.
import {
  KEYWORD_GROUPS,
  type KeywordGroup,
  WORKER_LIMITS,
  type WorkerFields,
  type WorkerImageRequest,
  type WorkerQuality,
  type WorkerResultRequest,
} from "../_shared/contract.ts";
import { isPlainObject, isUuid } from "../_shared/http.ts";
import { WORKER_FIELD_NAMES } from "./decide.ts";

/** A job is given up after this many claims (worker_job.attempts in the M3 migration). */
export const MAX_ATTEMPTS = 3;
/** Vercel's longest run, in milliseconds. */
const MAX_TIMING_MS = 300_000;

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

const ENGINE_RE = /^[A-Za-z0-9._/-]+$/;
const CANDIDATE_RE = /^[A-Z0-9<]*$/;
// Printable ASCII: the worker maps OCR output to ASCII (look-alike Greek or Cyrillic letters included).
const FIELD_VALUE_RE = /^[\x20-\x7e]+$/;
const SUBTYPE_RE = /^[a-z_]{1,32}$/;

function bad<T>(message: string): Validation<T> {
  return { ok: false, message };
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  return extra === undefined ? null : extra;
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isNumberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** POST /claim: an empty body or an empty JSON object. */
export function validateClaimBody(body: Record<string, unknown> | null): Validation<Record<string, never>> {
  if (body !== null && Object.keys(body).length > 0) return bad("The claim body must be empty or {}.");
  return { ok: true, value: {} };
}

function jobRef(body: Record<string, unknown>): Validation<{ jobId: string; attempt: number }> {
  if (!isUuid(body.jobId)) return bad("jobId must be a UUID.");
  if (!isIntegerIn(body.attempt, 1, MAX_ATTEMPTS)) return bad(`attempt must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  return { ok: true, value: { jobId: body.jobId.toLowerCase(), attempt: body.attempt } };
}

export function validateImageRequest(body: Record<string, unknown>): Validation<WorkerImageRequest> {
  const extra = onlyKeys(body, ["jobId", "attempt"]);
  if (extra !== null) return bad("Unknown field in the image request.");
  return jobRef(body);
}

function validateQuality(value: unknown): Validation<WorkerQuality> {
  if (!isPlainObject(value)) return bad("quality must be an object.");
  const keys = ["sharpness", "glareRatio", "meanLuma", "documentFound", "documentConfidence", "longSide", "textLines"];
  if (onlyKeys(value, keys) !== null) return bad("Unknown field in quality.");
  const q = value;
  if (!isNumberIn(q.sharpness, 0, 1e9)) return bad("quality.sharpness must be a number from 0 to 1e9.");
  if (!isNumberIn(q.glareRatio, 0, 1)) return bad("quality.glareRatio must be a number from 0 to 1.");
  if (!isNumberIn(q.meanLuma, 0, 255)) return bad("quality.meanLuma must be a number from 0 to 255.");
  if (typeof q.documentFound !== "boolean") return bad("quality.documentFound must be a boolean.");
  if (!isNumberIn(q.documentConfidence, 0, 1)) return bad("quality.documentConfidence must be a number from 0 to 1.");
  if (!isIntegerIn(q.longSide, 0, 16_384)) return bad("quality.longSide must be an integer from 0 to 16384.");
  if (!isIntegerIn(q.textLines, 0, 10_000)) return bad("quality.textLines must be an integer from 0 to 10000.");
  return {
    ok: true,
    value: {
      sharpness: q.sharpness,
      glareRatio: q.glareRatio,
      meanLuma: q.meanLuma,
      documentFound: q.documentFound,
      documentConfidence: q.documentConfidence,
      longSide: q.longSide,
      textLines: q.textLines,
    },
  };
}

function validateClassification(value: unknown): Validation<WorkerResultRequest["classification"]> {
  if (!isPlainObject(value)) return bad("classification must be an object.");
  if (onlyKeys(value, ["rotation", "keywordHits", "qrPresent", "orientation"]) !== null) {
    return bad("Unknown field in classification.");
  }
  const { rotation, keywordHits, qrPresent, orientation } = value;
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    return bad("classification.rotation must be 0, 90, 180 or 270.");
  }
  if (!isPlainObject(keywordHits)) return bad("classification.keywordHits must be an object.");
  const groups = Object.keys(keywordHits);
  if (groups.length > WORKER_LIMITS.maxKeywordGroups) {
    return bad(`classification.keywordHits has more than ${WORKER_LIMITS.maxKeywordGroups} groups.`);
  }
  const hits: Partial<Record<KeywordGroup, number>> = {};
  for (const group of groups) {
    if (!(KEYWORD_GROUPS as readonly string[]).includes(group)) {
      return bad("classification.keywordHits has a group that is not in KEYWORD_GROUPS.");
    }
    const count = keywordHits[group];
    if (!isIntegerIn(count, 0, 1000)) return bad("classification.keywordHits counts must be integers from 0 to 1000.");
    hits[group as KeywordGroup] = count;
  }
  if (typeof qrPresent !== "boolean") return bad("classification.qrPresent must be a boolean.");
  if (orientation !== null && orientation !== "landscape" && orientation !== "portrait") {
    return bad("classification.orientation must be landscape, portrait or null.");
  }
  return { ok: true, value: { rotation, keywordHits: hits, qrPresent, orientation } };
}

function validateFields(value: unknown): Validation<WorkerFields> {
  if (!isPlainObject(value)) return bad("fields must be an object.");
  if (onlyKeys(value, WORKER_FIELD_NAMES) !== null) return bad("Unknown field in fields.");
  const fields: WorkerFields = {};
  for (const name of WORKER_FIELD_NAMES) {
    const raw = value[name];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return bad(`fields.${name} must be a string.`);
    const text = raw.trim();
    if (text.length === 0) continue; // Nothing read.
    if (text.length > WORKER_LIMITS.maxFieldLength || !FIELD_VALUE_RE.test(text)) {
      return bad(`fields.${name} must be 1 to ${WORKER_LIMITS.maxFieldLength} printable ASCII characters.`);
    }
    if (name === "subtype" && !SUBTYPE_RE.test(text)) return bad("fields.subtype must be a lower-case code.");
    fields[name] = text;
  }
  return { ok: true, value: fields };
}

/** POST /result. */
export function validateResultRequest(body: Record<string, unknown>): Validation<WorkerResultRequest> {
  const keys = ["jobId", "attempt", "engine", "quality", "mrzCandidates", "classification", "fields", "timing"];
  if (onlyKeys(body, keys) !== null) return bad("Unknown field in the result.");
  const ref = jobRef(body);
  if (!ref.ok) return ref;
  const { engine } = body;
  if (typeof engine !== "string" || engine.length > WORKER_LIMITS.maxEngineLength || !ENGINE_RE.test(engine)) {
    return bad(`engine must be 1 to ${WORKER_LIMITS.maxEngineLength} letters, digits or . _ / -.`);
  }
  const quality = validateQuality(body.quality);
  if (!quality.ok) return quality;

  const candidates = body.mrzCandidates;
  if (!Array.isArray(candidates) || candidates.length > WORKER_LIMITS.maxMrzCandidates) {
    return bad(`mrzCandidates must be an array of at most ${WORKER_LIMITS.maxMrzCandidates} lines.`);
  }
  if (
    !candidates.every((line): line is string =>
      typeof line === "string" && line.length <= WORKER_LIMITS.maxCandidateLength && CANDIDATE_RE.test(line)
    )
  ) {
    return bad(`mrzCandidates must hold lines of at most ${WORKER_LIMITS.maxCandidateLength} characters A-Z, 0-9 or <.`);
  }

  const classification = validateClassification(body.classification);
  if (!classification.ok) return classification;
  const fields = validateFields(body.fields);
  if (!fields.ok) return fields;

  const timing = body.timing;
  if (!isPlainObject(timing) || onlyKeys(timing, ["ms", "cold"]) !== null) {
    return bad("timing must be an object with ms and cold.");
  }
  if (!isIntegerIn(timing.ms, 0, MAX_TIMING_MS)) return bad(`timing.ms must be an integer from 0 to ${MAX_TIMING_MS}.`);
  if (typeof timing.cold !== "boolean") return bad("timing.cold must be a boolean.");

  return {
    ok: true,
    value: {
      ...ref.value,
      engine,
      quality: quality.value,
      mrzCandidates: [...candidates],
      classification: classification.value,
      fields: fields.value,
      timing: { ms: timing.ms, cold: timing.cold },
    },
  };
}

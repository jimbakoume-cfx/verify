// Pure validation for the rider flow: storage paths, the client quality object and MRZ reports.
import {
  CAPTURE_SIDES,
  type CaptureSide,
  type ClientQuality,
  MRZ_LAYOUT,
  MRZ_REPORT_LIMITS,
  type MrzFormat,
  type MrzReportRequest,
} from "../_shared/contract.ts";
import { isUuid } from "../_shared/http.ts";

const CAPTURE_PATH_RE = /^([0-9a-f-]{36})\/(document_front|document_back)-([0-9a-f-]{36})\.jpg$/;

/** Object path for a new upload: <verification id>/<kind>-<uuid>.jpg. */
export function buildCapturePath(verificationId: string, kind: CaptureSide, uuid: string): string {
  return `${verificationId}/${kind}-${uuid}.jpg`;
}

/**
 * Accepts only a path this session could have been issued: inside its own folder, for the declared
 * kind, in the exact shape buildCapturePath produces. Anything else (traversal, another folder,
 * encoded characters, another kind) is rejected.
 */
export function isOwnCapturePath(path: unknown, verificationId: string, kind: CaptureSide): path is string {
  if (typeof path !== "string" || path.length > 120) return false;
  const match = CAPTURE_PATH_RE.exec(path);
  return match !== null && match[1] === verificationId && match[2] === kind && CAPTURE_SIDES.includes(kind);
}

// Bounds are generous: the metrics are informational (the server re-checks images in M3) and are
// only clamped so that stored values stay finite and sane.
const NUMERIC_BOUNDS = {
  sharpness: [0, 1e6],
  glareRatio: [0, 1],
  meanLuma: [0, 255],
  framing: [0, 1],
  videoWidth: [0, 16384],
  videoHeight: [0, 16384],
  elapsedMs: [0, 24 * 60 * 60 * 1000],
} as const satisfies Record<Exclude<keyof ClientQuality, "source">, readonly [number, number]>;

/**
 * Returns a fresh object holding only the known fields, every number clamped to its bounds
 * (JSON can carry 1e999, which parses to Infinity). Null when a field is missing or of the wrong type.
 */
export function sanitizeQuality(value: unknown): ClientQuality | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.source !== "auto" && input.source !== "manual") return null;
  const out: Record<string, number | string> = { source: input.source };
  for (const [key, [min, max]] of Object.entries(NUMERIC_BOUNDS)) {
    const n = input[key];
    if (typeof n !== "number" || Number.isNaN(n)) return null;
    out[key] = Math.min(max, Math.max(min, n));
  }
  return out as unknown as ClientQuality;
}

export type MrzReportCheck =
  | { ok: true; report: MrzReportRequest }
  | { ok: false; code: "bad_request" | "invalid_mrz"; message: string };

const ENGINE_RE = /^[A-Za-z0-9._/-]+$/;

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Checks a POST /flow/mrz body against the format the declared document carries, and returns a fresh
 * report holding only the known fields. A missing field, a wrong type or an out-of-range number is
 * bad_request; well-typed lines that are not an MRZ of that format (count, length, characters) are
 * invalid_mrz. The bad_request checks all come first, so a body wrong in both ways gets bad_request.
 * Messages never repeat a value.
 */
export function validateMrzReport(body: Record<string, unknown>, format: MrzFormat): MrzReportCheck {
  const bad = (message: string): MrzReportCheck => ({ ok: false, code: "bad_request", message });
  const { maxAttempts, maxCorrections, maxMs, maxEngineLength } = MRZ_REPORT_LIMITS;
  if (!isUuid(body.captureId)) return bad("captureId must be a UUID.");
  if (body.result !== "read" && body.result !== "unreadable") return bad("result must be read or unreadable.");
  if (!isIntegerIn(body.attempts, 1, maxAttempts)) return bad(`attempts must be an integer from 1 to ${maxAttempts}.`);
  const engine = body.engine;
  if (typeof engine !== "string" || engine.length > maxEngineLength || !ENGINE_RE.test(engine)) {
    return bad(`engine must be 1 to ${maxEngineLength} letters, digits or . _ / -.`);
  }
  const base = { captureId: body.captureId.toLowerCase(), attempts: body.attempts, engine };

  if (body.result === "unreadable") {
    if (body.reason !== "not_found" && body.reason !== "reader_unavailable") {
      return bad("reason must be not_found or reader_unavailable.");
    }
    return { ok: true, report: { ...base, result: "unreadable", reason: body.reason } };
  }

  if (!isIntegerIn(body.corrections, 0, maxCorrections)) {
    return bad(`corrections must be an integer from 0 to ${maxCorrections}.`);
  }
  if (!isIntegerIn(body.ms, 0, maxMs)) return bad(`ms must be an integer from 0 to ${maxMs}.`);
  const lines = body.lines;
  if (!Array.isArray(lines) || !lines.every((line): line is string => typeof line === "string")) {
    return bad("lines must be an array of strings.");
  }
  const layout = MRZ_LAYOUT[format];
  const lineRe = new RegExp(`^[A-Z0-9<]{${layout.length}}$`);
  if (lines.length !== layout.lines || !lines.every((line) => lineRe.test(line))) {
    return {
      ok: false,
      code: "invalid_mrz",
      message: `lines must be ${layout.lines} lines of ${layout.length} characters A-Z, 0-9 or < (${format}).`,
    };
  }
  return { ok: true, report: { ...base, result: "read", lines: [...lines], corrections: body.corrections, ms: body.ms } };
}

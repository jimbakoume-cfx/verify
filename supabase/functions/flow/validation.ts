// Pure validation for the rider flow: storage paths and the client quality object.
import { CAPTURE_SIDES, type CaptureSide, type ClientQuality } from "../_shared/contract.ts";

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

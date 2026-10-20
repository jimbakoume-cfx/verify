// Pure helpers for the face check (M5): drawing a challenge, the frames' storage paths, and the strict
// validation of POST /flow/liveness/captures.
import {
  LIVENESS_ACTIONS,
  LIVENESS_LIMITS,
  type LivenessAction,
  type LivenessCaptureRequest,
  type LivenessFrameReport,
} from "../_shared/contract.ts";
import { isUuid } from "../_shared/http.ts";

/** A uniform random integer in [0, n), from `bytes` (crypto.getRandomValues in production). */
export type RandomInt = (n: number) => number;

/** Rejection sampling over 32-bit values, so no value is more likely than another. */
export function cryptoRandomInt(n: number, fill: (array: Uint32Array) => Uint32Array = (a) => crypto.getRandomValues(a)): number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError("n out of range");
  const limit = Math.floor(2 ** 32 / n) * n;
  const buffer = new Uint32Array(1);
  for (;;) {
    const value = fill(buffer)[0];
    if (value < limit) return value % n;
  }
}

export interface DrawnChallenge {
  actions: LivenessAction[];
  code: string;
}

/**
 * LIVENESS_LIMITS.actionsPerChallenge different actions in a random order (a partial Fisher-Yates
 * shuffle), and a one-time code of LIVENESS_LIMITS.codeDigits digits.
 */
export function drawChallenge(randomInt: RandomInt = cryptoRandomInt): DrawnChallenge {
  const pool: LivenessAction[] = [...LIVENESS_ACTIONS];
  const actions: LivenessAction[] = [];
  for (let i = 0; i < LIVENESS_LIMITS.actionsPerChallenge; i++) {
    const pick = i + randomInt(pool.length - i);
    [pool[i], pool[pick]] = [pool[pick], pool[i]];
    actions.push(pool[i]);
  }
  const code = Array.from({ length: LIVENESS_LIMITS.codeDigits }, () => String(randomInt(10))).join("");
  return { actions, code };
}

/** Object path of frame `index` of a challenge: <verification id>/liveness-<challenge id>-<NN>.jpg. */
export function livenessFramePath(verificationId: string, challengeId: string, index: number): string {
  return `${verificationId}/liveness-${challengeId}-${String(index).padStart(2, "0")}.jpg`;
}

export type LivenessCaptureCheck =
  | { ok: true; request: LivenessCaptureRequest }
  | { ok: false; message: string };

const REQUEST_KEYS = ["challengeId", "code", "frames", "stepStartsMs", "startedWithWarning", "videoWidth", "videoHeight"];
const FRAME_KEYS = ["index", "path", "sha256", "atMs", "step"];

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/**
 * Checks a POST /flow/liveness/captures body and returns a fresh request holding only its fields. Any
 * unknown key, wrong type, out-of-range number or frame out of place is refused (400): the app never
 * sends one. The frames must come in index order, 0..n-1. Whether each path is this session's own slot
 * of this challenge is checked by the handler, which knows the session. Messages never repeat a value.
 */
export function validateLivenessCapture(body: Record<string, unknown>): LivenessCaptureCheck {
  const bad = (message: string): LivenessCaptureCheck => ({ ok: false, message });
  const { minFrames, maxFrames, maxCaptureMs, actionsPerChallenge, codeDigits } = LIVENESS_LIMITS;
  if (!onlyKeys(body, REQUEST_KEYS)) return bad("Unknown field.");
  if (!isUuid(body.challengeId)) return bad("challengeId must be a UUID.");
  if (typeof body.code !== "string" || !new RegExp(`^[0-9]{${codeDigits}}$`).test(body.code)) {
    return bad(`code must be ${codeDigits} digits.`);
  }
  if (typeof body.startedWithWarning !== "boolean") return bad("startedWithWarning must be true or false.");
  if (!isIntegerIn(body.videoWidth, 0, 16384) || !isIntegerIn(body.videoHeight, 0, 16384)) {
    return bad("videoWidth and videoHeight must be integers from 0 to 16384.");
  }
  const starts = body.stepStartsMs;
  if (
    !Array.isArray(starts) || starts.length !== actionsPerChallenge + 1 || starts[0] !== 0 ||
    !starts.every((ms) => isIntegerIn(ms, 0, maxCaptureMs))
  ) {
    return bad(`stepStartsMs must be ${actionsPerChallenge + 1} integers from 0 to ${maxCaptureMs}, the first 0.`);
  }
  const frames = body.frames;
  if (!Array.isArray(frames) || frames.length < minFrames || frames.length > maxFrames) {
    return bad(`frames must be a list of ${minFrames} to ${maxFrames} frames.`);
  }
  const clean: LivenessFrameReport[] = [];
  for (const [position, frame] of frames.entries()) {
    if (!isPlainObject(frame) || !onlyKeys(frame, FRAME_KEYS)) return bad("Each frame must be an object of known fields.");
    if (frame.index !== position) return bad("Frames must come in index order, from 0.");
    if (typeof frame.path !== "string" || frame.path.length > 160) return bad("Each frame needs its path.");
    if (typeof frame.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(frame.sha256)) {
      return bad("Each frame's sha256 must be 64 lower-case hex characters.");
    }
    if (!isIntegerIn(frame.atMs, 0, maxCaptureMs)) return bad(`Each frame's atMs must be an integer from 0 to ${maxCaptureMs}.`);
    if (!isIntegerIn(frame.step, 0, actionsPerChallenge)) {
      return bad(`Each frame's step must be an integer from 0 to ${actionsPerChallenge}.`);
    }
    clean.push({ index: position, path: frame.path, sha256: frame.sha256, atMs: frame.atMs, step: frame.step });
  }
  return {
    ok: true,
    request: {
      challengeId: body.challengeId.toLowerCase(),
      code: body.code,
      frames: clean,
      stepStartsMs: [...(starts as number[])],
      startedWithWarning: body.startedWithWarning,
      videoWidth: body.videoWidth,
      videoHeight: body.videoHeight,
    },
  };
}

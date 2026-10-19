// Sending a face check: the frames straight to private storage (signed slots from the challenge), a
// few at a time with automatic retries, then their report. No image passes through our web host.
import type {
  LivenessCaptureRequest,
  LivenessCaptureResponse,
  LivenessChallengeResponse,
  UploadUrlResponse,
} from "@verify/shared";
import { type FlowErrorCode, isTransient, toFlowError } from "../flow/errors";
import { UPLOAD_RETRY, type RetryPolicy, sleep as realSleep, withRetry } from "../flow/retry";

/** What the face check needs from the server (useFlow builds it on the flow API and storage). */
export interface LivenessService {
  challenge(): Promise<LivenessChallengeResponse>;
  upload(target: UploadUrlResponse, blob: Blob): Promise<void>;
  record(body: LivenessCaptureRequest): Promise<LivenessCaptureResponse>;
}

/** A frame taken, encoded and hashed on the phone. */
export interface TakenFrame {
  blob: Blob;
  /** SHA-256 (hex) of the blob's bytes; the server compares it with its own. */
  sha256: string;
  atMs: number;
  step: number;
}

export interface CaptureMeta {
  stepStartsMs: number[];
  startedWithWarning: boolean;
  videoWidth: number;
  videoHeight: number;
}

export type SendOutcome = { ok: true } | { ok: false; error: FlowErrorCode };

export interface SendOptions {
  /** Frames sent at the same time: a slow network gains little from more. */
  concurrency?: number;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  /** Steps done out of `total` (one per frame, plus the report). */
  onProgress?: (done: number, total: number) => void;
}

/** The report of a face check, as POST /flow/liveness/captures expects it. */
export function captureReport(
  challenge: LivenessChallengeResponse,
  frames: readonly TakenFrame[],
  meta: CaptureMeta,
): LivenessCaptureRequest {
  return {
    challengeId: challenge.challengeId,
    code: challenge.code,
    frames: frames.map((frame, index) => ({
      index,
      path: challenge.uploads[index].path,
      sha256: frame.sha256,
      atMs: Math.max(0, Math.round(frame.atMs)),
      step: frame.step,
    })),
    stepStartsMs: meta.stepStartsMs.map((ms) => Math.max(0, Math.round(ms))),
    startedWithWarning: meta.startedWithWarning,
    videoWidth: Math.round(meta.videoWidth),
    videoHeight: Math.round(meta.videoHeight),
  };
}

/**
 * Uploads every frame into its slot, then reports them. Each request is retried on its own when the
 * network or the server fails for a moment (UPLOAD_RETRY). Frames already stored by an earlier try are
 * found "already stored" by storage and count as sent, so "Try again" resends the same frames safely.
 */
export async function sendFaceCheck(
  service: LivenessService,
  challenge: LivenessChallengeResponse,
  frames: readonly TakenFrame[],
  meta: CaptureMeta,
  options: SendOptions = {},
): Promise<SendOutcome> {
  if (frames.length > challenge.uploads.length) return { ok: false, error: "unexpected" };
  const retry = { policy: options.policy ?? UPLOAD_RETRY, toError: toFlowError, shouldRetry: isTransient, sleep: options.sleep ?? realSleep };
  const total = frames.length + 1;
  let done = 0;
  options.onProgress?.(done, total);
  try {
    let next = 0;
    const worker = async () => {
      while (next < frames.length) {
        const index = next++;
        const slot = challenge.uploads[index];
        await withRetry(() => service.upload({ path: slot.path, token: slot.token, bucket: challenge.bucket }, frames[index].blob), retry);
        options.onProgress?.(++done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, frames.length) }, worker));
    await withRetry(() => service.record(captureReport(challenge, frames, meta)), retry);
    options.onProgress?.(++done, total);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toFlowError(err).code };
  }
}

/**
 * What the rider can do after a failed face check:
 * - "resend": the same frames again (the network or the server failed; the challenge is still good);
 * - "restart": a new face check (the challenge expired or was used, or the server refused the frames);
 * - "stop": nothing more here (too many face checks for this session).
 * Session errors (expired link...) are handled by the flow, like everywhere else.
 */
export function recoveryFor(error: FlowErrorCode): "resend" | "restart" | "stop" {
  if (error === "too_many_challenges") return "stop";
  if (error === "network" || error === "timeout" || error === "server_error" || error === "storage_failed") {
    return "resend";
  }
  // Refused frames (isImageRejection, invalid_liveness), an expired or used challenge, a missing upload.
  return "restart";
}

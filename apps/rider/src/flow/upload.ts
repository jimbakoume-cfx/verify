// Sends the accepted photos: for each side, POST /upload-url, upload straight to the private bucket,
// then POST /captures; finally POST /submit. Each step is retried automatically with backoff, and a
// retry resumes where the last attempt stopped (no new upload link, no second upload), which matters
// on slow networks and keeps within the per-session upload-link limit.
import type { CaptureSide, FlowSession, UploadUrlResponse } from "@verify/shared";
import type { FlowApi } from "./api";
import { FlowError, type FlowErrorCode, isImageRejection, isTransient, toFlowError } from "./errors";
import { type Shot, type UploadPhase, type UploadProgress, closedReason } from "./machine";
import { type RetryPolicy, UPLOAD_RETRY, withRetry } from "./retry";

/** Uploads `blob` with a signed upload token; resolves when the object is stored. Throws FlowError. */
export type PutObject = (target: UploadUrlResponse, blob: Blob) => Promise<void>;

export interface UploadDeps {
  api: Pick<FlowApi, "uploadUrl" | "completeCapture" | "submit" | "getSession">;
  putObject: PutObject;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface UploadListener {
  progress(progress: UploadProgress): void;
  sideDone(side: CaptureSide): void;
}

export type UploadOutcome =
  | { ok: true; session: FlowSession }
  | { ok: false; error: FlowErrorCode; side: CaptureSide | null };

/** What already happened for one photo, kept across attempts and manual retries. */
interface Slot {
  target: UploadUrlResponse | null;
  stored: boolean;
  done: boolean;
}

export const STEPS_PER_PHOTO = 3;

function stepsDone(slot: Slot): number {
  return (slot.target ? 1 : 0) + (slot.stored ? 1 : 0) + (slot.done ? 1 : 0);
}

export class Uploader {
  readonly #deps: UploadDeps;
  // Keyed by the shot itself: a retaken photo is a new object and starts with a fresh slot.
  readonly #slots = new WeakMap<Shot, Slot>();
  /** A submit was sent in an earlier run or attempt: its answer may have been lost on the way back. */
  #submitSent = false;

  constructor(deps: UploadDeps) {
    this.#deps = deps;
  }

  #slot(shot: Shot): Slot {
    let slot = this.#slots.get(shot);
    if (!slot) {
      slot = { target: null, stored: false, done: false };
      this.#slots.set(shot, slot);
    }
    return slot;
  }

  #retry<T>(task: (attempt: number) => Promise<T>, onRetry: (attempt: number) => void): Promise<T> {
    return withRetry(task, {
      policy: this.#deps.policy ?? UPLOAD_RETRY,
      toError: toFlowError,
      shouldRetry: isTransient,
      onRetry: (attempt) => onRetry(attempt),
      sleep: this.#deps.sleep,
      random: this.#deps.random,
    });
  }

  /** Sends `shots` (in order) and submits. Never throws: failures come back as an outcome. */
  async run(shots: readonly Shot[], listener: UploadListener): Promise<UploadOutcome> {
    const { api } = this.#deps;
    const photos = shots.length;
    const total = photos * STEPS_PER_PHOTO + 1;

    for (const [index, shot] of shots.entries()) {
      const slot = this.#slot(shot);
      const report = (phase: UploadPhase, attempt: number) =>
        listener.progress({ done: index * STEPS_PER_PHOTO + stepsDone(slot), total, phase, photo: index + 1, photos, attempt });
      let attempt = 1;
      try {
        await this.#retry(
          async (n) => {
            attempt = n;
            await this.#sendOne(shot, slot, (phase) => report(phase, attempt));
          },
          (n) => report(nextPhase(slot), n),
        );
      } catch (err) {
        return { ok: false, error: toFlowError(err).code, side: shot.side };
      }
      listener.sideDone(shot.side);
    }

    const reportSubmit = (attempt: number) =>
      listener.progress({ done: total - 1, total, phase: "submit", photo: 0, photos, attempt });
    try {
      const session = await this.#retry(async (attempt) => {
        reportSubmit(attempt);
        const sentBefore = this.#submitSent;
        this.#submitSent = true;
        try {
          return await api.submit();
        } catch (err) {
          // An earlier submit (this run, or one before the rider's "Try again") may have succeeded
          // with its answer lost on the way back.
          if (sentBefore && err instanceof FlowError && err.code === "already_submitted") {
            const current = await api.getSession();
            if (closedReason(current.status) === "already_submitted") return current;
          }
          throw err;
        }
      }, reportSubmit);
      return { ok: true, session };
    } catch (err) {
      return { ok: false, error: toFlowError(err).code, side: null };
    }
  }

  async #sendOne(shot: Shot, slot: Slot, report: (phase: UploadPhase) => void): Promise<void> {
    if (slot.done) return;
    const { api, putObject } = this.#deps;

    if (!slot.target) {
      report("link");
      slot.target = await api.uploadUrl({ kind: shot.side });
    }
    if (!slot.stored) {
      report("send");
      try {
        await putObject(slot.target, shot.blob);
      } catch (err) {
        // A refused upload token (e.g. expired) is replaced by a fresh link on the next attempt.
        if (toFlowError(err).code === "storage_failed") slot.target = null;
        throw err;
      }
      slot.stored = true;
    }
    report("check");
    try {
      await api.completeCapture({ path: slot.target.path, kind: shot.side, quality: shot.quality });
    } catch (err) {
      const code = toFlowError(err).code;
      if (code === "upload_missing") slot.stored = false;
      if (isImageRejection(code)) Object.assign(slot, { target: null, stored: false });
      throw err;
    }
    slot.done = true;
  }
}

function nextPhase(slot: Slot): UploadPhase {
  if (!slot.target) return "link";
  return slot.stored ? "check" : "send";
}

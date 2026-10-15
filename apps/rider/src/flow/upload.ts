// Sends the accepted photos and submits the case, in two calls because the server checks the photos
// in between (M3, the checking screen):
// - uploadSides(): for each side, POST /upload-url, upload straight to the private bucket, then
//   POST /captures; for the side that carries the MRZ, POST /mrz with what the phone read;
// - submit(): POST /submit.
// Each step is retried automatically with backoff, and a retry resumes where the last attempt
// stopped (no new upload link, no second upload), which matters on slow networks and keeps within
// the per-session upload-link limit.
//
// The MRZ report is best effort: it never fails the upload or holds back the submit. Staff then see
// "not received" for the code lines and check the photo themselves.
import {
  MRZ_REPORT_LIMITS,
  type CaptureSide,
  type FlowSession,
  type MrzReportRequest,
  type UploadUrlResponse,
} from "@verify/shared";
import { OCR_ASSETS, type MrzReadResult } from "../mrz/types";
import type { FlowApi } from "./api";
import { FlowError, type FlowErrorCode, isImageRejection, isTransient, toFlowError } from "./errors";
import { type Shot, type UploadPhase, type UploadProgress, closedReason } from "./machine";
import { type RetryPolicy, UPLOAD_RETRY, withRetry } from "./retry";

/** Uploads `blob` with a signed upload token; resolves when the object is stored. Throws FlowError. */
export type PutObject = (target: UploadUrlResponse, blob: Blob) => Promise<void>;

export interface UploadDeps {
  api: Pick<FlowApi, "uploadUrl" | "completeCapture" | "reportMrz" | "submit" | "getSession">;
  putObject: PutObject;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Notes an MRZ report the server refused for good (its error code only). Default: console.warn. */
  warn?: (message: string) => void;
}

export interface UploadListener {
  progress(progress: UploadProgress): void;
  sideDone(side: CaptureSide): void;
}

/** How uploadSides() ended: every photo is on the server, or the side that failed. */
export type SidesOutcome = { ok: true } | { ok: false; error: FlowErrorCode; side: CaptureSide };

/** How submit() ended. */
export type SubmitOutcome = { ok: true; session: FlowSession } | { ok: false; error: FlowErrorCode; side: null };

/** The photos the progress bar of the submit counts (it continues the bar of their upload). */
export interface SubmitSteps {
  /** uploadSteps() of the photos. */
  total: number;
  photos: number;
}

/** What already happened for one photo, kept across attempts and manual retries. */
interface Slot {
  target: UploadUrlResponse | null;
  stored: boolean;
  done: boolean;
  /** From POST /captures: the MRZ report names it, also when it is sent on a later attempt. */
  captureId: string | null;
  /** The MRZ report is settled: recorded, or refused for good. Never sent again. */
  mrzSent: boolean;
}

/** Upload link, upload, confirmation. */
export const STEPS_PER_PHOTO = 3;
/** The MRZ report: one more step for the photo that carries the MRZ. */
export const MRZ_REPORT_STEPS = 1;

/** Steps of one photo. */
export function photoSteps(shot: Shot): number {
  return STEPS_PER_PHOTO + (shot.mrz ? MRZ_REPORT_STEPS : 0);
}

/** Steps of a whole upload: every photo, then the submit. */
export function uploadSteps(shots: readonly Shot[]): number {
  return shots.reduce((sum, shot) => sum + photoSteps(shot), 0) + 1;
}

function stepsDone(shot: Shot, slot: Slot): number {
  const mrz = shot.mrz && slot.mrzSent ? 1 : 0;
  return (slot.target ? 1 : 0) + (slot.stored ? 1 : 0) + (slot.done ? 1 : 0) + mrz;
}

function clampInteger(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
}

/**
 * The report for one read: the lines whenever a complete MRZ of the expected format was read (even
 * with a wrong check digit, so staff can compare them with the photo), otherwise why nothing was.
 * The phone's own verdict is not sent: the server recomputes every check digit.
 */
export function mrzReport(read: MrzReadResult, attempt: number, captureId: string): MrzReportRequest {
  const { maxAttempts, maxCorrections, maxMs } = MRZ_REPORT_LIMITS;
  // The model that read (MRZ_MODELS): test sessions read with our own, so the server records which.
  const base = { captureId, attempts: clampInteger(attempt, 1, maxAttempts), engine: read.engine || OCR_ASSETS.engine };
  if (read.lines && (read.status === "valid" || read.status === "invalid")) {
    return {
      ...base,
      result: "read",
      lines: [...read.lines],
      corrections: clampInteger(read.corrections, 0, maxCorrections),
      ms: clampInteger(read.ms, 0, maxMs),
    };
  }
  return { ...base, result: "unreadable", reason: read.status === "unavailable" ? "reader_unavailable" : "not_found" };
}

export class Uploader {
  readonly #deps: UploadDeps;
  // Keyed by the shot itself: a retaken photo is a new object and starts with a fresh slot.
  readonly #slots = new WeakMap<Shot, Slot>();
  /** Photos whose MRZ report failed on a network or server error: tried again before the submit. */
  readonly #unreported = new Set<Shot>();
  /**
   * Reports tried since the rider last acted ("Use this photo", "Try again"): each gets one round of
   * retries per action, so a failing report does not hold back the submit that follows its photo.
   */
  #tried = new Set<Shot>();
  /** A submit was sent in an earlier call or attempt: its answer may have been lost on the way back. */
  #submitSent = false;

  constructor(deps: UploadDeps) {
    this.#deps = deps;
  }

  #slot(shot: Shot): Slot {
    let slot = this.#slots.get(shot);
    if (!slot) {
      slot = { target: null, stored: false, done: false, captureId: null, mrzSent: false };
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

  /**
   * Sends `shots` (in order): each photo, then the MRZ report of the side that carries the code
   * lines. Never throws: failures come back as an outcome. The submit is a separate call (submit()),
   * made once the server has checked the photos.
   */
  async uploadSides(shots: readonly Shot[], listener: UploadListener): Promise<SidesOutcome> {
    const photos = shots.length;
    const total = uploadSteps(shots);
    this.#tried = new Set();
    // A report not yet sent for an earlier photo of a side sent again now is moot: the server erases
    // that photo, and the data read from it, when the new one arrives.
    for (const old of this.#unreported) {
      if (shots.some((shot) => shot.side === old.side && shot !== old)) this.#unreported.delete(old);
    }

    let before = 0;
    for (const [index, shot] of shots.entries()) {
      const slot = this.#slot(shot);
      const first = before;
      before += photoSteps(shot);
      const report = (phase: UploadPhase, attempt: number) =>
        listener.progress({ done: first + stepsDone(shot, slot), total, phase, photo: index + 1, photos, attempt });
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
      if (shot.mrz && !slot.mrzSent) {
        this.#tried.add(shot);
        report("check", 1);
        await this.#reportMrz(shot, slot, (n) => report("check", n));
      }
    }
    return { ok: true };
  }

  /**
   * Submits the case, after one more round for MRZ reports that failed on a network or server error
   * (the photo itself is already on the server), except those tried since the rider last acted.
   * `steps` places the submit at the end of the photos' progress bar. Never throws.
   */
  async submit(listener: UploadListener, steps: SubmitSteps = { total: 1, photos: 0 }): Promise<SubmitOutcome> {
    const { api } = this.#deps;
    const { total, photos } = steps;
    const reportSubmit = (attempt: number) =>
      listener.progress({ done: total - 1, total, phase: "submit", photo: 0, photos, attempt });

    const tried = this.#tried;
    // The rider's next "Try again" gives every report still missing another round.
    this.#tried = new Set();
    for (const shot of [...this.#unreported]) {
      if (tried.has(shot)) continue;
      reportSubmit(1);
      await this.#reportMrz(shot, this.#slot(shot), reportSubmit);
    }

    try {
      const session = await this.#retry(async (attempt) => {
        reportSubmit(attempt);
        const sentBefore = this.#submitSent;
        this.#submitSent = true;
        try {
          return await api.submit();
        } catch (err) {
          // An earlier submit (this call, or one before the rider's "Try again") may have succeeded
          // with its answer lost on the way back.
          if (sentBefore && err instanceof FlowError && err.code === "already_submitted") {
            const current = await api.getSession();
            if (closedReason(current.status) === "already_submitted") return current;
          }
          throw err;
        }
      }, reportSubmit);
      // Submitted: a report still missing stays missing (staff see "not received").
      this.#unreported.clear();
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
      const { captureId } = await api.completeCapture({ path: slot.target.path, kind: shot.side, quality: shot.quality });
      slot.captureId = captureId;
    } catch (err) {
      const code = toFlowError(err).code;
      if (code === "upload_missing") slot.stored = false;
      if (isImageRejection(code)) Object.assign(slot, { target: null, stored: false });
      throw err;
    }
    slot.done = true;
  }

  /**
   * Sends the MRZ report of an uploaded photo. Never throws: a network or server error leaves it for
   * the next run; a lasting refusal (4xx) is noted and dropped, since sending it again cannot help.
   */
  async #reportMrz(shot: Shot, slot: Slot, onRetry: (attempt: number) => void): Promise<void> {
    if (!shot.mrz || slot.mrzSent || !slot.captureId) return;
    const body = mrzReport(shot.mrz, shot.mrzAttempt ?? 1, slot.captureId);
    try {
      await this.#retry(() => this.#deps.api.reportMrz(body), onRetry);
      slot.mrzSent = true;
      this.#unreported.delete(shot);
    } catch (err) {
      const error = toFlowError(err);
      if (isTransient(error)) {
        this.#unreported.add(shot);
        return;
      }
      slot.mrzSent = true;
      this.#unreported.delete(shot);
      // The code only: the lines themselves are never logged.
      (this.#deps.warn ?? console.warn)(`MRZ report not recorded: ${error.code}`);
    }
  }
}

function nextPhase(slot: Slot): UploadPhase {
  if (!slot.target) return "link";
  return slot.stored ? "check" : "send";
}

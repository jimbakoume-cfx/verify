// The rider flow as a pure reducer: which screen is shown and what the rider has done so far.
// Side effects (API calls, camera, uploads) live in useFlow.ts and report back through actions.
import {
  MRZ_EXPECTATION,
  MRZ_TRIES_BEFORE_OVERRIDE,
  REQUIRED_SIDES,
  RETAKE_REASONS,
  SERVER_RETAKES_PER_SIDE,
  type CaptureSide,
  type ClientQuality,
  type DeclaredDocument,
  type FlowChecks,
  type FlowSession,
  type FlowStatus,
  type MrzExpectation,
  type MrzFormat,
  type RetakeReason,
} from "@verify/shared";
import type { GrayImage, Hint } from "@verify/capture";
import { unavailableRead } from "../mrz/lazyReader";
import { type MrzReadResult, mrzModelFor } from "../mrz/types";
import { type FlowErrorCode, type SessionErrorReason, isImageRejection, sessionErrorReason } from "./errors";

/** How the final photo was encoded (shown in the debug panel). */
export interface StillInfo {
  width: number;
  height: number;
  bytes: number;
  jpegQuality: number;
  scale: number;
  attempts: number;
}

/** One photo, taken and compressed, waiting for review or upload. */
export interface Shot {
  side: CaptureSide;
  /** JPEG drawn from a canvas: no EXIF or GPS data. */
  blob: Blob;
  quality: ClientQuality;
  /** Hints from re-checking the still itself. */
  hints: readonly Hint[];
  /** Long side under the server's minimum: the server would refuse it. */
  lowResolution: boolean;
  info: StillInfo;
  /**
   * Full-resolution grayscale copy of the still, made before JPEG compression, for reading the MRZ
   * (its characters are only about 15 px tall on a passport held upright). Only on the side that
   * carries the MRZ, and only until it has been read: phones have little memory to spare.
   */
  gray?: GrayImage | null;
  /** What was read on the side that carries the MRZ (set when the reading screen finishes). */
  mrz?: MrzReadResult;
  /** Reads of this side so far, this one included (sent as MrzReportRequest.attempts). */
  mrzAttempt?: number;
}

/** Problems that make a manual photo unusable (spec: sharpness or glare). */
const REFUSING_HINTS: readonly Hint[] = ["blurry", "glare"];

/** A manual photo that failed the sharpness or glare check is refused: the rider is asked to retake. */
export function refusalHints(shot: Shot): Hint[] {
  return shot.quality.source === "manual" ? shot.hints.filter((h) => REFUSING_HINTS.includes(h)) : [];
}

/**
 * After this many refused photos of one side, the rider may keep the photo anyway: the thresholds
 * are not yet tuned on real phones, and a rider must never be stuck in a retake loop.
 */
export const REFUSALS_BEFORE_OVERRIDE = 2;

/** Where `document` carries its MRZ when `side` is that side; null for every other side. */
export function mrzExpectationFor(document: DeclaredDocument | null, side: CaptureSide): MrzExpectation | null {
  const expectation = document ? MRZ_EXPECTATION[document] : null;
  return expectation && expectation.side === side ? expectation : null;
}

/** A read that asks for a retake: no complete MRZ, or a wrong check digit. "unavailable" never does. */
function isFailedRead(result: MrzReadResult): boolean {
  return result.status === "invalid" || result.status === "not_found";
}

export type Screen =
  | { name: "welcome" }
  | { name: "consent" }
  | { name: "declined" }
  | { name: "document" }
  | { name: "capture"; side: CaptureSide }
  | { name: "turnOver"; side: CaptureSide }
  /** Reading the MRZ of the photo just taken (the side that carries it), before its review. */
  | { name: "reading"; side: CaptureSide }
  | { name: "review"; side: CaptureSide }
  | { name: "upload" }
  /**
   * The end of the flow, before the submit: the server's checks of the photos (M3), shown as "Checking
   * your ID…" (the same as the result's wait). Since the PM's first real test the rider goes from the
   * photos straight to the face check, so this comes after it, and only here is a retake or an expired
   * document (M4) shown.
   */
  | { name: "checking" }
  /**
   * M5: the face check (front camera, a random challenge), right after the photos (PM, 2026-10-20: "ID
   * and face steps all at once"): the photos upload and are checked meanwhile.
   */
  | { name: "liveness" }
  /** Automatic approval: after the submit, "your ID is verified", "we're checking a few details", or waiting. */
  | { name: "result" }
  | { name: "done" }
  | { name: "sessionError"; reason: SessionErrorReason };

export type UploadPhase = "link" | "send" | "check" | "submit";

export interface UploadProgress {
  /** Steps finished out of `total` (three per photo, plus the final submit). */
  done: number;
  total: number;
  phase: UploadPhase;
  /** 1-based position of the photo being sent; 0 while submitting. */
  photo: number;
  photos: number;
  /** Current try of the running step (1 = first). */
  attempt: number;
}

export interface UploadState {
  /** queued: waiting for useFlow to start it; failed: waiting for the rider's "Try again". */
  status: "idle" | "queued" | "running" | "failed";
  /**
   * sides: send the photos not yet on the server, then wait for its checks (the checking screen).
   * submit: the checks are over (passed, timed out or unavailable): only the submit is left.
   */
  stage: "sides" | "submit";
  progress: UploadProgress | null;
}

/** A side the server asks the rider to photograph again (GET /flow/checks), and why. */
export interface ServerRetake {
  side: CaptureSide;
  reason: RetakeReason;
}

/**
 * The result screen (automatic approval). pending: waiting for GET /flow/result. verified: "Your ID is
 * verified" and "Continue". review: "We're checking a few details, we'll let you know" (also when the
 * wait times out or fails). leaving: "Continue" pressed with a return address: the app goes there.
 */
export interface ResultState {
  state: "pending" | "verified" | "review";
  /** An https address, with "verified" only. */
  returnUrl: string | null;
  leaving: boolean;
}

export interface FlowState {
  session: FlowSession | null;
  /** GET /session on the welcome screen. "none": the page was opened without a link. */
  load: "none" | "loading" | "ready" | "failed";
  screen: Screen;
  /** A consent or document request is in flight. */
  busy: boolean;
  /** Shown on the current screen until the next action. */
  error: FlowErrorCode | null;
  document: DeclaredDocument | null;
  sides: readonly CaptureSide[];
  shots: Partial<Record<CaptureSide, Shot>>;
  /** Sides whose current shot the server has accepted. */
  uploaded: Partial<Record<CaptureSide, true>>;
  upload: UploadState;
  /** Manual photos refused per side. */
  refusals: Partial<Record<CaptureSide, number>>;
  /** MRZ reads per side, whatever their outcome. Reset when the document changes. */
  mrzReads: Partial<Record<CaptureSide, number>>;
  /**
   * Failed reads of a required MRZ per side (invalid or not found). After MRZ_TRIES_BEFORE_OVERRIDE
   * the rider may continue anyway (the server flags the case). Reset when the document changes.
   */
  mrzFailures: Partial<Record<CaptureSide, number>>;
  /** First-use download progress of the reader (0..1) on the reading screen; null when not reported. */
  readProgress: number | null;
  /**
   * Retakes the server asked for, per side (at most SERVER_RETAKES_PER_SIDE). Kept for the whole
   * session, even when the document changes: the server counts them per side for the whole case too.
   */
  serverRetakes: Partial<Record<CaptureSide, number>>;
  /** Why the server asked for a new photo of a side: shown on the way to its camera until it is taken. */
  retakeReasons: Partial<Record<CaptureSide, RetakeReason>>;
  /**
   * M4, on the checking screen: the server found the document expired (its code lines). shown: the
   * rider is asked to use another document or to continue anyway. accepted: "Continue anyway"; never
   * asked again for these photos.
   */
  expiredNotice: "none" | "shown" | "accepted";
  /**
   * M5: the server recorded this visit's face check. Kept when the document changes (the face does
   * not), so "Use another document" does not ask for it again.
   */
  livenessDone: boolean;
  /** Automatic approval: the result after the submit. */
  result: ResultState;
  /**
   * An upload of the photos that failed while the rider did the face check (they upload in the
   * background meanwhile): shown once the face check is done, never in the middle of it.
   */
  deferredUploadError: { error: FlowErrorCode; side: CaptureSide | null } | null;
}

export type FlowAction =
  | { type: "session/loading" }
  | { type: "session/loaded"; session: FlowSession }
  | { type: "session/failed"; error: FlowErrorCode }
  | { type: "start" }
  | { type: "consent/decline" }
  | { type: "consent/review" }
  | { type: "request/start" }
  | { type: "request/failed"; error: FlowErrorCode }
  | { type: "consent/accepted"; session: FlowSession }
  | { type: "document/chosen"; session: FlowSession }
  | { type: "document/change" }
  | { type: "capture/taken"; shot: Shot }
  /** From the reader, for `shot`: ignored unless `shot` is still the photo being read. */
  | { type: "mrz/progress"; shot: Shot; progress: number }
  | { type: "mrz/read"; shot: Shot; result: MrzReadResult }
  | { type: "review/retake" }
  | { type: "review/accept" }
  | { type: "turnOver/ready" }
  | { type: "upload/started"; progress: UploadProgress }
  | { type: "upload/progress"; progress: UploadProgress }
  | { type: "upload/sideDone"; side: CaptureSide }
  /** Every photo is on the server: wait for its checks before submitting. */
  | { type: "upload/sent" }
  | { type: "upload/failed"; error: FlowErrorCode; side: CaptureSide | null }
  | { type: "upload/retry" }
  | { type: "upload/submitted"; session: FlowSession }
  /** The server's checks are over and no photo is to be retaken (each side ok or unchecked): submit. */
  | { type: "checks/ok" }
  /**
   * The server found these photos unusable. Only the sides it may still ask for are retaken
   * (acceptsServerRetake); when none is left, this is the same as "checks/ok".
   */
  | { type: "checks/retake"; sides: readonly ServerRetake[] }
  /** No answer within CHECKS_WAIT_MS, or the checks could not be read: submit, with no error shown. */
  | { type: "checks/timeout" }
  /** M4: the server says the document has expired: the waiting stops and the rider chooses. */
  | { type: "checks/expired" }
  /** "Use another document": back to the document list; every photo of this document is dropped. */
  | { type: "expired/another" }
  /** "Continue anyway": the checks go on as usual, then the case is submitted (staff see the flag). */
  | { type: "expired/continue" }
  /** M5: the server recorded the face check: on to the submit. */
  | { type: "liveness/done" }
  /** M5: the face check met an error that ends the session (expired link...); other errors stay on its screen. */
  | { type: "liveness/failed"; error: FlowErrorCode }
  | { type: "error/dismiss" }
  /** Automatic approval: GET /flow/result settled. */
  | { type: "result/answer"; state: "verified" | "review"; returnUrl: string | null }
  /** No settled answer within RESULT_WAIT_MS, or the result could not be read: shown as a review. */
  | { type: "result/timeout" }
  /** "Continue" on "Your ID is verified": to the return address when there is one, else the end screen. */
  | { type: "result/continue" }
  /** The phone's Back button or gesture (see useFlow). */
  | { type: "nav/back" };

const IDLE_UPLOAD: UploadState = { status: "idle", stage: "sides", progress: null };
const PENDING_RESULT: ResultState = { state: "pending", returnUrl: null, leaving: false };

export function initialFlowState(boot: { hasToken: boolean; invalidLink: boolean }): FlowState {
  return {
    session: null,
    load: boot.hasToken ? "loading" : "none",
    screen: boot.invalidLink ? { name: "sessionError", reason: "invalid" } : { name: "welcome" },
    busy: false,
    error: null,
    document: null,
    sides: [],
    shots: {},
    uploaded: {},
    upload: IDLE_UPLOAD,
    refusals: {},
    mrzReads: {},
    mrzFailures: {},
    readProgress: null,
    serverRetakes: {},
    retakeReasons: {},
    expiredNotice: "none",
    livenessDone: false,
    result: PENDING_RESULT,
    deferredUploadError: null,
  };
}

const OPEN_STATUSES: readonly FlowStatus[] = ["created", "in_progress"];

/** Why a session can no longer be used, from its status; null while it is open. */
export function closedReason(status: FlowStatus): SessionErrorReason | null {
  if (OPEN_STATUSES.includes(status)) return null;
  if (status === "expired") return "expired";
  if (status === "cancelled") return "invalid";
  return "already_submitted";
}

function without<T extends object, K extends keyof T>(record: T, key: K): T {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function sessionError(state: FlowState, reason: SessionErrorReason): FlowState {
  return { ...state, busy: false, error: null, upload: IDLE_UPLOAD, screen: { name: "sessionError", reason } };
}

/** Routes an error: a dead session ends the flow; a step done out of order sends the rider back to it. */
function fail(state: FlowState, error: FlowErrorCode): FlowState {
  const reason = sessionErrorReason(error);
  if (reason) return sessionError(state, reason);
  const settled = { ...state, busy: false, error };
  if (error === "consent_required") return { ...settled, screen: { name: "consent" } };
  if (error === "document_type_required" || error === "invalid_kind") {
    return { ...settled, upload: IDLE_UPLOAD, screen: { name: "document" } };
  }
  return settled;
}

/** Whether `shot` is the photo on the reading screen: a reader's result for any other is stale. */
function isBeingRead(state: FlowState, shot: Shot): boolean {
  const { screen } = state;
  return screen.name === "reading" && screen.side === shot.side && state.shots[shot.side] === shot;
}

/**
 * Keeps what was read with the photo, drops its grayscale copy, counts the try, and shows the
 * review. Only a required MRZ counts failed tries (an optional one never asks for a retake).
 */
function recordRead(state: FlowState, shot: Shot, result: MrzReadResult): FlowState {
  const { side } = shot;
  const reads = (state.mrzReads[side] ?? 0) + 1;
  const failed = mrzExpectationFor(state.document, side)?.required === true && isFailedRead(result);
  return {
    ...state,
    shots: { ...state.shots, [side]: { ...shot, gray: null, mrz: result, mrzAttempt: reads } },
    mrzReads: { ...state.mrzReads, [side]: reads },
    mrzFailures: failed ? { ...state.mrzFailures, [side]: (state.mrzFailures[side] ?? 0) + 1 } : state.mrzFailures,
    readProgress: null,
    screen: { name: "review", side },
  };
}

/** The screen that captures `side`: the back is preceded by a "turn the card over" step. */
function captureStep(side: CaptureSide, fromReview: boolean): Screen {
  return side === "document_back" && fromReview ? { name: "turnOver", side } : { name: "capture", side };
}

/**
 * After the checks: the face check (M5) unless it is already recorded, then the submit (shown as the
 * result's wait, "Checking your ID…").
 */
function queueSubmit(state: FlowState): FlowState {
  if (!state.livenessDone) return { ...state, error: null, upload: IDLE_UPLOAD, screen: { name: "liveness" } };
  return {
    ...state,
    error: null,
    screen: { name: "upload" },
    upload: { status: "queued", stage: "submit", progress: null },
  };
}

/**
 * Drops the photos the server asked for again (from the phone and from what counts as sent), counts
 * the retakes, and opens the camera of the first of them, through "turn over" for the back. The
 * other sides keep their photos, already on the server.
 */
function retakeSides(state: FlowState, retakes: readonly ServerRetake[]): FlowState {
  let { shots, uploaded, serverRetakes, retakeReasons } = state;
  for (const { side, reason } of retakes) {
    shots = without(shots, side);
    uploaded = without(uploaded, side);
    serverRetakes = { ...serverRetakes, [side]: (serverRetakes[side] ?? 0) + 1 };
    retakeReasons = { ...retakeReasons, [side]: reason };
  }
  const first = state.sides.find((side) => retakes.some((retake) => retake.side === side)) ?? retakes[0].side;
  return {
    ...state,
    error: null,
    shots,
    uploaded,
    serverRetakes,
    retakeReasons,
    upload: IDLE_UPLOAD,
    screen: captureStep(first, true),
  };
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "session/loading":
      return { ...state, load: "loading", error: null };

    case "session/loaded": {
      const reason = closedReason(action.session.status);
      const next = { ...state, session: action.session, load: "ready" as const, error: null };
      return reason ? sessionError(next, reason) : next;
    }

    case "session/failed":
      return fail({ ...state, load: "failed" }, action.error);

    case "start":
      if (state.load !== "ready" || !state.session || state.screen.name !== "welcome") return state;
      return { ...state, error: null, screen: { name: state.session.consentGiven ? "document" : "consent" } };

    case "consent/decline":
      return { ...state, error: null, screen: { name: "declined" } };

    case "consent/review":
      return { ...state, error: null, screen: { name: "consent" } };

    case "request/start":
      return { ...state, busy: true, error: null };

    case "request/failed":
      return fail(state, action.error);

    case "consent/accepted":
      return { ...state, busy: false, error: null, session: action.session, screen: { name: "document" } };

    case "document/chosen": {
      const document = action.session.declaredDocument;
      if (!document) return fail(state, "unexpected");
      const sides = action.session.requiredSides ?? REQUIRED_SIDES[document];
      if (sides.length === 0) return fail(state, "unexpected");
      if (document === state.document && state.sides.length > 0) {
        // The same document again (the rider went back to the list): keep the photos taken.
        const next = state.sides.find((side) => !state.shots[side]) ?? state.sides[0];
        return {
          ...state,
          busy: false,
          error: null,
          session: action.session,
          screen: captureStep(next, next !== state.sides[0]),
        };
      }
      // A new choice starts the photos over: the previous ones may not fit the new document.
      return {
        ...state,
        expiredNotice: "none",
        busy: false,
        error: null,
        session: action.session,
        document,
        sides: [...sides],
        shots: {},
        uploaded: {},
        refusals: {},
        // The tries belong to the document: another one starts with none.
        mrzReads: {},
        mrzFailures: {},
        readProgress: null,
        retakeReasons: {},
        upload: IDLE_UPLOAD,
        screen: { name: "capture", side: sides[0] },
      };
    }

    case "document/change":
      if (state.screen.name !== "capture" && state.screen.name !== "review") return state;
      return { ...state, error: null, screen: { name: "document" } };

    case "capture/taken": {
      const { shot } = action;
      if (state.screen.name !== "capture" || state.screen.side !== shot.side) return state;
      const refused = refusalHints(shot).length > 0;
      const taken: FlowState = {
        ...state,
        error: null,
        uploaded: without(state.uploaded, shot.side),
        // A new photo of a side the server asked for: its reason has been seen.
        retakeReasons: without(state.retakeReasons, shot.side),
        refusals: refused ? { ...state.refusals, [shot.side]: (state.refusals[shot.side] ?? 0) + 1 } : state.refusals,
        readProgress: null,
      };
      const expectation = mrzExpectationFor(state.document, shot.side);
      // A photo under the server's minimum can only be retaken: reading it would waste the rider's time.
      if (expectation && !shot.lowResolution) {
        if (shot.gray) {
          return { ...taken, shots: { ...taken.shots, [shot.side]: shot }, screen: { name: "reading", side: shot.side } };
        }
        // No grayscale copy (the phone could not spare the memory): nothing to read, which never blocks.
        const model = mrzModelFor(state.session?.isTest === true);
        return recordRead(taken, shot, unavailableRead(expectation.format, model.engine));
      }
      const kept = shot.gray ? { ...shot, gray: null } : shot;
      return { ...taken, shots: { ...taken.shots, [shot.side]: kept }, screen: { name: "review", side: shot.side } };
    }

    case "mrz/progress": {
      if (!isBeingRead(state, action.shot) || !Number.isFinite(action.progress)) return state;
      const progress = Math.round(Math.min(1, Math.max(0, action.progress)) * 100) / 100;
      return progress === state.readProgress ? state : { ...state, readProgress: progress };
    }

    case "mrz/read":
      if (!isBeingRead(state, action.shot)) return state;
      return recordRead(state, action.shot, action.result);

    case "review/retake": {
      if (state.screen.name !== "review") return state;
      const { side } = state.screen;
      return { ...state, error: null, shots: without(state.shots, side), screen: { name: "capture", side } };
    }

    case "review/accept": {
      if (state.screen.name !== "review") return state;
      const shot = state.shots[state.screen.side];
      if (!shot || !canUseShot(state, shot)) return state;
      const next = state.sides.find((side) => !state.shots[side]);
      if (next) return { ...state, error: null, screen: captureStep(next, true) };
      const queued: UploadState = { status: "queued", stage: "sides", progress: null };
      // "ID and face steps all at once" (PM, 2026-10-20): straight to the face check while the photos
      // upload and the server checks them; after a retake (the face check already done), the upload screen.
      if (!state.livenessDone) {
        return { ...state, error: null, deferredUploadError: null, screen: { name: "liveness" }, upload: queued };
      }
      return { ...state, error: null, screen: { name: "upload" }, upload: queued };
    }

    case "turnOver/ready":
      if (state.screen.name !== "turnOver") return state;
      return { ...state, screen: { name: "capture", side: state.screen.side } };

    case "upload/started":
      if (state.upload.status !== "queued") return state;
      return { ...state, error: null, upload: { ...state.upload, status: "running", progress: action.progress } };

    case "upload/progress":
      if (state.upload.status !== "running") return state;
      return { ...state, upload: { ...state.upload, progress: action.progress } };

    case "upload/sideDone":
      return { ...state, uploaded: { ...state.uploaded, [action.side]: true } };

    case "upload/sent":
      if (state.upload.status !== "running" || state.upload.stage !== "sides") return state;
      // During the face check the rider stays on it; the checks are read once it is done.
      if (state.screen.name === "liveness") return { ...state, upload: IDLE_UPLOAD };
      return { ...state, error: null, upload: IDLE_UPLOAD, screen: state.livenessDone ? { name: "checking" } : { name: "liveness" } };

    case "upload/failed": {
      const { error, side } = action;
      if (state.screen.name === "liveness" && !sessionErrorReason(error) && error !== "missing_sides" && error !== "liveness_required") {
        // Never in the middle of the face check: kept for when it is done (liveness/done). A refused
        // photo is dropped at once (it is taken again then); any other failure waits for "Try again".
        const refused = side !== null && isImageRejection(error);
        return {
          ...state,
          deferredUploadError: { error, side },
          shots: refused ? without(state.shots, side) : state.shots,
          uploaded: refused ? without(state.uploaded, side) : state.uploaded,
          upload: refused ? IDLE_UPLOAD : { ...state.upload, status: "failed" },
        };
      }
      if (side && isImageRejection(error)) {
        // The server refused (and deleted) this photo: take it again, then upload what is left.
        return {
          ...state,
          error,
          shots: without(state.shots, side),
          uploaded: without(state.uploaded, side),
          upload: IDLE_UPLOAD,
          screen: { name: "capture", side },
        };
      }
      if (error === "liveness_required") {
        // The server has no face check for this session (e.g. its frames were replaced): do it again.
        return { ...state, error, livenessDone: false, upload: IDLE_UPLOAD, screen: { name: "liveness" } };
      }
      if (error === "missing_sides") {
        const first = state.sides[0];
        if (!first) return fail(state, error);
        return {
          ...state,
          error,
          shots: {},
          uploaded: {},
          retakeReasons: {},
          upload: IDLE_UPLOAD,
          screen: { name: "capture", side: first },
        };
      }
      return fail({ ...state, upload: { ...state.upload, status: "failed" } }, error);
    }

    case "upload/retry":
      // The same stage again: photos still to send, or only the submit once the checks are over.
      if (state.upload.status !== "failed") return state;
      return { ...state, error: null, upload: { ...state.upload, status: "queued", progress: null } };

    case "upload/submitted":
      // Automatic approval: the result screen asks the server whether the ID is verified.
      return {
        ...state,
        error: null,
        session: action.session,
        upload: IDLE_UPLOAD,
        result: PENDING_RESULT,
        screen: { name: "result" },
      };

    case "result/answer":
      if (state.screen.name !== "result" || state.result.state !== "pending") return state;
      return {
        ...state,
        result: { state: action.state, returnUrl: action.state === "verified" ? action.returnUrl : null, leaving: false },
      };

    case "result/timeout":
      if (state.screen.name !== "result" || state.result.state !== "pending") return state;
      return { ...state, result: { ...PENDING_RESULT, state: "review" } };

    case "result/continue":
      if (state.screen.name !== "result" || state.result.state !== "verified" || state.result.leaving) return state;
      // With a return address useFlow takes the rider there; without one, the end screen.
      return state.result.returnUrl ? { ...state, result: { ...state.result, leaving: true } } : { ...state, screen: { name: "done" } };

    case "checks/ok":
    case "checks/timeout":
      if (state.screen.name !== "checking") return state;
      return queueSubmit(state);

    case "checks/expired":
      if (state.screen.name !== "checking" || state.expiredNotice !== "none") return state;
      return { ...state, error: null, expiredNotice: "shown" };

    case "expired/continue":
      if (state.screen.name !== "checking" || state.expiredNotice !== "shown") return state;
      return { ...state, error: null, expiredNotice: "accepted" };

    case "expired/another":
      if (state.screen.name !== "checking" || state.expiredNotice !== "shown") return state;
      // Whatever is chosen next, the same type included, starts with new photos, which replace these
      // on the server. The server's retakes stay counted per side, as the server counts them.
      return {
        ...state,
        error: null,
        document: null,
        sides: [],
        shots: {},
        uploaded: {},
        refusals: {},
        mrzReads: {},
        mrzFailures: {},
        readProgress: null,
        retakeReasons: {},
        expiredNotice: "none",
        upload: IDLE_UPLOAD,
        screen: { name: "document" },
      };

    case "checks/retake": {
      if (state.screen.name !== "checking") return state;
      const retakes = state.sides.flatMap((side) => {
        const asked = action.sides.find((retake) => retake.side === side);
        return asked && isRetakeReason(asked.reason) && acceptsServerRetake(state, side) ? [asked] : [];
      });
      // Nothing the rider may still be asked for: the photos go as they are (staff review them).
      return retakes.length > 0 ? retakeSides(state, retakes) : queueSubmit(state);
    }

    case "liveness/done": {
      if (state.screen.name !== "liveness") return state;
      const done: FlowState = { ...state, livenessDone: true, deferredUploadError: null };
      const deferred = state.deferredUploadError;
      if (deferred?.side && isImageRejection(deferred.error)) {
        // A photo the server refused while the face check ran: take it again now.
        return { ...done, error: deferred.error, upload: IDLE_UPLOAD, screen: { name: "capture", side: deferred.side } };
      }
      if (state.upload.status === "failed") {
        // The photos could not be sent: "Try again" on the upload screen, then the checks.
        return { ...done, error: deferred?.error ?? state.error, screen: { name: "upload" } };
      }
      // The checks (the photos may still be uploading: the wait starts once they are sent).
      return { ...done, error: null, screen: { name: "checking" } };
    }

    case "liveness/failed":
      if (state.screen.name !== "liveness" || !sessionErrorReason(action.error)) return state;
      return fail(state, action.error);

    case "error/dismiss":
      return { ...state, error: null };

    case "nav/back":
      return back(state);
  }
}

/**
 * One step back, as the phone's Back button should feel: from a photo's review (or its reading) to
 * its camera, from the back's camera to the "turn over" step, from there to the front's review, and
 * from the first camera to the document list. Consent and the document list are not stepped back
 * to from later screens by this (consent is already recorded); during an upload and while the
 * server checks the photos, Back does nothing. Other screens return the same state: the browser
 * may leave the page.
 */
function back(state: FlowState): FlowState {
  const { screen } = state;
  switch (screen.name) {
    case "review":
      return flowReducer(state, { type: "review/retake" });
    case "reading":
      // useFlow aborts the read when this screen goes away.
      return {
        ...state,
        error: null,
        shots: without(state.shots, screen.side),
        readProgress: null,
        screen: { name: "capture", side: screen.side },
      };
    case "capture": {
      const index = state.sides.indexOf(screen.side);
      if (index <= 0) return flowReducer(state, { type: "document/change" });
      return { ...state, error: null, screen: { name: "turnOver", side: screen.side } };
    }
    case "turnOver": {
      const previous = state.sides[state.sides.indexOf(screen.side) - 1];
      if (!previous) return state;
      return {
        ...state,
        error: null,
        screen: state.shots[previous] ? { name: "review", side: previous } : { name: "capture", side: previous },
      };
    }
    case "declined":
      return flowReducer(state, { type: "consent/review" });
    default:
      return state;
  }
}

/** Screens where the phone's Back button is handled by the flow rather than leaving the page. */
export function handlesBack(screen: Screen): boolean {
  return (
    screen.name === "capture" ||
    screen.name === "turnOver" ||
    screen.name === "reading" ||
    screen.name === "review" ||
    screen.name === "upload" ||
    screen.name === "checking" ||
    screen.name === "liveness"
  );
}

/** What the review screen says about the MRZ ("code lines") of a photo. */
export type MrzReview =
  /** Read, every check digit right: the rider sees "Code lines read ✓". */
  | { status: "read" }
  /**
   * A required MRZ was not read: tips and Retake. `canContinue` once MRZ_TRIES_BEFORE_OVERRIDE
   * tries have failed on this side ("Continue anyway"; the server flags the case).
   */
  | { status: "unread"; format: MrzFormat; canContinue: boolean };

type ReviewState = Pick<FlowState, "refusals" | "document" | "mrzFailures">;

/**
 * The MRZ verdict for `shot`; null when there is nothing to say: no MRZ on this side, the reader
 * could not run ("unavailable" never blocks), or an optional MRZ was not read.
 */
export function mrzReview(state: Pick<FlowState, "document" | "mrzFailures">, shot: Shot): MrzReview | null {
  const expectation = mrzExpectationFor(state.document, shot.side);
  const result = shot.mrz;
  if (!expectation || !result) return null;
  if (result.status === "valid") return { status: "read" };
  if (!expectation.required || !isFailedRead(result)) return null;
  const failures = state.mrzFailures[shot.side] ?? 0;
  return { status: "unread", format: expectation.format, canContinue: failures >= MRZ_TRIES_BEFORE_OVERRIDE };
}

/**
 * Whether "Use this photo" is offered for `shot`: never for a photo under the server's minimum
 * resolution (the server would refuse it every time, so overriding cannot help). Otherwise both
 * checks must allow it: a blurry or glary manual photo only after repeated refusals, and a required
 * MRZ that was not read only after repeated tries.
 */
export function canUseShot(state: ReviewState, shot: Shot): boolean {
  if (shot.lowResolution) return false;
  const quality = refusalHints(shot).length === 0 || (state.refusals[shot.side] ?? 0) >= REFUSALS_BEFORE_OVERRIDE;
  const mrz = mrzReview(state, shot);
  return quality && (mrz?.status !== "unread" || mrz.canContinue);
}

/** Shots still to send, in capture order. */
export function pendingShots(state: Pick<FlowState, "sides" | "shots" | "uploaded">): Shot[] {
  return state.sides.flatMap((side) => {
    const shot = state.shots[side];
    return shot && !state.uploaded[side] ? [shot] : [];
  });
}

/** The photo of each side, in capture order (the sides photographed so far). */
export function sideShots(state: Pick<FlowState, "sides" | "shots">): Shot[] {
  return state.sides.flatMap((side) => {
    const shot = state.shots[side];
    return shot ? [shot] : [];
  });
}

function isRetakeReason(value: unknown): value is RetakeReason {
  return (RETAKE_REASONS as readonly unknown[]).includes(value);
}

/**
 * The rider kept this photo despite a warning on the phone: "Use it anyway" on a blurry or glary
 * photo, or "Continue anyway" when the code lines could not be read. (Only such a photo can carry
 * these warnings once accepted.)
 */
export function usedOverride(state: Pick<FlowState, "document" | "mrzFailures">, shot: Shot): boolean {
  return refusalHints(shot).length > 0 || mrzReview(state, shot)?.status === "unread";
}

/**
 * Whether the server may still have the rider retake the photo sent for `side`: at most
 * SERVER_RETAKES_PER_SIDE times per side, never after the rider overrode a warning on that photo
 * (asking again would loop: the phone already tried), and never when the phone read its code lines
 * with every check digit right (the photo is readable, whatever the server's reader made of it).
 */
export function acceptsServerRetake(state: FlowState, side: CaptureSide): boolean {
  const shot = state.shots[side];
  if (!shot || !state.uploaded[side]) return false;
  if ((state.serverRetakes[side] ?? 0) >= SERVER_RETAKES_PER_SIDE) return false;
  return !usedOverride(state, shot) && shot.mrz?.status !== "valid";
}

/** What an answer of GET /flow/checks leads to; see checksDecision. */
export type ChecksDecision = Extract<FlowAction, { type: "checks/ok" | "checks/retake" | "checks/expired" }>;

/**
 * What an answer of GET /flow/checks means on the checking screen: an expired document first (M4:
 * there is no point retaking a photo of it), unless the rider chose to continue anyway; then retake
 * the sides the server found unusable that the rider may still be asked for, at once, even while
 * other sides are pending (that photo must be taken again anyway, and the others are checked
 * meanwhile); submit once no side is pending; otherwise null, to ask again. A "retake" the rider may
 * not be asked for counts as ok.
 */
export function checksDecision(state: FlowState, checks: FlowChecks): ChecksDecision | null {
  if (checks.expired === true && state.expiredNotice === "none") return { type: "checks/expired" };
  const sides = state.sides.flatMap((side): ServerRetake[] => {
    const check = checks.sides.find((s) => s.kind === side);
    if (check?.state !== "retake" || !isRetakeReason(check.reason) || !acceptsServerRetake(state, side)) return [];
    return [{ side, reason: check.reason }];
  });
  if (sides.length > 0) return { type: "checks/retake", sides };
  return checks.done ? { type: "checks/ok" } : null;
}

// The rider flow as a pure reducer: which screen is shown and what the rider has done so far.
// Side effects (API calls, camera, uploads) live in useFlow.ts and report back through actions.
import {
  MRZ_EXPECTATION,
  MRZ_TRIES_BEFORE_OVERRIDE,
  REQUIRED_SIDES,
  type CaptureSide,
  type ClientQuality,
  type DeclaredDocument,
  type FlowSession,
  type FlowStatus,
  type MrzExpectation,
  type MrzFormat,
} from "@verify/shared";
import type { GrayImage, Hint } from "@verify/capture";
import { unavailableRead } from "../mrz/lazyReader";
import type { MrzReadResult } from "../mrz/types";
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
  progress: UploadProgress | null;
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
  | { type: "upload/failed"; error: FlowErrorCode; side: CaptureSide | null }
  | { type: "upload/retry" }
  | { type: "upload/submitted"; session: FlowSession }
  | { type: "error/dismiss" }
  /** The phone's Back button or gesture (see useFlow). */
  | { type: "nav/back" };

const IDLE_UPLOAD: UploadState = { status: "idle", progress: null };

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
        return recordRead(taken, shot, unavailableRead(expectation.format));
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
      return { ...state, error: null, screen: { name: "upload" }, upload: { status: "queued", progress: null } };
    }

    case "turnOver/ready":
      if (state.screen.name !== "turnOver") return state;
      return { ...state, screen: { name: "capture", side: state.screen.side } };

    case "upload/started":
      if (state.upload.status !== "queued") return state;
      return { ...state, error: null, upload: { status: "running", progress: action.progress } };

    case "upload/progress":
      if (state.upload.status !== "running") return state;
      return { ...state, upload: { ...state.upload, progress: action.progress } };

    case "upload/sideDone":
      return { ...state, uploaded: { ...state.uploaded, [action.side]: true } };

    case "upload/failed": {
      const { error, side } = action;
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
      if (error === "missing_sides") {
        const first = state.sides[0];
        if (!first) return fail(state, error);
        return { ...state, error, shots: {}, uploaded: {}, upload: IDLE_UPLOAD, screen: { name: "capture", side: first } };
      }
      return fail({ ...state, upload: { status: "failed", progress: state.upload.progress } }, error);
    }

    case "upload/retry":
      if (state.upload.status !== "failed") return state;
      return { ...state, error: null, upload: { status: "queued", progress: null } };

    case "upload/submitted":
      return { ...state, error: null, session: action.session, upload: IDLE_UPLOAD, screen: { name: "done" } };

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
 * to from later screens by this (consent is already recorded); during an upload Back does nothing.
 * Other screens return the same state: the browser may leave the page.
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
    screen.name === "upload"
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

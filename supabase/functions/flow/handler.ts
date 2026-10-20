// Rider flow API (contract.ts, "Flow API"). Routing and business rules only: data access goes through
// the injected FlowRepo / CaptureStorage so the rules can be tested with in-memory fakes.
// M3: rings the AI worker (warm-up when a document is chosen, then after each accepted photo), erases a
// photo replaced by a newer one of the same side, and reports the server's checks (GET /checks).
// M4: GET /checks also says when the code lines show an expired document, and a new choice of
// document decides the case's server checks again (photos of sides it does not need stop counting).
// M5: the face check: a random challenge (POST /liveness/challenge), then its frames, checked and
// recorded with the liveness_capture check (POST /liveness/captures). The submit needs them.
// Automatic approval (PM 2026-10-20): GET /result tells the rider, after the submit, whether the ID is
// verified, still being checked by the server (pending), or left to a person (review).
import {
  CAPTURE_LIMITS,
  CAPTURE_SIDES,
  type CaptureCompleteResponse,
  type CaptureSide,
  CONSENT_VERSION,
  DECLARED_DOCUMENTS,
  type DeclaredDocument,
  type ErrorCode,
  type FlowCaptureSummary,
  type FlowResult,
  type FlowSession,
  type FlowStatus,
  KEEP_FACE_IMAGES_VERSION,
  LIVENESS_LIMITS,
  type LivenessAction,
  type LivenessCaptureDetails,
  type LivenessCaptureResponse,
  type LivenessChallengeResponse,
  type MrzCheckDetails,
  MRZ_EXPECTATION,
  type MrzExpectation,
  type MrzFormat,
  type MrzReportRequest,
  type MrzReportResponse,
  REQUIRED_SIDES,
  SESSION_TOKEN_HEADER,
  type UploadUrlResponse,
} from "../_shared/contract.ts";
import type { AuditEntry } from "../_shared/audit.ts";
import { ID_CAPTURES_BUCKET } from "../_shared/config.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import { badRequest, createRouter, type Handler, HttpError, isOneOf, jsonResponse, readJsonObject } from "../_shared/http.ts";
import { isJpeg, readJpegSize } from "../_shared/jpeg.ts";
import { consoleLogger, type Logger } from "../_shared/log.ts";
import { documentCodeFits, MRZ_PARSER_VERSION, parseMrz } from "../_shared/mrz.ts";
import { type CaseStore, refreshCase } from "../worker/case.ts";
import { assessLivenessCapture, LIVENESS_CHECK_VERSION } from "../worker/liveness.ts";
import { type CheckStateRow, flowChecks } from "./checks.ts";
import { cryptoRandomInt, drawChallenge, livenessFramePath, type RandomInt, validateLivenessCapture } from "./liveness.ts";
import { toFlowResult } from "./result.ts";
import { noRing, type WorkerRing } from "./ring.ts";
import { buildCapturePath, isOwnCapturePath, sanitizeQuality, validateMrzReport } from "./validation.ts";

export interface FlowVerification {
  id: string;
  status: FlowStatus;
  locale: "fr" | "en";
  declaredDocument: DeclaredDocument | null;
  /** session_expires_at; a session without one is treated as expired. */
  expiresAt: string | null;
  isTest: boolean;
}

export interface StoredCapture {
  id: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  reusedElsewhere: boolean;
}

export interface NewCapture {
  verificationId: string;
  kind: CaptureSide;
  storagePath: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  quality: Record<string, unknown>;
}

export type SubmitResult = "ok" | "already_submitted" | "missing_sides";

/** What the submit requires a live capture of: the document's sides and, since M5, the face check's frames. */
export type RequiredKind = CaptureSide | "liveness_frame";

/** A face-check challenge as the flow function reads it back (M5). */
export interface StoredChallenge {
  id: string;
  actions: LivenessAction[];
  code: string;
  createdAt: string;
  expiresAt: string;
  supersededAt: string | null;
  usedAt: string | null;
}

/** flow_issue_liveness_challenge's answer. */
export type ChallengeIssue =
  | { result: "ok"; challengeId: string; expiresAt: string }
  | { result: "too_many" | "closed" };

/** One frame as flow_record_liveness stores it: what the phone reported, and what the server measured. */
export interface LivenessFrameRecord {
  index: number;
  step: number;
  atMs: number;
  path: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
}

export interface LivenessRecord {
  verificationId: string;
  challengeId: string;
  code: string;
  frames: LivenessFrameRecord[];
  version: string;
  outcome: "pass" | "flag";
  details: LivenessCaptureDetails;
}

/** flow_record_liveness's answer; nothing changes unless "ok". */
export type LivenessRecordResult =
  | { result: "ok"; supersededPaths: string[] }
  | { result: "not_found" | "used" | "expired" | "code_mismatch" | "closed" };

/** What flow_record_mrz stores for one photo: the check result, and the encrypted lines when some were read. */
export interface MrzRecord {
  verificationId: string;
  captureId: string;
  /** The lines joined with "\n", encrypted by the database; null when nothing was read. */
  lines: string | null;
  /** Format of the lines; null when nothing was read. */
  format: MrzFormat | null;
  outcome: "pass" | "flag";
  /** check_result.details: outcomes and counts only, never the lines or anything read from them. */
  details: MrzCheckDetails;
}

/** "exists": this photo already has its MRZ check (a retried report); nothing was changed. */
export type MrzRecordResult = "ok" | "exists" | "not_found";

/** What follows an accepted photo (M3): the photos it replaced, and whether the worker should be rung. */
export interface CaptureFollowUp {
  /** Storage paths of the older photos of the same side that the database marked replaced. */
  supersededPaths: string[];
  /** The photo's job waits for the worker (false when the session is not eligible). */
  jobPending: boolean;
}

export interface FlowRepo {
  findVerificationByTokenHash(tokenHash: string): Promise<FlowVerification | null>;
  getVerification(id: string): Promise<FlowVerification | null>;
  hasConsent(verificationId: string): Promise<boolean>;
  insertConsent(consent: {
    verificationId: string;
    consentVersion: string;
    language: "fr" | "en";
    userAgent: string | null;
    /** M5: the optional "keep my face images" box, and the version of its wording. */
    keepFaceImages: boolean;
    keepFaceImagesVersion: string;
  }): Promise<void>;
  /** created -> in_progress; no change in any other status. */
  markInProgress(verificationId: string): Promise<void>;
  /** Sets the document while the session is open; false when a concurrent submit closed it first. */
  setDeclaredDocument(verificationId: string, document: DeclaredDocument): Promise<boolean>;
  /** Captures of this verification without deleted_at, any kind. */
  listActiveCaptures(verificationId: string): Promise<{ kind: string; createdAt: string }[]>;
  /** flow_claim_upload_slot: atomic, false once `max` links have been issued. */
  claimUploadSlot(verificationId: string, max: number): Promise<boolean>;
  /** A live capture already recorded for this exact path (a retried POST /captures). */
  findCaptureByPath(verificationId: string, path: string): Promise<StoredCapture | null>;
  /** True when a capture of another verification has the same sha256. */
  isShaUsedElsewhere(sha256: string, verificationId: string): Promise<boolean>;
  insertCapture(capture: NewCapture): Promise<string>;
  /** flow_submit: locks the row, checks status and the required kinds, opens the review task and audits. */
  submit(verificationId: string, requiredKinds: readonly RequiredKind[]): Promise<SubmitResult>;
  /** A capture of this verification that has not been erased; null otherwise. */
  findActiveCapture(verificationId: string, captureId: string): Promise<{ kind: string } | null>;
  /**
   * flow_record_mrz: re-checks that the capture is a live one of this verification, then encrypts the
   * lines, writes the check result and audits (without the lines), all in one transaction. Idempotent per photo.
   */
  recordMrz(record: MrzRecord): Promise<MrzRecordResult>;
  audit(entry: AuditEntry): Promise<void>;
  /** M3: the photos replaced by this one and the state of its job (see the capture_worker_job trigger). */
  captureFollowUp(captureId: string): Promise<CaptureFollowUp>;
  /** M3: the worker could not be rung for this photo; reported unchecked while its job waits. */
  markRingFailed(captureId: string): Promise<void>;
  /** M3: flow_check_state, every document photo of the case. */
  checkState(verificationId: string): Promise<CheckStateRow[]>;
  /** M4: the firm flags of the case's consistency check (generic codes); empty when there is none. */
  consistencyFlags(verificationId: string): Promise<string[]>;
  /** M3: worker_settings.enabled_for_real_sessions (off until Vercel Pro and its DPA). */
  workerEnabledForRealSessions(): Promise<boolean>;
  /** M6/M7: a face job of this case waits for the face worker (flow_face_jobs_pending). */
  faceJobsPending(verificationId: string): Promise<boolean>;
  /** M5: flow_issue_liveness_challenge (replaces an unused earlier challenge; audited, never the code). */
  issueLivenessChallenge(issue: {
    verificationId: string;
    actions: LivenessAction[];
    code: string;
    ttlSeconds: number;
    max: number;
  }): Promise<ChallengeIssue>;
  /** M5: a challenge of this session; null for any other. */
  getLivenessChallenge(verificationId: string, challengeId: string): Promise<StoredChallenge | null>;
  /** M5: storage paths of the live frames recorded for a challenge. */
  livenessFramePaths(challengeId: string): Promise<string[]>;
  /** M5: whether any of these SHA-256 belongs to a capture of another verification. */
  shasUsedElsewhere(sha256s: readonly string[], verificationId: string): Promise<boolean>;
  /** M5: flow_record_liveness: frames, check, challenge used and audit, together or not at all. */
  recordLiveness(record: LivenessRecord): Promise<LivenessRecordResult>;
  /** M5: whether the session has the live frames of a recorded face check. */
  hasLiveness(verificationId: string): Promise<boolean>;
  /** Automatic approval: flow_result (verified, pending or review, and the return address); null for an unknown case. */
  flowResult(verificationId: string): Promise<unknown>;
}

export interface CaptureStorage {
  createSignedUploadUrl(path: string): Promise<{ path: string; token: string }>;
  /** Null when the object does not exist. */
  download(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  remove(path: string): Promise<void>;
}

export interface FlowDeps {
  repo: FlowRepo;
  storage: CaptureStorage;
  allowedOrigins: ReadonlySet<string>;
  /** The AI worker's doorbell (M3); default: never rung. */
  ring?: WorkerRing;
  /** The face worker's doorbell (M6/M7), rung after a face check is recorded; default: never rung (the face sweep rings each minute). */
  faceRing?: WorkerRing;
  /** Rewrites a case's server checks after a photo is replaced (M3); default: left to the next result. */
  cases?: CaseStore;
  now?: () => Date;
  randomUUID?: () => string;
  /** Draws the face check's actions and code (M5); default: crypto.getRandomValues. */
  randomInt?: RandomInt;
  log?: Logger;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const OPEN_STATUSES: readonly FlowStatus[] = ["created", "in_progress"];
const MAX_USER_AGENT = 512;

export function createFlowHandler(deps: FlowDeps): Handler {
  const { repo, storage } = deps;
  const ring = deps.ring ?? noRing;
  const faceRing = deps.faceRing ?? noRing;
  const now = deps.now ?? (() => new Date());
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const randomInt = deps.randomInt ?? cryptoRandomInt;
  const log = deps.log ?? consoleLogger;

  /**
   * Unknown and malformed tokens get the same 401. Expiry is checked before status, and every route
   * except GET /session needs the verification to still be open.
   */
  async function loadSession(req: Request, { allowClosed = false } = {}): Promise<FlowVerification> {
    const token = req.headers.get(SESSION_TOKEN_HEADER);
    if (token === null || !TOKEN_RE.test(token)) throw new HttpError(401, "invalid_session");
    const verification = await repo.findVerificationByTokenHash(await sha256Hex(token));
    if (!verification) throw new HttpError(401, "invalid_session");
    const expiresAt = verification.expiresAt === null ? NaN : Date.parse(verification.expiresAt);
    if (!(now().getTime() < expiresAt)) throw new HttpError(410, "session_expired");
    if (!allowClosed && !OPEN_STATUSES.includes(verification.status)) {
      throw new HttpError(409, "already_submitted");
    }
    return verification;
  }

  async function toFlowSession(v: FlowVerification): Promise<FlowSession> {
    const [consentGiven, rows] = await Promise.all([repo.hasConsent(v.id), repo.listActiveCaptures(v.id)]);
    const latest = new Map<CaptureSide, FlowCaptureSummary>();
    for (const row of rows) {
      if (!isOneOf(CAPTURE_SIDES, row.kind)) continue;
      const current = latest.get(row.kind);
      if (!current || Date.parse(row.createdAt) > Date.parse(current.createdAt)) {
        latest.set(row.kind, { kind: row.kind, createdAt: row.createdAt });
      }
    }
    return {
      verificationId: v.id,
      status: v.status,
      locale: v.locale,
      consentGiven,
      declaredDocument: v.declaredDocument,
      requiredSides: v.declaredDocument ? [...REQUIRED_SIDES[v.declaredDocument]] : null,
      captures: CAPTURE_SIDES.flatMap((side) => latest.get(side) ?? []),
      expiresAt: v.expiresAt ?? "",
      isTest: v.isTest,
    };
  }

  async function sessionResponse(id: string): Promise<Response> {
    const fresh = await repo.getVerification(id);
    if (!fresh) throw new Error("verification disappeared");
    return jsonResponse(200, await toFlowSession(fresh));
  }

  function riderAudit(v: FlowVerification, action: string, details: Record<string, unknown>, target?: {
    type: string;
    id: string;
  }): Promise<void> {
    return repo.audit({
      actorType: "rider",
      actorId: v.id,
      action,
      targetType: target?.type ?? "verification",
      targetId: target?.id ?? v.id,
      details,
    });
  }

  async function requireConsent(v: FlowVerification): Promise<void> {
    if (!(await repo.hasConsent(v.id))) throw new HttpError(403, "consent_required");
  }

  const getSession: Handler = async (req) => {
    const v = await loadSession(req, { allowClosed: true });
    return jsonResponse(200, await toFlowSession(v));
  };

  const postConsent: Handler = async (req) => {
    const v = await loadSession(req);
    const body = await readJsonObject(req);
    if (body.consentVersion !== CONSENT_VERSION) throw badRequest("Unknown consent version.");
    if (body.language !== "fr" && body.language !== "en") throw badRequest("language must be fr or en.");
    const language = body.language;
    // M5: optional, false when missing (an app from before M5); never anything but true or false.
    if (body.keepFaceImages !== undefined && typeof body.keepFaceImages !== "boolean") {
      throw badRequest("keepFaceImages must be true or false.");
    }
    const keepFaceImages = body.keepFaceImages === true;

    if (await repo.hasConsent(v.id)) {
      // Idempotent: a retried request records nothing new.
      if (v.status === "created") await repo.markInProgress(v.id);
    } else {
      const userAgent = req.headers.get("user-agent")?.slice(0, MAX_USER_AGENT) ?? null;
      await repo.insertConsent({
        verificationId: v.id,
        consentVersion: CONSENT_VERSION,
        language,
        userAgent,
        keepFaceImages,
        keepFaceImagesVersion: KEEP_FACE_IMAGES_VERSION,
      });
      await repo.markInProgress(v.id);
      await riderAudit(v, "consent.accept", {
        consentVersion: CONSENT_VERSION,
        language,
        keepFaceImages,
        keepFaceImagesVersion: KEEP_FACE_IMAGES_VERSION,
      });
    }
    return sessionResponse(v.id);
  };

  const postDocumentType: Handler = async (req) => {
    const v = await loadSession(req);
    const body = await readJsonObject(req);
    await requireConsent(v);
    if (!isOneOf(DECLARED_DOCUMENTS, body.declaredDocument)) throw badRequest("Unknown document type.");
    const declaredDocument = body.declaredDocument;
    // Audit only a change that happened: a submit may have closed the session meanwhile.
    if (!(await repo.setDeclaredDocument(v.id, declaredDocument))) throw new HttpError(409, "already_submitted");
    await riderAudit(v, "document.declare", { declaredDocument });
    // M4: another document ("Use another document" after an expired one): the case's server checks
    // follow it at once. Best effort, like after a replaced photo; the next result decides again anyway.
    if (v.declaredDocument !== null && v.declaredDocument !== declaredDocument && deps.cases) {
      await refreshCase(deps.cases, v.id, now).catch((err) => log.error("flow.case_refresh_failed", err));
    }
    // Warm-up: the worker starts while the rider frames the first photo. Only for sessions it may
    // process, so a real rider never triggers it while the switch is off.
    if (v.isTest || (await repo.workerEnabledForRealSessions())) ring("warm_up");
    return sessionResponse(v.id);
  };

  const postUploadUrl: Handler = async (req) => {
    const v = await loadSession(req);
    const body = await readJsonObject(req);
    if (typeof body.kind !== "string") throw badRequest("kind is required.");
    await requireConsent(v);
    if (!v.declaredDocument) throw new HttpError(409, "document_type_required");
    const allowed = REQUIRED_SIDES[v.declaredDocument];
    if (!isOneOf(allowed, body.kind)) throw new HttpError(400, "invalid_kind");
    const kind = body.kind;

    if (!(await repo.claimUploadSlot(v.id, CAPTURE_LIMITS.maxUploadUrlsPerSession))) {
      throw new HttpError(429, "too_many_uploads");
    }
    const signed = await storage.createSignedUploadUrl(buildCapturePath(v.id, kind, randomUUID()));
    const response: UploadUrlResponse = { path: signed.path, token: signed.token, bucket: ID_CAPTURES_BUCKET };
    return jsonResponse(200, response);
  };

  const postCaptures: Handler = async (req) => {
    const v = await loadSession(req);
    const body = await readJsonObject(req);
    if (!isOneOf(CAPTURE_SIDES, body.kind)) throw badRequest("Unknown kind.");
    const kind = body.kind;
    if (!isOwnCapturePath(body.path, v.id, kind)) throw badRequest("Invalid path.");
    const path = body.path;
    const quality = sanitizeQuality(body.quality);
    if (!quality) throw badRequest("Invalid quality metrics.");

    // A retry after a lost response: report the capture already recorded instead of a duplicate, and
    // finish what the first attempt may not have done.
    const existing = await repo.findCaptureByPath(v.id, path);
    if (existing) {
      await afterCapture(v, existing.id);
      return jsonResponse(200, toCaptureResponse(existing));
    }

    const bytes = await storage.download(path);
    if (!bytes) throw new HttpError(404, "upload_missing");

    const check = checkImage(bytes);
    if (!check.ok) {
      // A rejected upload is not kept: the rider retakes the photo with a new upload link.
      await storage.remove(path).catch((err) => log.error("flow.capture_remove_failed", err));
      throw new HttpError(422, check.code);
    }
    const { width, height } = check;

    const sha256 = await sha256Hex(bytes);
    const reusedElsewhere = await repo.isShaUsedElsewhere(sha256, v.id);
    const captureId = await repo.insertCapture({
      verificationId: v.id,
      kind,
      storagePath: path,
      sha256,
      byteSize: bytes.byteLength,
      width,
      height,
      quality: { ...quality, server: { validated: true, reusedElsewhere } },
    });
    const replaced = await afterCapture(v, captureId);
    await riderAudit(v, "capture.create", { kind, byteSize: bytes.byteLength, reusedElsewhere, replaced }, {
      type: "capture",
      id: captureId,
    });
    return jsonResponse(200, toCaptureResponse({
      id: captureId,
      byteSize: bytes.byteLength,
      width,
      height,
      sha256,
      reusedElsewhere,
    }));
  };

  /**
   * M3, once a photo is recorded: erase the photos it replaced (the database has already marked them
   * erased and deleted the data read from them, as for a refused upload), decide the case's server
   * checks again without them, and ring the worker. Returns how many photos were replaced. Only the
   * follow-up lookup can fail the request; the rest is logged, never shown to the rider.
   */
  async function afterCapture(v: FlowVerification, captureId: string): Promise<number> {
    const followUp = await repo.captureFollowUp(captureId);
    for (const path of followUp.supersededPaths) {
      await storage.remove(path).catch((err) => log.error("flow.superseded_remove_failed", err));
    }
    if (followUp.supersededPaths.length > 0 && deps.cases) {
      await refreshCase(deps.cases, v.id, now).catch((err) => log.error("flow.case_refresh_failed", err));
    }
    if (followUp.jobPending) {
      ring("capture", () => repo.markRingFailed(captureId));
    }
    return followUp.supersededPaths.length;
  }

  // Never logs or audits the lines: they reach the database only as a parameter of flow_record_mrz,
  // which stores them encrypted.
  const postMrz: Handler = async (req) => {
    const v = await loadSession(req);
    if (!v.declaredDocument) throw new HttpError(409, "document_type_required");
    const expectation = MRZ_EXPECTATION[v.declaredDocument];
    if (!expectation) throw new HttpError(422, "invalid_mrz", "The declared document has no code lines.");
    const check = validateMrzReport(await readJsonObject(req), expectation.format);
    if (!check.ok) throw new HttpError(check.code === "bad_request" ? 400 : 422, check.code, check.message);
    const report = check.report;

    // Another session's capture gets the same answer as a missing one.
    const capture = await repo.findActiveCapture(v.id, report.captureId);
    if (!capture) throw new HttpError(404, "not_found");
    if (capture.kind !== expectation.side) {
      throw new HttpError(422, "invalid_mrz", "This photo is not of the side that carries the code lines.");
    }

    const { outcome, details } = assessMrzReport(report, expectation, now());
    const result = await repo.recordMrz({
      verificationId: v.id,
      captureId: report.captureId,
      lines: report.result === "read" ? report.lines.join("\n") : null,
      format: report.result === "read" ? expectation.format : null,
      outcome,
      details,
    });
    // The capture was erased between the lookup and the write.
    if (result === "not_found") throw new HttpError(404, "not_found");
    const response: MrzReportResponse = { recorded: true };
    return jsonResponse(200, response);
  };

  // The rider polls this after uploading (CHECKS_POLL_MS, for at most CHECKS_WAIT_MS).
  const getChecks: Handler = async (req) => {
    const v = await loadSession(req);
    if (!v.declaredDocument) throw new HttpError(409, "document_type_required");
    const [rows, flags] = await Promise.all([repo.checkState(v.id), repo.consistencyFlags(v.id)]);
    const checks = flowChecks(REQUIRED_SIDES[v.declaredDocument], rows, {
      expiredFlag: flags.includes("document_expired"),
      mrzSide: MRZ_EXPECTATION[v.declaredDocument]?.side ?? null,
    });
    if (!checks) throw new HttpError(409, "missing_sides");
    return jsonResponse(200, checks);
  };

  // M5: a random challenge for the face check, with a signed upload for each frame slot.
  const postLivenessChallenge: Handler = async (req) => {
    const v = await loadSession(req);
    await readJsonObject(req, { allowEmpty: true });
    await requireConsent(v);
    if (!v.declaredDocument) throw new HttpError(409, "document_type_required");
    const { actions, code } = drawChallenge(randomInt);
    const issued = await repo.issueLivenessChallenge({
      verificationId: v.id,
      actions,
      code,
      ttlSeconds: LIVENESS_LIMITS.challengeTtlSeconds,
      max: LIVENESS_LIMITS.maxChallengesPerSession,
    });
    if (issued.result !== "ok") {
      throw issued.result === "closed"
        ? new HttpError(409, "already_submitted")
        : new HttpError(429, "too_many_challenges");
    }
    const { challengeId, expiresAt } = issued;
    const uploads = await Promise.all(
      Array.from({ length: LIVENESS_LIMITS.maxFrames }, async (_, index) => {
        const signed = await storage.createSignedUploadUrl(livenessFramePath(v.id, challengeId, index));
        return { path: signed.path, token: signed.token };
      }),
    );
    const response: LivenessChallengeResponse = {
      challengeId,
      actions,
      code,
      expiresAt,
      bucket: ID_CAPTURES_BUCKET,
      uploads,
    };
    return jsonResponse(200, response);
  };

  // M5: the frames of a challenge. Each file is checked like a photo (size, JPEG, resolution) and
  // against the SHA-256 the phone computed; any problem refuses them all and erases them, and the
  // rider starts a new face check. Never logs or audits the code.
  const postLivenessCaptures: Handler = async (req) => {
    const v = await loadSession(req);
    const check = validateLivenessCapture(await readJsonObject(req));
    if (!check.ok) throw badRequest(check.message);
    const capture = check.request;
    const paths = capture.frames.map((frame) => frame.path);
    if (capture.frames.some((frame) => frame.path !== livenessFramePath(v.id, capture.challengeId, frame.index))) {
      throw badRequest("Invalid path.");
    }

    // Another session's challenge gets the same answer as a missing one.
    const challenge = await repo.getLivenessChallenge(v.id, capture.challengeId);
    if (!challenge) throw new HttpError(404, "not_found");
    if (challenge.usedAt !== null) return alreadyRecorded(challenge.id, paths);
    if (challenge.supersededAt !== null || !(now().getTime() < Date.parse(challenge.expiresAt))) {
      throw new HttpError(410, "challenge_expired");
    }
    if (capture.code !== challenge.code) {
      throw new HttpError(422, "invalid_liveness", "The code does not match the challenge.");
    }

    const frames: LivenessFrameRecord[] = [];
    let total = 0;
    for (const frame of capture.frames) {
      const bytes = await storage.download(frame.path);
      if (!bytes) throw new HttpError(404, "upload_missing");
      total += bytes.byteLength;
      const checked = checkFrame(bytes);
      let refusal: ErrorCode | null = checked.ok ? null : checked.code;
      if (!refusal && total > LIVENESS_LIMITS.maxTotalBytes) refusal = "image_too_large";
      if (!refusal && (await sha256Hex(bytes)) !== frame.sha256) refusal = "invalid_liveness";
      if (refusal || !checked.ok) {
        // Refused frames are not kept: the rider starts a new face check with new upload slots.
        await Promise.all(
          paths.map((path) => storage.remove(path).catch((err) => log.error("flow.frame_remove_failed", err))),
        );
        throw new HttpError(422, refusal ?? "invalid_image");
      }
      frames.push({ ...frame, byteSize: bytes.byteLength, width: checked.width, height: checked.height });
    }

    const reusedElsewhere = await repo.shasUsedElsewhere(frames.map((frame) => frame.sha256), v.id);
    const { outcome, details } = assessLivenessCapture({
      challengeId: challenge.id,
      actions: challenge.actions,
      code: challenge.code,
      frames,
      stepStartsMs: capture.stepStartsMs,
      serverElapsedMs: now().getTime() - Date.parse(challenge.createdAt),
      reusedElsewhere,
      startedWithWarning: capture.startedWithWarning,
    });
    const recorded = await repo.recordLiveness({
      verificationId: v.id,
      challengeId: challenge.id,
      code: capture.code,
      frames,
      version: LIVENESS_CHECK_VERSION,
      outcome,
      details,
    });
    switch (recorded.result) {
      case "ok": {
        // The older face check's frames are erased; their files go too (best effort, logged).
        for (const path of recorded.supersededPaths) {
          await storage.remove(path).catch((err) => log.error("flow.superseded_remove_failed", err));
        }
        // M6/M7: the database created the face jobs with the frames; ring the face worker when one may
        // run (a test session, or liveness on a real one once the face switch is on). Never fails the rider.
        try {
          if (await repo.faceJobsPending(v.id)) faceRing("face_check");
        } catch (err) {
          log.error("flow.face_ring_check_failed", err);
        }
        const response: LivenessCaptureResponse = { recorded: true };
        return jsonResponse(200, response);
      }
      case "used":
        // A retried request that crossed the first one.
        return alreadyRecorded(challenge.id, paths);
      case "expired":
        throw new HttpError(410, "challenge_expired");
      case "code_mismatch":
        throw new HttpError(422, "invalid_liveness", "The code does not match the challenge.");
      case "closed":
        throw new HttpError(409, "already_submitted");
      case "not_found":
        throw new HttpError(404, "not_found");
    }
  };

  /** A challenge already recorded: the same frames again is a retry, answered as the first time; any others are refused. */
  async function alreadyRecorded(challengeId: string, paths: readonly string[]): Promise<Response> {
    const recorded = await repo.livenessFramePaths(challengeId);
    const same = recorded.length === paths.length && paths.every((path) => recorded.includes(path));
    if (!same) throw new HttpError(409, "challenge_used");
    const response: LivenessCaptureResponse = { recorded: true };
    return jsonResponse(200, response);
  }

  const postSubmit: Handler = async (req) => {
    const v = await loadSession(req);
    if (!v.declaredDocument) throw new HttpError(409, "document_type_required");
    // M5: the face check first. The database checks its frames again, with the sides, under the row lock.
    if (!(await repo.hasLiveness(v.id))) throw new HttpError(409, "liveness_required");
    const result = await repo.submit(v.id, [...REQUIRED_SIDES[v.declaredDocument], "liveness_frame"]);
    if (result === "already_submitted") throw new HttpError(409, "already_submitted");
    if (result === "missing_sides") throw new HttpError(409, "missing_sides");
    return sessionResponse(v.id);
  };

  // Automatic approval: the result screen polls this after the submit (RESULT_POLL_MS, for at most
  // RESULT_WAIT_MS). Allowed on a closed session (that is the point); an open one has nothing to tell yet.
  const getResult: Handler = async (req) => {
    const v = await loadSession(req, { allowClosed: true });
    if (OPEN_STATUSES.includes(v.status)) throw new HttpError(409, "not_submitted");
    const answer = await repo.flowResult(v.id);
    if (answer === null) throw new Error("verification disappeared");
    const response: FlowResult = toFlowResult(answer);
    return jsonResponse(200, response);
  };

  return createRouter({
    name: "flow",
    allowedOrigins: deps.allowedOrigins,
    log,
    routes: {
      "/session": { GET: getSession },
      "/consent": { POST: postConsent },
      "/document-type": { POST: postDocumentType },
      "/upload-url": { POST: postUploadUrl },
      "/captures": { POST: postCaptures },
      "/mrz": { POST: postMrz },
      "/checks": { GET: getChecks },
      "/liveness/challenge": { POST: postLivenessChallenge },
      "/liveness/captures": { POST: postLivenessCaptures },
      "/submit": { POST: postSubmit },
      "/result": { GET: getResult },
    },
  });
}

export type ImageCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; code: "image_too_small" | "image_too_large" | "invalid_image" | "image_resolution_too_low" };

/** Server-side checks on the uploaded bytes, in the order of the spec. Nothing is decoded. */
export function checkImage(bytes: Uint8Array): ImageCheck {
  if (bytes.byteLength < CAPTURE_LIMITS.minBytes) return { ok: false, code: "image_too_small" };
  if (bytes.byteLength > CAPTURE_LIMITS.maxBytes) return { ok: false, code: "image_too_large" };
  if (!isJpeg(bytes)) return { ok: false, code: "invalid_image" };
  const size = readJpegSize(bytes);
  if (!size) return { ok: false, code: "invalid_image" };
  const longSide = Math.max(size.width, size.height);
  if (longSide < CAPTURE_LIMITS.minLongSide) return { ok: false, code: "image_resolution_too_low" };
  // The rider app never sends more; the AI worker refuses larger photos, so one sent around the app
  // would never be checked and would hold up the worker's queue.
  if (longSide > CAPTURE_LIMITS.maxLongSide) return { ok: false, code: "image_too_large" };
  return { ok: true, ...size };
}

export type FrameCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; code: "image_too_small" | "image_too_large" | "invalid_image" | "image_resolution_too_low" };

/** M5: the checks on one face-check frame's bytes (LIVENESS_LIMITS). Nothing is decoded. */
export function checkFrame(bytes: Uint8Array): FrameCheck {
  if (bytes.byteLength < LIVENESS_LIMITS.minFrameBytes) return { ok: false, code: "image_too_small" };
  if (bytes.byteLength > LIVENESS_LIMITS.maxFrameBytes) return { ok: false, code: "image_too_large" };
  if (!isJpeg(bytes)) return { ok: false, code: "invalid_image" };
  const size = readJpegSize(bytes);
  if (!size) return { ok: false, code: "invalid_image" };
  const longSide = Math.max(size.width, size.height);
  if (longSide < LIVENESS_LIMITS.minFrameLongSide) return { ok: false, code: "image_resolution_too_low" };
  if (longSide > LIVENESS_LIMITS.maxFrameLongSide) return { ok: false, code: "image_too_large" };
  return { ok: true, ...size };
}

export interface MrzAssessment {
  outcome: "pass" | "flag";
  details: MrzCheckDetails;
}

/**
 * The server's own verdict on an MRZ report. The phone sends no verdict: the lines are parsed again
 * and every check digit recomputed here. "pass" only when lines of the expected format were read,
 * every check digit is right, both dates are real and the document code fits the declared document;
 * anything else, an unreadable MRZ included, is "flag" for staff to look at.
 */
export function assessMrzReport(report: MrzReportRequest, expectation: MrzExpectation, today: Date): MrzAssessment {
  if (report.result === "unreadable") {
    return {
      outcome: "flag",
      details: {
        source: "mrz_phone",
        parserVersion: MRZ_PARSER_VERSION,
        captureId: report.captureId,
        result: "unreadable",
        reason: report.reason,
        expectedFormat: expectation.format,
        format: null,
        checks: null,
        documentCodeFits: null,
        datesValid: null,
        attempts: report.attempts,
        corrections: null,
        engine: report.engine,
        ms: null,
      },
    };
  }

  const parsed = parseMrz(report.lines, today);
  const codeFits = parsed ? documentCodeFits(expectation.format, parsed.documentCode) : null;
  const pass = parsed !== null && parsed.format === expectation.format && parsed.valid && parsed.datesValid &&
    codeFits === true;
  // Copied field by field so that nothing else from the parser (names, numbers, dates) can reach details.
  const checks: MrzCheckDetails["checks"] = parsed
    ? {
      documentNumber: parsed.checks.documentNumber,
      birthDate: parsed.checks.birthDate,
      expiryDate: parsed.checks.expiryDate,
      ...(parsed.checks.personalNumber === undefined ? {} : { personalNumber: parsed.checks.personalNumber }),
      composite: parsed.checks.composite,
    }
    : null;
  return {
    outcome: pass ? "pass" : "flag",
    details: {
      source: "mrz_phone",
      parserVersion: MRZ_PARSER_VERSION,
      captureId: report.captureId,
      result: "read",
      reason: null,
      expectedFormat: expectation.format,
      format: parsed?.format ?? null,
      checks,
      documentCodeFits: codeFits,
      datesValid: parsed?.datesValid ?? null,
      attempts: report.attempts,
      corrections: report.corrections,
      engine: report.engine,
      ms: report.ms,
    },
  };
}

function toCaptureResponse(c: StoredCapture): CaptureCompleteResponse {
  return {
    captureId: c.id,
    byteSize: c.byteSize,
    width: c.width,
    height: c.height,
    sha256: c.sha256,
    // c.reusedElsewhere stays server-side (see CaptureCompleteResponse).
  };
}

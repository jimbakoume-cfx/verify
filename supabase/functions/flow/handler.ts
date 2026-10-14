// Rider flow API (contract.ts, "Flow API"). Routing and business rules only: data access goes through
// the injected FlowRepo / CaptureStorage so the rules can be tested with in-memory fakes.
// M3: rings the AI worker (warm-up when a document is chosen, then after each accepted photo), erases a
// photo replaced by a newer one of the same side, and reports the server's checks (GET /checks).
import {
  CAPTURE_LIMITS,
  CAPTURE_SIDES,
  type CaptureCompleteResponse,
  type CaptureSide,
  CONSENT_VERSION,
  DECLARED_DOCUMENTS,
  type DeclaredDocument,
  type FlowCaptureSummary,
  type FlowSession,
  type FlowStatus,
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
import { type CheckStateRow, flowChecks } from "./checks.ts";
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
  /** flow_submit: locks the row, checks status and sides, opens the review task and audits. */
  submit(verificationId: string, requiredSides: readonly CaptureSide[]): Promise<SubmitResult>;
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
  /** M3: worker_settings.enabled_for_real_sessions (off until Vercel Pro and its DPA). */
  workerEnabledForRealSessions(): Promise<boolean>;
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
  /** Rewrites a case's server checks after a photo is replaced (M3); default: left to the next result. */
  cases?: CaseStore;
  now?: () => Date;
  randomUUID?: () => string;
  log?: Logger;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const OPEN_STATUSES: readonly FlowStatus[] = ["created", "in_progress"];
const MAX_USER_AGENT = 512;

export function createFlowHandler(deps: FlowDeps): Handler {
  const { repo, storage } = deps;
  const ring = deps.ring ?? noRing;
  const now = deps.now ?? (() => new Date());
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
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

    if (await repo.hasConsent(v.id)) {
      // Idempotent: a retried request records nothing new.
      if (v.status === "created") await repo.markInProgress(v.id);
    } else {
      const userAgent = req.headers.get("user-agent")?.slice(0, MAX_USER_AGENT) ?? null;
      await repo.insertConsent({ verificationId: v.id, consentVersion: CONSENT_VERSION, language, userAgent });
      await repo.markInProgress(v.id);
      await riderAudit(v, "consent.accept", { consentVersion: CONSENT_VERSION, language });
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
      await refreshCase(deps.cases, v.id).catch((err) => log.error("flow.case_refresh_failed", err));
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
    const checks = flowChecks(REQUIRED_SIDES[v.declaredDocument], await repo.checkState(v.id));
    if (!checks) throw new HttpError(409, "missing_sides");
    return jsonResponse(200, checks);
  };

  const postSubmit: Handler = async (req) => {
    const v = await loadSession(req);
    if (!v.declaredDocument) throw new HttpError(409, "document_type_required");
    const result = await repo.submit(v.id, REQUIRED_SIDES[v.declaredDocument]);
    if (result === "already_submitted") throw new HttpError(409, "already_submitted");
    if (result === "missing_sides") throw new HttpError(409, "missing_sides");
    return sessionResponse(v.id);
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
      "/submit": { POST: postSubmit },
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

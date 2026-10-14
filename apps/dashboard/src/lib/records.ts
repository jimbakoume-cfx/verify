// Rows read directly from Supabase (RLS decides which ones come back), checked and reshaped for the UI.
// Rows are typed `unknown` because there are no generated database types; nothing is trusted blindly.
import {
  type ClassificationDetails,
  DECLARED_DOCUMENTS,
  type DeclaredDocument,
  DETECTED_DOCUMENT_TYPES,
  type DocumentPolicyDetails,
  type FlowStatus,
  MRZ_CHECK_NAME,
  MRZ_FORMATS,
  type MrzCheckDetails,
  type MrzFormat,
  type MrzServerDetails,
  type OcrFieldsDetails,
  POLICY_REASONS,
  type QualityServerDetails,
  RETAKE_REASONS,
  SERVER_CHECK_NAMES,
  type WorkerFields,
  type WorkerQuality,
} from "@verify/shared";
import { isStaffRole, type StaffRole } from "./roles";

export interface StaffProfile {
  userId: string;
  role: StaffRole;
  fullName: string;
  active: boolean;
}

export interface VerificationSummary {
  id: string;
  status: FlowStatus;
  declaredDocument: DeclaredDocument | null;
  isTest: boolean;
  createdAt: string;
  submittedAt: string | null;
  sessionExpiresAt: string | null;
}

export interface VerificationListItem extends VerificationSummary {
  /** Captures still holding an image (not erased). */
  captureCount: number;
}

/** Metrics the rider app measured, plus what the server added after checking the upload. */
export interface CaptureQuality {
  source: "auto" | "manual" | null;
  sharpness: number | null;
  glareRatio: number | null;
  meanLuma: number | null;
  framing: number | null;
  videoWidth: number | null;
  videoHeight: number | null;
  elapsedMs: number | null;
  reusedElsewhere: boolean | null;
}

export interface CaptureRecord {
  id: string;
  /** capture_kind enum: document_front, document_back, selfie, liveness_frame. */
  kind: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  sha256: string;
  deleted: boolean;
  /** The newer photo of the same side that replaced this one (M3); it is then erased too. */
  supersededBy: string | null;
  quality: CaptureQuality;
}

/** check_outcome enum of the database. */
export const CHECK_OUTCOMES = ["pass", "flag", "fail", "error", "skipped"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** A check_result row. */
export interface CheckRecord<Details> {
  id: string;
  /** Photo the check ran on; null for a check of the whole case. */
  captureId: string | null;
  /** Version of the code that judged, e.g. "mrz-v1" or "server-checks-v1". */
  checkVersion: string;
  outcome: CheckOutcome;
  /** Null when the stored details do not have the shape this dashboard knows (e.g. a newer version). */
  details: Details | null;
  createdAt: string;
}

/** The phone's MRZ check (M2): one per photo of the side that carries the MRZ; details.captureId names it too. */
export type MrzCheckRecord = CheckRecord<MrzCheckDetails>;

/**
 * The server's checks (M3), from the AI worker's evidence. Per photo, latest first: the photo check,
 * the code lines read from the photo (only on the side that carries them) and the names of the
 * printed fields read. Per case: the document recognised and the reasons a person must decide.
 */
export interface ServerChecks {
  quality: CheckRecord<QualityServerDetails>[];
  mrz: CheckRecord<MrzServerDetails>[];
  fields: CheckRecord<OcrFieldsDetails>[];
  /** Null until a photo of the case has a server result. */
  classification: CheckRecord<ClassificationDetails> | null;
  /** Null while there is neither a classification nor a reason. */
  policy: CheckRecord<DocumentPolicyDetails> | null;
  /**
   * The state of each photo's job, by capture id (worker_job: staff may read its status only). A
   * document photo with no entry has no job: it was taken before the server checks existed.
   */
  jobs: ReadonlyMap<string, ServerJobState>;
}

/** waiting: queued or being read. done: its results are recorded. failed: the server gave up on it. */
export type ServerJobState = "waiting" | "done" | "failed";

// Record<FlowStatus, …> makes the compiler flag any status added to the contract but not here.
const STATUS_SET: Record<FlowStatus, true> = {
  created: true,
  in_progress: true,
  submitted: true,
  processing: true,
  in_review: true,
  approved: true,
  rejected: true,
  expired: true,
  cancelled: true,
};
export const VERIFICATION_STATUSES = Object.keys(STATUS_SET) as FlowStatus[];

/** Kinds that exist in the database enum; M1 only produces the two document sides. */
export const CAPTURE_KINDS = ["document_front", "document_back", "selfie", "liveness_frame"] as const;

/** Columns each query asks for, kept next to the code that reads them. */
export const STAFF_PROFILE_COLUMNS = "user_id, role, full_name, active";
export const VERIFICATION_COLUMNS = "id, status, declared_document, is_test, created_at, submitted_at, session_expires_at";
export const CAPTURE_COLUMNS =
  "id, verification_id, kind, byte_size, width, height, quality, created_at, sha256, deleted_at, superseded_by";
export const CHECK_COLUMNS = "id, capture_id, check_name, check_version, outcome, details, created_at";
/** The only columns of worker_job staff may read (with verification_id, to filter by case). */
export const JOB_COLUMNS = "capture_id, status";

/** check_result names of the server's checks, for the query (SERVER_CHECK_NAMES in contract.ts). */
export const SERVER_CHECK_NAME_LIST: readonly string[] = Object.values(SERVER_CHECK_NAMES);

// Record<keyof WorkerFields, …> makes the compiler flag any field added to the contract but not here.
const PRINTED_FIELD_SET: Record<keyof WorkerFields, true> = {
  surname: true,
  givenNames: true,
  documentNumber: true,
  birthDate: true,
  expiryDate: true,
  issueDate: true,
  subtype: true,
};
/** Printed fields the server's worker reads, in the order staff compare them with the photo. */
export const PRINTED_FIELDS = Object.keys(PRINTED_FIELD_SET) as (keyof WorkerFields)[];

type Row = Record<string, unknown>;

const asRow = (value: unknown): Row | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

export function isFlowStatus(value: unknown): value is FlowStatus {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STATUS_SET, value);
}

export function isDeclaredDocument(value: unknown): value is DeclaredDocument {
  return typeof value === "string" && (DECLARED_DOCUMENTS as readonly string[]).includes(value);
}

export function toStaffProfile(value: unknown): StaffProfile | null {
  const row = asRow(value);
  const userId = str(row?.user_id);
  if (!row || !userId || !isStaffRole(row.role)) return null;
  return { userId, role: row.role, fullName: str(row.full_name) ?? "", active: row.active === true };
}

export function toVerification(value: unknown): VerificationSummary | null {
  const row = asRow(value);
  const id = str(row?.id);
  const createdAt = str(row?.created_at);
  if (!row || !id || !createdAt || !isFlowStatus(row.status)) return null;
  return {
    id,
    status: row.status,
    declaredDocument: isDeclaredDocument(row.declared_document) ? row.declared_document : null,
    isTest: row.is_test === true,
    createdAt,
    submittedAt: str(row.submitted_at),
    sessionExpiresAt: str(row.session_expires_at),
  };
}

export function toCaptureQuality(value: unknown): CaptureQuality {
  const q = asRow(value) ?? {};
  const server = asRow(q.server);
  const reused = server?.reusedElsewhere;
  return {
    source: q.source === "auto" || q.source === "manual" ? q.source : null,
    sharpness: num(q.sharpness),
    glareRatio: num(q.glareRatio),
    meanLuma: num(q.meanLuma),
    framing: num(q.framing),
    videoWidth: num(q.videoWidth),
    videoHeight: num(q.videoHeight),
    elapsedMs: num(q.elapsedMs),
    reusedElsewhere: typeof reused === "boolean" ? reused : null,
  };
}

export function toCapture(value: unknown): CaptureRecord | null {
  const row = asRow(value);
  const id = str(row?.id);
  const kind = str(row?.kind);
  const createdAt = str(row?.created_at);
  const byteSize = num(row?.byte_size);
  if (!row || !id || !kind || !createdAt || byteSize === null) return null;
  return {
    id,
    kind,
    byteSize,
    width: num(row.width),
    height: num(row.height),
    createdAt,
    sha256: str(row.sha256) ?? "",
    deleted: row.deleted_at !== null && row.deleted_at !== undefined,
    supersededBy: str(row.superseded_by),
    quality: toCaptureQuality(row.quality),
  };
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isCheckOutcome(value: unknown): value is CheckOutcome {
  return isOneOf(CHECK_OUTCOMES, value);
}

function isMrzFormat(value: unknown): value is MrzFormat {
  return isOneOf(MRZ_FORMATS, value);
}

function toMrzChecks(value: unknown): MrzCheckDetails["checks"] {
  const c = asRow(value);
  const documentNumber = bool(c?.documentNumber);
  const birthDate = bool(c?.birthDate);
  const expiryDate = bool(c?.expiryDate);
  const composite = bool(c?.composite);
  if (!c || documentNumber === null || birthDate === null || expiryDate === null || composite === null) return null;
  const personalNumber = bool(c.personalNumber);
  return { documentNumber, birthDate, expiryDate, ...(personalNumber === null ? {} : { personalNumber }), composite };
}

/**
 * check_result.details of the MRZ check (MrzCheckDetails in contract.ts). The fields every result
 * carries must be there; the others fall back to null, which the page shows as "—".
 */
export function toMrzCheckDetails(value: unknown): MrzCheckDetails | null {
  const d = asRow(value);
  const result = d?.result;
  const expectedFormat = d?.expectedFormat;
  const parserVersion = str(d?.parserVersion);
  const captureId = str(d?.captureId);
  const attempts = num(d?.attempts);
  const engine = str(d?.engine);
  if (
    !d ||
    d.source !== "mrz_phone" ||
    (result !== "read" && result !== "unreadable") ||
    !isMrzFormat(expectedFormat) ||
    parserVersion === null ||
    captureId === null ||
    attempts === null ||
    engine === null
  ) {
    return null;
  }
  return {
    source: "mrz_phone",
    parserVersion,
    captureId,
    result,
    reason: d.reason === "not_found" || d.reason === "reader_unavailable" ? d.reason : null,
    expectedFormat,
    format: isMrzFormat(d.format) ? d.format : null,
    checks: toMrzChecks(d.checks),
    documentCodeFits: bool(d.documentCodeFits),
    datesValid: bool(d.datesValid),
    attempts,
    corrections: num(d.corrections),
    engine,
    ms: num(d.ms),
  };
}

/** The columns every check_result row shares, with its name and raw details; null when one is missing. */
function toCheckRow(value: unknown): { name: string; check: CheckRecord<never>; details: unknown } | null {
  const row = asRow(value);
  const id = str(row?.id);
  const createdAt = str(row?.created_at);
  const name = str(row?.check_name);
  if (!row || !id || !createdAt || !name || !isCheckOutcome(row.outcome)) return null;
  return {
    name,
    check: {
      id,
      captureId: str(row.capture_id),
      checkVersion: str(row.check_version) ?? "",
      outcome: row.outcome,
      details: null,
      createdAt,
    },
    details: row.details,
  };
}

export function toMrzCheck(value: unknown): MrzCheckRecord | null {
  const row = toCheckRow(value);
  if (!row || row.name !== MRZ_CHECK_NAME) return null;
  const details = toMrzCheckDetails(row.details);
  return { ...row.check, captureId: row.check.captureId ?? details?.captureId ?? null, details };
}

// ---------------------------------------------------------------------------
// The server's checks (M3). Their details are written field by field by the worker Edge Function
// (supabase/functions/worker/decide.ts): the fields every result carries must be there, or the page
// says it cannot read the details; optional ones of the wrong type become null ("—").
// ---------------------------------------------------------------------------
const QUALITY_VERDICTS: readonly QualityServerDetails["verdict"][] = ["ok", "poor", ...RETAKE_REASONS];
const PHONE_AGREEMENTS: readonly MrzServerDetails["phone"][] = ["agrees", "differs", "missing", "unreadable"];
const CLASSIFICATION_BASES: readonly ClassificationDetails["basis"][] = ["mrz", "keywords", "none"];

export function toQualityServerDetails(value: unknown): QualityServerDetails | null {
  const d = asRow(value);
  const q = asRow(d?.quality);
  const timing = asRow(d?.timing);
  const engine = str(d?.engine);
  if (!d || !q || !timing || !isOneOf(QUALITY_VERDICTS, d.verdict) || d.provisional !== true || engine === null) {
    return null;
  }
  const quality = {
    sharpness: num(q.sharpness),
    glareRatio: num(q.glareRatio),
    meanLuma: num(q.meanLuma),
    documentFound: bool(q.documentFound),
    documentConfidence: num(q.documentConfidence),
    longSide: num(q.longSide),
    textLines: num(q.textLines),
  };
  const ms = num(timing.ms);
  const cold = bool(timing.cold);
  if (Object.values(quality).some((v) => v === null) || ms === null || cold === null) return null;
  return { verdict: d.verdict, quality: quality as WorkerQuality, provisional: true, engine, timing: { ms, cold } };
}

export function toMrzServerDetails(value: unknown): MrzServerDetails | null {
  const d = asRow(value);
  const parserVersion = str(d?.parserVersion);
  const found = bool(d?.found);
  const corrections = num(d?.corrections);
  if (!d || parserVersion === null || found === null || corrections === null || !isOneOf(PHONE_AGREEMENTS, d.phone)) {
    return null;
  }
  return {
    parserVersion,
    found,
    format: isMrzFormat(d.format) ? d.format : null,
    checks: toMrzChecks(d.checks),
    documentCodeFits: bool(d.documentCodeFits),
    datesValid: bool(d.datesValid),
    corrections,
    phone: d.phone,
  };
}

export function toOcrFieldsDetails(value: unknown): OcrFieldsDetails | null {
  const d = asRow(value);
  const found = d?.found;
  if (!d || !Array.isArray(found) || typeof d.provisional !== "boolean") return null;
  // Names this page knows, in its order. Never the card sub-type: even its presence says something
  // about the card, so the server leaves it out, and it is dropped here should it ever come.
  return { found: PRINTED_FIELDS.filter((name) => name !== "subtype" && found.includes(name)), provisional: d.provisional };
}

export function toClassificationDetails(value: unknown): ClassificationDetails | null {
  const d = asRow(value);
  const provisional = bool(d?.provisional);
  const confidence = num(d?.confidence);
  if (
    !d ||
    !isOneOf(DETECTED_DOCUMENT_TYPES, d.detected) ||
    !isOneOf(CLASSIFICATION_BASES, d.basis) ||
    provisional === null ||
    confidence === null
  ) {
    return null;
  }
  // Field by field. Never keyword counts, should a row still carry them: on a passport they tell a
  // Cameroonian one from a foreign one, which the server keeps out of check_result.
  return {
    detected: d.detected,
    basis: d.basis,
    provisional,
    matchesDeclared: bool(d.matchesDeclared),
    confidence,
    qrPresent: bool(d.qrPresent),
  };
}

/** The known reasons, once each, in the contract's order. An unknown one still shows as the "flag" outcome. */
export function toDocumentPolicyDetails(value: unknown): DocumentPolicyDetails | null {
  const d = asRow(value);
  const reasons = d?.reasons;
  if (!d || !Array.isArray(reasons)) return null;
  return { reasons: POLICY_REASONS.filter((reason) => reasons.includes(reason)) };
}

function newer<T extends { createdAt: string }>(current: T | null, candidate: T): T {
  return current && current.createdAt >= candidate.createdAt ? current : candidate;
}

/**
 * Rows of the server's checks (any order). Per-photo checks need their photo and per-case checks must
 * have none, as the database writes them; anything else is left out.
 */
export function toServerChecks(rows: readonly unknown[], jobRows: readonly unknown[] = []): ServerChecks {
  const out: ServerChecks = { quality: [], mrz: [], fields: [], classification: null, policy: null, jobs: toServerJobs(jobRows) };
  for (const value of rows) {
    const row = toCheckRow(value);
    if (!row) continue;
    const { check, details } = row;
    const perPhoto = check.captureId !== null;
    switch (row.name) {
      case SERVER_CHECK_NAMES.quality:
        if (perPhoto) out.quality.push({ ...check, details: toQualityServerDetails(details) });
        break;
      case SERVER_CHECK_NAMES.mrz:
        if (perPhoto) out.mrz.push({ ...check, details: toMrzServerDetails(details) });
        break;
      case SERVER_CHECK_NAMES.fields:
        if (perPhoto) out.fields.push({ ...check, details: toOcrFieldsDetails(details) });
        break;
      case SERVER_CHECK_NAMES.classification:
        if (!perPhoto) out.classification = newer(out.classification, { ...check, details: toClassificationDetails(details) });
        break;
      case SERVER_CHECK_NAMES.policy:
        if (!perPhoto) out.policy = newer(out.policy, { ...check, details: toDocumentPolicyDetails(details) });
        break;
    }
  }
  const latestFirst = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);
  out.quality.sort(latestFirst);
  out.mrz.sort(latestFirst);
  out.fields.sort(latestFirst);
  return out;
}

const JOB_STATES: Readonly<Record<string, ServerJobState>> = {
  pending: "waiting",
  claimed: "waiting",
  done: "done",
  failed: "failed",
};

/**
 * worker_job rows (capture_id, status) as each photo's job state. A superseded job belongs to a
 * replaced photo, which the server checks never show; unknown statuses are left out too.
 */
export function toServerJobs(rows: readonly unknown[]): Map<string, ServerJobState> {
  const jobs = new Map<string, ServerJobState>();
  for (const value of rows) {
    const row = asRow(value);
    const captureId = str(row?.capture_id);
    const status = str(row?.status);
    if (!captureId || !status || !Object.prototype.hasOwnProperty.call(JOB_STATES, status)) continue;
    jobs.set(captureId, JOB_STATES[status]);
  }
  return jobs;
}

/** Live (not erased) captures per verification id, from rows holding verification_id + deleted_at. */
export function countCaptures(rows: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of rows) {
    const row = asRow(value);
    const id = str(row?.verification_id);
    if (!row || !id || (row.deleted_at !== null && row.deleted_at !== undefined)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The newest photo still holding an image, per capture kind: the one every check of that side is
 * about. Same order as the database (private.worker_newest_captures): newest first, then by id.
 */
export function newestLiveCaptures(captures: readonly CaptureRecord[]): Map<string, CaptureRecord> {
  const newest = new Map<string, CaptureRecord>();
  for (const capture of captures) {
    if (capture.deleted) continue;
    const current = newest.get(capture.kind);
    if (
      !current ||
      capture.createdAt > current.createdAt ||
      (capture.createdAt === current.createdAt && capture.id > current.id)
    ) {
      newest.set(capture.kind, capture);
    }
  }
  return newest;
}

/** Front before back, then the newest first within a kind. */
export function sortCaptures(captures: readonly CaptureRecord[]): CaptureRecord[] {
  const rank = (kind: string) => {
    const i = (CAPTURE_KINDS as readonly string[]).indexOf(kind);
    return i < 0 ? CAPTURE_KINDS.length : i;
  };
  return [...captures].sort((a, b) => rank(a.kind) - rank(b.kind) || b.createdAt.localeCompare(a.createdAt));
}

/** A rider link is still usable only before submission and before its expiry. */
export function sessionOpen(v: VerificationSummary, nowMs: number): boolean {
  if (v.status !== "created" && v.status !== "in_progress") return false;
  const expires = v.sessionExpiresAt ? Date.parse(v.sessionExpiresAt) : Number.NaN;
  return Number.isFinite(expires) && expires > nowMs;
}

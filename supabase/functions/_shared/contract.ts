// Single source of truth for the HTTP contract between the web apps and the Edge Functions.
// Imported by Deno (Edge Functions) and, via packages/shared/src/flowApi.ts, by the web apps.
// Keep this file dependency-free: types and constants only, no imports.

// ---------------------------------------------------------------------------
// Documents and capture sides
// ---------------------------------------------------------------------------

/**
 * What the rider says they are holding. The classifier (M3) decides the exact type/version.
 * The CNI is split because only the new card (2025) has an MRZ; the old one (2017) has none.
 * Names match the database enum `document_type`.
 */
export const DECLARED_DOCUMENTS = [
  "cni_biometric",
  "cni_legacy",
  "passport",
  "residence_permit",
  "driving_licence",
  "voter_card",
] as const;
export type DeclaredDocument = (typeof DECLARED_DOCUMENTS)[number];

export const CAPTURE_SIDES = ["document_front", "document_back"] as const;
export type CaptureSide = (typeof CAPTURE_SIDES)[number];

/** Which sides must be photographed for each declared document. */
export const REQUIRED_SIDES: Record<DeclaredDocument, readonly CaptureSide[]> = {
  cni_biometric: ["document_front", "document_back"],
  cni_legacy: ["document_front", "document_back"],
  passport: ["document_front"], // the data page only
  residence_permit: ["document_front", "document_back"],
  driving_licence: ["document_front", "document_back"],
  voter_card: ["document_front", "document_back"],
};

/** Width / height of the capture guide for each document (ID-1 card = 85.60 x 53.98 mm; passport TD3 page = 125 x 88 mm). */
export const DOCUMENT_ASPECT: Record<DeclaredDocument, number> = {
  cni_biometric: 85.6 / 53.98,
  cni_legacy: 85.6 / 53.98,
  passport: 125 / 88,
  residence_permit: 85.6 / 53.98,
  driving_licence: 85.6 / 53.98,
  voter_card: 85.6 / 53.98,
};

// ---------------------------------------------------------------------------
// MRZ ("code lines", ICAO 9303): which side carries it, in which layout (M2)
// ---------------------------------------------------------------------------
/** TD1: ID-1 card, 3 lines of 30 characters. TD3: passport, 2 lines of 44. */
export const MRZ_FORMATS = ["TD1", "TD3"] as const;
export type MrzFormat = (typeof MRZ_FORMATS)[number];

/** Characters and length of each line, per format. */
export const MRZ_LAYOUT: Record<MrzFormat, { lines: number; length: number }> = {
  TD1: { lines: 3, length: 30 },
  TD3: { lines: 2, length: 44 },
};

export interface MrzExpectation {
  side: CaptureSide;
  format: MrzFormat;
  /**
   * Required: the rider is asked to retake until the lines read correctly, and may continue anyway
   * after MRZ_TRIES_BEFORE_OVERRIDE tries (the case is flagged). Optional: read if present, the
   * rider is never asked to retake for it.
   */
  required: boolean;
}

/**
 * Where the MRZ is for each declared document; null when the document has none.
 * Assumption to confirm on a real card: the new CNI carries a standard 3-line TD1 MRZ on its back.
 */
export const MRZ_EXPECTATION: Record<DeclaredDocument, MrzExpectation | null> = {
  cni_biometric: { side: "document_back", format: "TD1", required: true },
  cni_legacy: null,
  passport: { side: "document_front", format: "TD3", required: true },
  residence_permit: { side: "document_back", format: "TD1", required: false },
  driving_licence: null,
  voter_card: null,
};

/** Failed reads of a required MRZ before the rider may continue anyway. */
export const MRZ_TRIES_BEFORE_OVERRIDE = 3;

// ---------------------------------------------------------------------------
// Limits shared by client and server
// ---------------------------------------------------------------------------
export const CAPTURE_LIMITS = {
  /** Client aims for this size after compression. */
  targetBytes: 300_000,
  /** Server rejects smaller files (almost certainly blank/garbage). */
  minBytes: 10_000,
  /** Server and storage bucket reject larger files. */
  maxBytes: 5 * 1024 * 1024,
  /** Longest side of the uploaded crop, in pixels. Server rejects larger crops (M3: image_too_large). */
  maxLongSide: 1600,
  /**
   * Server rejects crops whose longest side is smaller (too little detail for OCR/MRZ).
   * 720 px across an ID-1 card is about 8.4 px/mm (MRZ characters about 20 px tall). 800 px excluded
   * common 20:9 / 21:9 phones whose 1080p stream gives about 790 px when held upright.
   * To be confirmed against real OCR results in M2/M3.
   */
  minLongSide: 720,
  /** Upload links a single session may request (bounds storage abuse). */
  maxUploadUrlsPerSession: 20,
} as const;

/**
 * Version label of the consent wording shown to the rider: change it whenever the wording changes,
 * so each recorded consent names the text that was shown. Replace when the lawyer's text arrives.
 * v1 (M2): the wording adds the details read from the document's code lines.
 */
export const CONSENT_VERSION = "placeholder-v1";

// ---------------------------------------------------------------------------
// Client-side quality metrics sent with each capture (informational; the server re-checks in M3)
// ---------------------------------------------------------------------------
export interface ClientQuality {
  /** "auto" when the camera captured by itself, "manual" when the rider pressed the shutter. */
  source: "auto" | "manual";
  /** Variance of the Laplacian on the analysis-size crop (higher = sharper). */
  sharpness: number;
  /** Share of near-white (saturated) pixels in the document area, 0..1. */
  glareRatio: number;
  /** Mean brightness of the document area, 0..255. */
  meanLuma: number;
  /** How well the detected document fills the guide, 0..1. */
  framing: number;
  /** Capture device info useful for calibration. */
  videoWidth: number;
  videoHeight: number;
  /** Milliseconds from camera start to capture. */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Flow API (rider). Edge Function "flow". Auth: header `x-session-token`.
//   GET  /flow/session
//   POST /flow/consent        ConsentRequest
//   POST /flow/document-type  DocumentTypeRequest
//   POST /flow/upload-url     UploadUrlRequest   -> UploadUrlResponse
//   POST /flow/captures       CaptureCompleteRequest -> CaptureCompleteResponse
//   POST /flow/mrz            MrzReportRequest -> MrzReportResponse (M2)
//   GET  /flow/checks         -> FlowChecks (M3, see below)
//   POST /flow/submit
// All except upload-url, captures and mrz return FlowSession.
// ---------------------------------------------------------------------------
export const SESSION_TOKEN_HEADER = "x-session-token";

export type FlowStatus =
  | "created"
  | "in_progress"
  | "submitted"
  | "processing"
  | "in_review"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface FlowCaptureSummary {
  kind: CaptureSide;
  createdAt: string;
}

export interface FlowSession {
  verificationId: string;
  status: FlowStatus;
  locale: "fr" | "en";
  consentGiven: boolean;
  declaredDocument: DeclaredDocument | null;
  /** Null until the document type is chosen. */
  requiredSides: CaptureSide[] | null;
  /** Latest capture per side. */
  captures: FlowCaptureSummary[];
  expiresAt: string;
  isTest: boolean;
}

export interface ConsentRequest {
  consentVersion: string;
  language: "fr" | "en";
}

export interface DocumentTypeRequest {
  declaredDocument: DeclaredDocument;
}

export interface UploadUrlRequest {
  kind: CaptureSide;
}

export interface UploadUrlResponse {
  /** Object path inside the private bucket; send it back in CaptureCompleteRequest. */
  path: string;
  /** Token for supabase.storage.from(bucket).uploadToSignedUrl(path, token, file). */
  token: string;
  bucket: string;
}

export interface CaptureCompleteRequest {
  path: string;
  kind: CaptureSide;
  quality: ClientQuality;
}

export interface CaptureCompleteResponse {
  captureId: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  // Whether the same image was used in another verification is recorded server-side only
  // (capture.quality.server.reusedElsewhere): telling the rider would let a fraudster probe for it.
}

/** Fields shared by both kinds of MRZ report. */
interface MrzReportBase {
  /** Capture of the side that carries the MRZ (from CaptureCompleteResponse). */
  captureId: string;
  /** Reading attempts on this side, including this one (1..MRZ_REPORT_LIMITS.maxAttempts). */
  attempts: number;
  /** Reading engine and model, e.g. "tesseract.js-7.0.0/mrz-1". */
  engine: string;
}

/**
 * What the phone read. The server re-parses the lines and recomputes every check digit itself:
 * the phone's own verdict is never sent. Lines are sent even when their check digits fail (the rider
 * continued anyway), so staff can compare them with the photo.
 */
export interface MrzReadReport extends MrzReportBase {
  result: "read";
  /** Exactly MRZ_LAYOUT[format].lines lines of MRZ_LAYOUT[format].length characters in [A-Z0-9<]. */
  lines: string[];
  /** Characters changed by the phone's look-alike correction (O/0, I/1...). */
  corrections: number;
  /** Time spent reading, in milliseconds. */
  ms: number;
}

/** Nothing usable was read: no MRZ found, or the reader could not run on this phone. */
export interface MrzUnreadableReport extends MrzReportBase {
  result: "unreadable";
  reason: "not_found" | "reader_unavailable";
}

export type MrzReportRequest = MrzReadReport | MrzUnreadableReport;

export interface MrzReportResponse {
  recorded: true;
}

/** check_result.check_name of the MRZ check (M2). */
export const MRZ_CHECK_NAME = "mrz";

/**
 * check_result.details of the MRZ check. Outcomes and counts only, never personal data: supervisors
 * and admins can read check_result directly. The lines themselves are stored encrypted in
 * extracted_document_data and only come back through POST /admin/document-data (audited).
 * Outcome: "pass" only when lines of the expected format were read, every check digit is right,
 * both dates are real and the document code fits; otherwise "flag".
 */
export interface MrzCheckDetails {
  source: "mrz_phone";
  parserVersion: string;
  captureId: string;
  result: "read" | "unreadable";
  /** Set when result is "unreadable". */
  reason: "not_found" | "reader_unavailable" | null;
  expectedFormat: MrzFormat;
  /** Format of the lines received; null when unreadable. */
  format: MrzFormat | null;
  /** Each check digit, recomputed by the server; null when unreadable. */
  checks: {
    documentNumber: boolean;
    birthDate: boolean;
    expiryDate: boolean;
    /** TD3 only. */
    personalNumber?: boolean;
    composite: boolean;
  } | null;
  /** Document code fits the declared document (P for a passport; I, A or C for a TD1 card). */
  documentCodeFits: boolean | null;
  /** Birth and expiry dates are complete, real dates. */
  datesValid: boolean | null;
  attempts: number;
  corrections: number | null;
  engine: string;
  ms: number | null;
}

export const MRZ_REPORT_LIMITS = {
  maxAttempts: 20,
  maxCorrections: 90,
  maxMs: 600_000,
  maxEngineLength: 40,
} as const;

// ---------------------------------------------------------------------------
// Server photo checks seen by the rider (M3). Edge Function "flow". Auth: session token.
//   GET /flow/checks -> FlowChecks
// The rider polls it after uploading, for at most CHECKS_WAIT_MS. Nothing personal is returned.
// ---------------------------------------------------------------------------
/**
 * pending: the worker has not finished. ok: usable. retake: ask the rider for a new photo of that
 * side (reason given). unchecked: the server could not check it (worker down, out of budget,
 * session not eligible): the rider continues and staff review.
 */
export const FLOW_CHECK_STATES = ["pending", "ok", "retake", "unchecked"] as const;
export type FlowCheckState = (typeof FLOW_CHECK_STATES)[number];

/**
 * Only these ask for a retake until the server thresholds are tuned on real photos; every other
 * problem is flagged for staff. no_document: no card or page found. unreadable: no usable text.
 */
export const RETAKE_REASONS = ["no_document", "unreadable"] as const;
export type RetakeReason = (typeof RETAKE_REASONS)[number];

export interface FlowCheckSide {
  kind: CaptureSide;
  /** The newest live capture of this side. */
  captureId: string;
  state: FlowCheckState;
  /** Set when state is "retake". */
  reason: RetakeReason | null;
}

export interface FlowChecks {
  /** True when no side is pending any more. */
  done: boolean;
  sides: FlowCheckSide[];
  /**
   * M4: the side that carries the code lines has been checked, and its code lines (every check digit
   * right) give an expiry date before today (Douala). The rider is asked to use another document, or
   * to continue anyway (the case keeps the hard flag document_expired). Never set from printed text
   * alone. A rider app treats a missing value as false.
   */
  expired: boolean;
}

/** How long the rider waits for the server checks, and how often the app asks. */
export const CHECKS_WAIT_MS = 20_000;
export const CHECKS_POLL_MS = 2_000;
/** Server-requested retakes allowed per side; after that the photo is flagged, never refused. */
export const SERVER_RETAKES_PER_SIDE = 1;

// ---------------------------------------------------------------------------
// Worker API (M3). Edge Function "worker", called only by the AI worker (Vercel, Python).
//   POST /worker/claim   {}                          -> WorkerClaimResponse, or 204 when there is no job
//   POST /worker/image   WorkerImageRequest          -> the JPEG bytes (410 when the photo is gone)
//   POST /worker/result  WorkerResultRequest         -> WorkerResultResponse
// Every request is signed by the worker with Ed25519 (headers below) over
//   `${WORKER_SIGNATURE_VERSION}|${WORKER_AUDIENCE}|${kid}|${method}|${path}|${timestamp}|${nonce}|${sha256hex(body)}`
// where path is the route as the function sees it ("/claim", "/image", "/result"), timestamp is in
// Unix seconds (accepted within WORKER_SIGNATURE_WINDOW_S) and nonce is 32 hex characters, used once.
// The server verifies the raw body bytes before parsing them.
// ---------------------------------------------------------------------------
export const WORKER_SIGNATURE_VERSION = "v1";
/** Audience: binds a signature to this project's worker function. */
export const WORKER_AUDIENCE = "confiance-verify/worker";
export const WORKER_SIGNATURE_WINDOW_S = 60;
export const WORKER_HEADERS = {
  keyId: "x-worker-key-id",
  timestamp: "x-worker-timestamp",
  nonce: "x-worker-nonce",
  signature: "x-worker-signature",
} as const;

export interface WorkerClaimResponse {
  jobId: string;
  attempt: number;
  captureId: string;
  side: CaptureSide;
  declaredDocument: DeclaredDocument;
  /** Where the MRZ should be for the declared document (null when it has none). */
  mrzExpectation: MrzExpectation | null;
  /** The worker checks the downloaded bytes against this. */
  image: { sha256: string; byteSize: number; width: number; height: number };
}

export interface WorkerImageRequest {
  jobId: string;
  attempt: number;
}

/** Quality measured on the server (port of packages/capture). Provisional until tuned. */
export interface WorkerQuality {
  /**
   * The phone's noise-free focus score at a standard contrast (analyzeFrame's `focus` in
   * packages/capture), compared with DEFAULT_THRESHOLDS.minSharpness (5). Not the raw Laplacian
   * variance that ClientQuality.sharpness carries.
   */
  sharpness: number;
  glareRatio: number;
  meanLuma: number;
  documentFound: boolean;
  /** 0..1 */
  documentConfidence: number;
  longSide: number;
  /** Lines of text the OCR found (any content). */
  textLines: number;
}

/**
 * Keyword groups the worker counts (the keys of WorkerClassificationEvidence.keywordHits; the phrases
 * are in worker/verify_worker/classify.py). Generic names only: "residence" counts the titles of every
 * foreigner card together (carte de séjour, carte de résident, refugee card), so a count never reveals
 * which card it is. republic, field_labels and specimen are supporting evidence; the others each point
 * to one document family. The server refuses any other key.
 *
 * The counts stay in the job's evidence (worker_job.evidence, never readable by staff) and never reach
 * check_result: on a passport, the "republic" header (RÉPUBLIQUE DU CAMEROUN) and how many labels or
 * titles are printed tell a Cameroonian passport from a foreign one, which is the holder's nationality.
 */
export const KEYWORD_GROUPS = [
  "republic",
  "national_id",
  "passport",
  "residence",
  "driving_licence",
  "voter_card",
  "field_labels",
  "specimen",
] as const;
export type KeywordGroup = (typeof KEYWORD_GROUPS)[number];

export interface WorkerClassificationEvidence {
  /** Rotation of the image that gave the most text, in degrees clockwise. */
  rotation: 0 | 90 | 180 | 270;
  /** Hits per keyword group (accents and case removed, up to 2 wrong characters). Counts only. */
  keywordHits: Partial<Record<KeywordGroup, number>>;
  /** A QR code was detected (its content is never read out or stored). */
  qrPresent: boolean;
  /** Orientation of the document's printed text block. */
  orientation: "landscape" | "portrait" | null;
}

/** Fields read from the printed text. Values are encrypted by the server; only names reach check_result. */
export interface WorkerFields {
  surname?: string;
  givenNames?: string;
  documentNumber?: string;
  /** ISO dates (YYYY-MM-DD), or the raw text when the date is partial. */
  birthDate?: string;
  expiryDate?: string;
  issueDate?: string;
  /** Card family read from the printed title (e.g. "carte_de_sejour", "refugee"). Sensitive: encrypted only. */
  subtype?: string;
}

/**
 * The card families the worker reads into WorkerFields.subtype (SUBTYPES in
 * worker/verify_worker/classify.py, kept in sync by its tests). The server accepts any lower-case code,
 * so a family added to the worker first is stored, never refused; the dashboard names these ones.
 */
export const CARD_SUBTYPES = ["refugee", "carte_de_resident", "carte_de_sejour"] as const;
export type CardSubtype = (typeof CARD_SUBTYPES)[number];

export interface WorkerResultRequest {
  jobId: string;
  attempt: number;
  /** Worker build, e.g. "worker-1/rapidocr-3.10.0/ppocrv6". */
  engine: string;
  quality: WorkerQuality;
  /**
   * Candidate MRZ lines, already mapped to A-Z, 0-9 and '<' (the server runs the shared corrector
   * and parser on them). Empty when none were found.
   */
  mrzCandidates: string[];
  classification: WorkerClassificationEvidence;
  fields: WorkerFields;
  /** Processing time of this image, and whether the models had to be loaded first. */
  timing: { ms: number; cold: boolean };
}

export interface WorkerResultResponse {
  /** "already_done" when an earlier attempt's result was recorded first (it wins). */
  status: "recorded" | "already_done";
}

export const WORKER_LIMITS = {
  maxBodyBytes: 32 * 1024,
  maxMrzCandidates: 8,
  maxCandidateLength: 60,
  maxFieldLength: 80,
  maxKeywordGroups: 16,
  maxEngineLength: 60,
} as const;

// ---------------------------------------------------------------------------
// Server check results (M3), stored in check_result.details. Supervisors and admins can read
// check_result directly: outcomes, generic codes, counts and metrics only. Never values read from
// the document, never the card sub-type (refugee...), never nationality.
// ---------------------------------------------------------------------------
export const SERVER_CHECK_NAMES = {
  quality: "quality_server",
  mrz: "mrz_server",
  fields: "ocr_fields",
  classification: "classification",
  policy: "document_policy",
  /** M4: the document compared with itself and with today's date (one per case). */
  consistency: "consistency",
} as const;

export interface QualityServerDetails {
  verdict: "ok" | "poor" | RetakeReason;
  quality: WorkerQuality;
  /** True until the thresholds are tuned on real photos: never decides on its own. */
  provisional: true;
  engine: string;
  timing: { ms: number; cold: boolean };
}

export interface MrzServerDetails {
  parserVersion: string;
  /** A complete MRZ of the expected format was read from the image. */
  found: boolean;
  format: MrzFormat | null;
  checks: MrzCheckDetails["checks"];
  documentCodeFits: boolean | null;
  datesValid: boolean | null;
  corrections: number;
  /** Comparison with the phone's report for the same capture. */
  phone: "agrees" | "differs" | "missing" | "unreadable";
}

export interface OcrFieldsDetails {
  /** Names of the fields found (never their values). */
  found: (keyof WorkerFields)[];
  provisional: boolean;
}

/** Generic document families: the same values as the database enum document_type. */
export const DETECTED_DOCUMENT_TYPES = [
  "cni_legacy",
  "cni_biometric",
  "passport",
  "residence_permit",
  "driving_licence",
  "voter_card",
  "unknown",
] as const;
export type DetectedDocumentType = (typeof DETECTED_DOCUMENT_TYPES)[number];

export interface ClassificationDetails {
  detected: DetectedDocumentType;
  /** Decided from the MRZ (firm), or from keywords and layout (provisional). */
  basis: "mrz" | "keywords" | "none";
  provisional: boolean;
  /** Whether the detected family matches what the rider declared. */
  matchesDeclared: boolean | null;
  /** 0..1 */
  confidence: number;
  qrPresent: boolean | null;
  // No keyword counts: they would tell a Cameroonian passport from a foreign one (see KEYWORD_GROUPS).
  // The database refuses any other key (private.worker_apply_case).
}

/** The only keys of ClassificationDetails, in order (the database and the dashboard keep to them). */
export const CLASSIFICATION_DETAIL_KEYS = [
  "detected",
  "basis",
  "provisional",
  "matchesDeclared",
  "confidence",
  "qrPresent",
] as const satisfies readonly (keyof ClassificationDetails)[];

// ---------------------------------------------------------------------------
// Consistency checks (M4), stored in check_result.details of the case-level check "consistency".
// Generic codes only: never a value read from the document, never which value disagreed.
// ---------------------------------------------------------------------------
/**
 * document_expired: the expiry date is before today (Douala). under_18: the holder is under 18 today.
 * mrz_print_mismatch: a printed field disagrees with the code lines. date_logic: the dates contradict
 * each other or today (birth, issue, expiry). number_format: the document number does not fit the
 * format known for the declared document.
 */
export const CONSISTENCY_FLAGS = [
  "document_expired",
  "under_18",
  "mrz_print_mismatch",
  "date_logic",
  "number_format",
] as const;
export type ConsistencyFlag = (typeof CONSISTENCY_FLAGS)[number];

/**
 * Hard flags (PM, 2026-10-15): such a case is never approved automatically once automatic decisions
 * exist (M8), and the dashboard shows them apart.
 */
export const HARD_FLAGS: readonly ConsistencyFlag[] = ["document_expired", "under_18"];

/** Kinds of field a printed value and the code lines can disagree on (mrz_print_mismatch). */
export const MISMATCH_KINDS = ["name", "number", "birth_date", "expiry_date"] as const;
export type MismatchKind = (typeof MISMATCH_KINDS)[number];

export interface ConsistencyDetails {
  /** Firm flags (and under_18 from printed text, PM decision): each is also a document_policy reason. */
  flags: ConsistencyFlag[];
  /** From printed text whose format is not confirmed yet: shown as provisional, never a reason. */
  provisional: ConsistencyFlag[];
  /** What the dates and the number came from: code lines (every check digit right), printed text, or nothing. */
  basis: "mrz" | "printed" | "none";
  /** With mrz_print_mismatch: which kinds of field disagree (never their values). */
  mismatches: MismatchKind[];
}

/** The only keys of ConsistencyDetails (the database refuses any other). */
export const CONSISTENCY_DETAIL_KEYS = [
  "flags",
  "provisional",
  "basis",
  "mismatches",
] as const satisfies readonly (keyof ConsistencyDetails)[];

/** "Today" for expiry and age: the date in Douala (UTC+1, no daylight saving time). */
export const CONSISTENCY_TIME_ZONE = "Africa/Douala";

/**
 * Generic reasons a person must decide, in the order the dashboard lists them: the hard flags first.
 * No reason reveals the card sub-type or nationality. Since M4 the firm consistency flags are reasons too.
 */
export const POLICY_REASONS = [
  "document_expired",
  "under_18",
  "mrz_print_mismatch",
  "date_logic",
  "number_format",
  "manual_review_document",
  "unsupported_document",
  "unrecognised_document",
  "type_mismatch",
  "mrz_disagreement",
  "mrz_invalid_server",
  "mrz_unreadable_server",
  "phone_report_missing",
  "provisional_classification",
  "server_unchecked",
] as const;
export type PolicyReason = (typeof POLICY_REASONS)[number];

export interface DocumentPolicyDetails {
  reasons: PolicyReason[];
}

// ---------------------------------------------------------------------------
// Admin API (staff dashboard). Edge Function "admin".
//   POST /admin/enroll         EnrollRequest -> EnrollResponse             (public: proves possession of a one-time invite code)
//   POST /admin/test-sessions  TestSessionRequest -> TestSessionResponse   (staff token; supervisor or admin)
//   POST /admin/captures/view  CaptureViewRequest -> CaptureViewResponse   (staff token; supervisor, or the assigned reviewer; never admin)
//   POST /admin/document-data  DocumentDataRequest -> DocumentDataResponse (staff token; supervisor, or the assigned reviewer; never admin; M2)
// Staff token = `Authorization: Bearer <access token>` from supabase.auth.signInWithPassword.
// ---------------------------------------------------------------------------

/** Staff passwords: at least this many characters (Supabase's own minimum is lower). */
export const STAFF_PASSWORD_MIN_LENGTH = 12;
/** Supabase Auth (bcrypt) refuses passwords over 72 bytes; see also STAFF_PASSWORD_MAX_BYTES. */
export const STAFF_PASSWORD_MAX_LENGTH = 72;

export interface EnrollRequest {
  email: string;
  /** One-time invite code given to the new staff member by an administrator. */
  code: string;
  password: string;
}

export interface EnrollResponse {
  /** The account is ready; sign in with signInWithPassword(email, password). */
  ok: true;
}

export interface TestSessionRequest {
  locale?: "fr" | "en";
}

export interface TestSessionResponse {
  verificationId: string;
  /** Rider link carrying the session token in the URL fragment (#s=...), never in the query string. */
  riderUrl: string;
  expiresAt: string;
}

export interface CaptureViewRequest {
  captureId: string;
}

export interface CaptureViewResponse {
  /** Signed link to the image, valid for `expiresIn` seconds. */
  url: string;
  expiresIn: number;
}

export interface DocumentDataRequest {
  verificationId: string;
}

/** Code lines, as read on the phone (M2) or by the server's worker (M3). */
export interface DocumentDataLinesItem {
  captureId: string;
  source: "mrz_phone" | "mrz_server";
  format: MrzFormat;
  /** Raw MRZ lines; parse them with parseMrz from mrz.ts. */
  lines: string[];
  recordedAt: string;
}

/** Printed fields read by the server's worker (M3). Provisional until tuned on real documents. */
export interface DocumentDataFieldsItem {
  captureId: string;
  source: "ocr_server";
  fields: WorkerFields;
  recordedAt: string;
}

/** Decrypted data read from the document. Every request is audited before anything is decrypted. */
export type DocumentDataItem = DocumentDataLinesItem | DocumentDataFieldsItem;

export interface DocumentDataResponse {
  items: DocumentDataItem[];
  /** How long the dashboard may keep showing the data, in seconds. */
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// Errors: every non-2xx response body is { error: { code, message } }.
// ---------------------------------------------------------------------------
export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "forbidden_role",
  "not_found",
  "invalid_session",
  "session_expired",
  "already_submitted",
  "consent_required",
  "document_type_required",
  "invalid_kind",
  "missing_sides",
  "too_many_uploads",
  "upload_missing",
  "invalid_image",
  "image_too_small",
  "image_too_large",
  "image_resolution_too_low",
  "invalid_mrz",
  "invalid_signature",
  "replayed_request",
  "image_gone",
  "audit_failed",
  "invalid_invite",
  "weak_password",
  "server_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

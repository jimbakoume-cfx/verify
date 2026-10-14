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
  /** Longest side of the uploaded crop, in pixels. */
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

/** Decrypted data read from the document. Every request is audited before anything is decrypted. */
export interface DocumentDataItem {
  captureId: string;
  /** Where the data came from: "mrz_phone" = MRZ read on the rider's phone (M2). */
  source: "mrz_phone";
  format: MrzFormat;
  /** Raw MRZ lines; parse them with parseMrz from mrz.ts. */
  lines: string[];
  recordedAt: string;
}

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
  "audit_failed",
  "invalid_invite",
  "weak_password",
  "server_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

// Single source of truth for the HTTP contract between the web apps and the Edge Functions.
// Imported by Deno (Edge Functions) and, via packages/shared/src/flowApi.ts, by the web apps.
// Keep this file dependency-free: types and constants only, no imports.

// ---------------------------------------------------------------------------
// Documents and capture sides
// ---------------------------------------------------------------------------

/** What the rider says they are holding. The classifier (M3) decides the exact type/version. */
export const DECLARED_DOCUMENTS = [
  "cni",
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
  cni: ["document_front", "document_back"],
  passport: ["document_front"], // the data page only
  residence_permit: ["document_front", "document_back"],
  driving_licence: ["document_front", "document_back"],
  voter_card: ["document_front", "document_back"],
};

/** Width / height of the capture guide for each document (ID-1 card = 85.60 x 53.98 mm; passport TD3 page = 125 x 88 mm). */
export const DOCUMENT_ASPECT: Record<DeclaredDocument, number> = {
  cni: 85.6 / 53.98,
  passport: 125 / 88,
  residence_permit: 85.6 / 53.98,
  driving_licence: 85.6 / 53.98,
  voter_card: 85.6 / 53.98,
};

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
  /** Server rejects crops whose longest side is smaller (too little detail for OCR/MRZ). */
  minLongSide: 800,
  /** Upload links a single session may request (bounds storage abuse). */
  maxUploadUrlsPerSession: 20,
} as const;

/** Version label of the consent wording shown to the rider. Replace when the lawyer's text arrives. */
export const CONSENT_VERSION = "placeholder-v0";

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
//   POST /flow/submit
// All except upload-url and captures return FlowSession.
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
  /** True when the identical image was already uploaded in another verification. */
  reusedElsewhere: boolean;
}

// ---------------------------------------------------------------------------
// Admin API (staff dashboard). Edge Function "admin". Auth: `Authorization: Bearer <staff access token>`.
//   POST /admin/test-sessions  TestSessionRequest -> TestSessionResponse   (supervisor or admin)
//   POST /admin/captures/view  CaptureViewRequest -> CaptureViewResponse   (supervisor, or the assigned reviewer; never admin)
// ---------------------------------------------------------------------------
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
  "audit_failed",
  "server_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

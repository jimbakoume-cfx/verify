// Error codes the rider can meet: the server's ErrorCode (contract.ts) plus failures that never
// reach the server. Each code has FR/EN text under `errors.<code>` in the locale files.
import { ERROR_CODES, type ErrorCode } from "@verify/shared";

/** Failures detected in the browser (no server error body to read). */
export const CLIENT_ERROR_CODES = [
  /** fetch failed: offline, DNS, CORS refusal or connection reset. */
  "network",
  /** No answer within the time limit. */
  "timeout",
  /** The app was built without VITE_SUPABASE_URL / key. */
  "not_configured",
  /** A response we cannot interpret (e.g. a gateway error page). */
  "unexpected",
  /** The storage upload was refused for a reason other than a duplicate. */
  "storage_failed",
  /** M5: the face check stopped half-way (the page was hidden): it must start again. */
  "interrupted",
] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
export type FlowErrorCode = ErrorCode | ClientErrorCode;

export const ALL_ERROR_CODES: readonly FlowErrorCode[] = [...ERROR_CODES, ...CLIENT_ERROR_CODES];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** A failed call, typed by code; `status` is the HTTP status (0 when there was no response). */
export class FlowError extends Error {
  constructor(
    readonly code: FlowErrorCode,
    readonly status = 0,
  ) {
    super(code);
    this.name = "FlowError";
  }
}

export function toFlowError(err: unknown): FlowError {
  return err instanceof FlowError ? err : new FlowError("unexpected");
}

/** i18n key of the rider-facing message for a code. */
export function errorMessageKey(code: FlowErrorCode): `errors.${FlowErrorCode}` {
  return `errors.${code}`;
}

export type SessionErrorReason = "invalid" | "expired" | "already_submitted";

/** Codes that end the session for this link: the rider needs a new link from the app. */
export function sessionErrorReason(code: FlowErrorCode): SessionErrorReason | null {
  switch (code) {
    case "invalid_session":
      return "invalid";
    case "session_expired":
      return "expired";
    case "already_submitted":
      return "already_submitted";
    default:
      return null;
  }
}

const IMAGE_REJECTIONS: readonly FlowErrorCode[] = [
  "invalid_image",
  "image_too_small",
  "image_too_large",
  "image_resolution_too_low",
];

/** The server refused the photo itself (and deleted it): the rider must take it again. */
export function isImageRejection(code: FlowErrorCode): boolean {
  return IMAGE_REJECTIONS.includes(code);
}

const TRANSIENT: readonly FlowErrorCode[] = [
  "network",
  "timeout",
  "server_error",
  "upload_missing",
  "storage_failed",
];

/** Worth retrying automatically: the same request may succeed a moment later. */
export function isTransient(error: FlowError): boolean {
  return TRANSIENT.includes(error.code) || error.status >= 500 || error.status === 408;
}

import { ERROR_CODES, type ErrorCode } from "@verify/shared";

/** Server error codes plus the two failures that happen before a server answers. */
export type ClientErrorCode = ErrorCode | "network" | "not_configured";

export class ClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number | null;

  constructor(code: ClientErrorCode, status: number | null = null) {
    super(code);
    this.name = "ClientError";
    this.code = code;
    this.status = status;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** Error code from an Edge Function response: the body's code, or a guess from the status. */
export function errorCodeFromResponse(status: number, body: unknown): ErrorCode {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (isErrorCode(code)) return code;
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400) return "bad_request";
  return "server_error";
}

export function toClientError(error: unknown): ClientError {
  if (error instanceof ClientError) return error;
  // fetch() rejects with a TypeError when the network or CORS fails.
  if (error instanceof TypeError) return new ClientError("network");
  return new ClientError("server_error");
}

/** Where an error happened: the same code can deserve a more specific message. */
export type ErrorContext = "default" | "enroll" | "testSession" | "photo";

const CONTEXT_KEYS: Record<ErrorContext, Partial<Record<ClientErrorCode, string>>> = {
  default: {},
  enroll: { bad_request: "errors.enrollBadRequest" },
  testSession: { forbidden_role: "errors.testSessionRole" },
  photo: { forbidden_role: "errors.adminNoImageAccess", not_found: "errors.photoNotFound" },
};

/** i18n key of the message to show for an error code. */
export function errorMessageKey(code: ClientErrorCode, context: ErrorContext = "default"): string {
  return CONTEXT_KEYS[context][code] ?? `errors.${code}`;
}

/** Every key errorMessageKey can return, so tests can check each has FR and EN text. */
export function allErrorMessageKeys(): string[] {
  const codes: ClientErrorCode[] = [...ERROR_CODES, "network", "not_configured"];
  const keys = new Set<string>();
  for (const context of Object.keys(CONTEXT_KEYS) as ErrorContext[]) {
    for (const code of codes) keys.add(errorMessageKey(code, context));
  }
  return [...keys];
}

/**
 * Sign-in failures from Supabase Auth. Wrong email, wrong password and unknown account all get
 * the same message so the form does not reveal which addresses are staff.
 */
export function signInErrorKey(error: { name?: string; status?: number; code?: string } | null | undefined): string {
  if (!error) return "signIn.errors.invalidCredentials";
  if (error.name === "AuthRetryableFetchError" || error.status === 0) return "errors.network";
  if (error.status === 429 || error.code === "over_request_rate_limit") return "signIn.errors.rateLimited";
  if (error.status !== undefined && error.status >= 500) return "errors.server_error";
  return "signIn.errors.invalidCredentials";
}

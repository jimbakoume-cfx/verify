// Client for the `admin` Edge Function (contract.ts, "Admin API").
import {
  type CaptureViewRequest,
  type CaptureViewResponse,
  type DecisionRequest,
  type DecisionResponse,
  type DocumentDataRequest,
  type DocumentDataResponse,
  type EnrollRequest,
  type EnrollResponse,
  functionUrl,
  SUPABASE_PUBLISHABLE_KEY,
  type TestSessionRequest,
  type TestSessionResponse,
  type ThresholdVersionRequest,
  type ThresholdVersionResponse,
} from "@verify/shared";
import { ClientError, errorCodeFromResponse } from "../lib/errors";

/**
 * POST a JSON body to /admin<path>. `accessToken` is the staff session's token; null for the
 * public /enroll route, which must not carry an Authorization header.
 */
async function postAdmin<T>(path: string, body: unknown, accessToken: string | null): Promise<T> {
  const base = functionUrl("admin");
  if (!base || !SUPABASE_PUBLISHABLE_KEY) throw new ClientError("not_configured");
  const headers: Record<string, string> = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    "content-type": "application/json",
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Nothing from these calls (tokens, signed links, document data) belongs in the HTTP cache.
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new ClientError("network");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ClientError(errorCodeFromResponse(response.status, payload), response.status);
  if (payload === null || typeof payload !== "object") throw new ClientError("server_error", response.status);
  return payload as T;
}

export function enroll(request: EnrollRequest): Promise<EnrollResponse> {
  return postAdmin<EnrollResponse>("/enroll", request, null);
}

export function createTestSession(accessToken: string, request: TestSessionRequest): Promise<TestSessionResponse> {
  return postAdmin<TestSessionResponse>("/test-sessions", request, accessToken);
}

export function viewCapture(accessToken: string, request: CaptureViewRequest): Promise<CaptureViewResponse> {
  return postAdmin<CaptureViewResponse>("/captures/view", request, accessToken);
}

/**
 * The decrypted data read from a case's documents (code lines, printed fields). The server records the
 * read in the audit log before decrypting.
 */
export function documentData(accessToken: string, request: DocumentDataRequest): Promise<DocumentDataResponse> {
  return postAdmin<DocumentDataResponse>("/document-data", request, accessToken);
}

/** M8: approve or reject a case (supervisor, or the assigned reviewer). Recorded and audited by the server. */
export function decide(accessToken: string, request: DecisionRequest): Promise<DecisionResponse> {
  return postAdmin<DecisionResponse>("/decisions", request, accessToken);
}

/** M8: a new threshold version (admins only), active at once. */
export function createThresholdVersion(accessToken: string, request: ThresholdVersionRequest): Promise<ThresholdVersionResponse> {
  return postAdmin<ThresholdVersionResponse>("/thresholds", request, accessToken);
}

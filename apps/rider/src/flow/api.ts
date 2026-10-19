// Typed client for the rider "flow" Edge Function (contract.ts, "Flow API").
import {
  SESSION_TOKEN_HEADER,
  type CaptureCompleteRequest,
  type CaptureCompleteResponse,
  type ConsentRequest,
  type DocumentTypeRequest,
  type FlowChecks,
  type FlowSession,
  type LivenessCaptureRequest,
  type LivenessCaptureResponse,
  type LivenessChallengeResponse,
  type MrzReportRequest,
  type MrzReportResponse,
  type UploadUrlRequest,
  type UploadUrlResponse,
} from "@verify/shared";
import { FlowError, isErrorCode } from "./errors";

export interface FlowApi {
  getSession(): Promise<FlowSession>;
  consent(body: ConsentRequest): Promise<FlowSession>;
  setDocumentType(body: DocumentTypeRequest): Promise<FlowSession>;
  uploadUrl(body: UploadUrlRequest): Promise<UploadUrlResponse>;
  completeCapture(body: CaptureCompleteRequest): Promise<CaptureCompleteResponse>;
  /** What the phone read from the MRZ of a capture (M2). */
  reportMrz(body: MrzReportRequest): Promise<MrzReportResponse>;
  /** The server's check of each photo sent (M3). `signal` abandons the request (time is up). */
  getChecks(signal?: AbortSignal): Promise<FlowChecks>;
  /** M5: a new face-check challenge, with its upload slots. */
  livenessChallenge(): Promise<LivenessChallengeResponse>;
  /** M5: the report of a face check's frames, once they are uploaded. */
  recordLiveness(body: LivenessCaptureRequest): Promise<LivenessCaptureResponse>;
  submit(): Promise<FlowSession>;
}

export interface FlowApiOptions {
  /** `${VITE_SUPABASE_URL}/functions/v1/flow`, or null when the app is not configured. */
  baseUrl: string | null;
  token: string;
  /** The public publishable key, sent as `apikey` for the Supabase gateway. */
  apiKey: string | undefined;
  fetch?: typeof fetch;
  /** Per request; generous because riders are often on slow mobile networks. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Turns a non-2xx response into a FlowError, trusting only codes the contract defines. */
export async function errorFromResponse(res: Response): Promise<FlowError> {
  let code: unknown;
  try {
    code = ((await res.json()) as { error?: { code?: unknown } } | null)?.error?.code;
  } catch {
    // Not JSON (e.g. a gateway error page).
  }
  if (isErrorCode(code)) return new FlowError(code, res.status);
  return new FlowError(res.status >= 500 ? "server_error" : "unexpected", res.status);
}

export function createFlowApi(options: FlowApiOptions): FlowApi {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!options.baseUrl || !options.apiKey) throw new FlowError("not_configured");
    const headers: Record<string, string> = {
      [SESSION_TOKEN_HEADER]: options.token,
      apikey: options.apiKey,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    // Our own time limit, or the caller giving up: either way the request ends as a "timeout".
    // (AbortSignal.any is too recent for some of the riders' phones.)
    if (signal?.aborted) throw new FlowError("timeout");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort);
    let res: Response;
    try {
      res = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new FlowError(controller.signal.aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    if (!res.ok) throw await errorFromResponse(res);
    try {
      return (await res.json()) as T;
    } catch {
      throw new FlowError("unexpected", res.status);
    }
  }

  return {
    getSession: () => call<FlowSession>("GET", "/session"),
    consent: (body) => call<FlowSession>("POST", "/consent", body),
    setDocumentType: (body) => call<FlowSession>("POST", "/document-type", body),
    uploadUrl: (body) => call<UploadUrlResponse>("POST", "/upload-url", body),
    completeCapture: (body) => call<CaptureCompleteResponse>("POST", "/captures", body),
    reportMrz: (body) => call<MrzReportResponse>("POST", "/mrz", body),
    getChecks: (signal) => call<FlowChecks>("GET", "/checks", undefined, signal),
    livenessChallenge: () => call<LivenessChallengeResponse>("POST", "/liveness/challenge", {}),
    recordLiveness: (body) => call<LivenessCaptureResponse>("POST", "/liveness/captures", body),
    submit: () => call<FlowSession>("POST", "/submit", {}),
  };
}

// Typed client for the rider "flow" Edge Function (contract.ts, "Flow API").
import {
  SESSION_TOKEN_HEADER,
  type CaptureCompleteRequest,
  type CaptureCompleteResponse,
  type ConsentRequest,
  type DocumentTypeRequest,
  type FlowSession,
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

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!options.baseUrl || !options.apiKey) throw new FlowError("not_configured");
    const headers: Record<string, string> = {
      [SESSION_TOKEN_HEADER]: options.token,
      apikey: options.apiKey,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    submit: () => call<FlowSession>("POST", "/submit", {}),
  };
}

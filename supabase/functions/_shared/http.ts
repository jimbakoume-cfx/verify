// HTTP plumbing shared by the flow and admin functions: JSON and error responses, CORS, routing,
// bounded body reading. Every non-2xx body is { error: { code, message } } (contract.ts).
import type { ApiErrorBody, ErrorCode } from "./contract.ts";
import { MAX_BODY_BYTES } from "./config.ts";
import { consoleLogger, type Logger } from "./log.ts";

// Messages are for developers and logs; the apps show their own FR/EN text for each code.
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  bad_request: "The request is not valid.",
  unauthorized: "Sign-in required or expired.",
  forbidden: "No staff access.",
  forbidden_role: "Your role does not allow this action.",
  not_found: "Not found.",
  invalid_session: "Unknown verification session.",
  session_expired: "This verification session has expired.",
  already_submitted: "This verification has already been submitted.",
  consent_required: "Consent is required first.",
  document_type_required: "Choose the document type first.",
  invalid_kind: "This side is not needed for the chosen document.",
  missing_sides: "A required side has not been captured.",
  too_many_uploads: "Too many uploads for this session.",
  upload_missing: "The uploaded image was not found.",
  invalid_image: "The file is not a valid JPEG image.",
  image_too_small: "The image file is too small.",
  image_too_large: "The image file is too large.",
  image_resolution_too_low: "The image resolution is too low.",
  audit_failed: "The access could not be recorded, so it was refused.",
  invalid_invite: "The email or invite code is not valid.",
  weak_password: "The password does not meet the requirements.",
  server_error: "Something went wrong. Please try again.",
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string = DEFAULT_MESSAGES[code],
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string = DEFAULT_MESSAGES[code],
  headers: Record<string, string> = {},
): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return jsonResponse(status, body, headers);
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
export const ALLOWED_METHODS = "GET, POST, OPTIONS";
export const ALLOWED_HEADERS = "content-type, authorization, apikey, x-session-token";

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
export type Handler = (req: Request) => Promise<Response>;
export type RouteTable = Record<string, Partial<Record<"GET" | "POST", Handler>>>;

export interface RouterOptions {
  /** Function name, e.g. "flow": both "/flow/session" and "/session" route to "/session". */
  name: string;
  routes: RouteTable;
  allowedOrigins: ReadonlySet<string>;
  log?: Logger;
}

/** Path inside the function, without the optional /functions/v1 and /<name> prefixes or a trailing slash. */
export function routePath(pathname: string, name: string): string {
  let path = pathname;
  if (path.startsWith("/functions/v1/")) path = path.slice("/functions/v1".length);
  if (path === `/${name}` || path.startsWith(`/${name}/`)) path = path.slice(name.length + 1);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path || "/";
}

export function createRouter(options: RouterOptions): Handler {
  const log = options.log ?? consoleLogger;
  return async (req) => {
    const origin = req.headers.get("origin");
    // Browsers always send Origin on these cross-origin calls; a disallowed one is refused outright.
    // Requests without Origin (server-side tools) carry no browser credentials, so CORS does not apply.
    if (origin !== null && !options.allowedOrigins.has(origin)) {
      return errorResponse(403, "forbidden", "Origin not allowed.");
    }
    const cors = origin === null ? {} : corsHeaders(origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "cache-control": "no-store" } });
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return errorResponse(405, "bad_request", "Method not allowed.", { ...cors, allow: ALLOWED_METHODS });
    }

    try {
      const length = req.headers.get("content-length");
      if (length !== null && !(Number(length) <= MAX_BODY_BYTES)) {
        throw new HttpError(413, "bad_request", "Request body too large.");
      }
      const path = routePath(new URL(req.url).pathname, options.name);
      const methods = Object.hasOwn(options.routes, path) ? options.routes[path] : undefined;
      if (!methods) throw new HttpError(404, "not_found");
      const handler = methods[req.method];
      if (!handler) {
        const allow = [...Object.keys(methods), "OPTIONS"].join(", ");
        throw new HttpError(405, "bad_request", "Method not allowed.", { allow });
      }
      const res = await handler(req);
      for (const [key, value] of Object.entries(cors)) res.headers.set(key, value);
      return res;
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(err.status, err.code, err.message, { ...cors, ...err.headers });
      }
      log.error(`${options.name}.unhandled`, err);
      return errorResponse(500, "server_error", undefined, cors);
    }
  };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------
/**
 * Reads a JSON object body of at most MAX_BODY_BYTES, counting bytes as they stream in (Content-Length
 * may be absent or wrong). An empty body is {} only when allowEmpty is set.
 */
export async function readJsonObject(req: Request, { allowEmpty = false } = {}): Promise<Record<string, unknown>> {
  const bytes = await readLimited(req, MAX_BODY_BYTES);
  if (bytes.length === 0) {
    if (allowEmpty) return {};
    throw new HttpError(400, "bad_request", "A JSON body is required.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "bad_request", "The body is not valid JSON.");
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, "bad_request", "The body must be a JSON object.");
  return parsed;
}

async function readLimited(req: Request, limit: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "bad_request", "Request body too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function badRequest(message?: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

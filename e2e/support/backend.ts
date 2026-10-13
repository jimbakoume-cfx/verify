// An in-memory stand-in for the rider's side of the backend, installed with page.route: the "flow"
// Edge Function (rules from docs/M1_SPEC.md, types from contract.ts), the signed storage upload and
// the health RPC. It answers like the real server, records every request for assertions, and can
// inject faults (an expired session, failing uploads).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Page, Request, Route } from "@playwright/test";
import {
  CAPTURE_LIMITS,
  CAPTURE_SIDES,
  CONSENT_VERSION,
  DECLARED_DOCUMENTS,
  REQUIRED_SIDES,
  SESSION_TOKEN_HEADER,
  type CaptureSide,
  type ClientQuality,
  type DeclaredDocument,
  type ErrorCode,
  type FlowSession,
  type FlowStatus,
} from "../../supabase/functions/_shared/contract";
import { type JpegInfo, inspectJpeg } from "./jpeg";
import { readFilePart } from "./multipart";

/** What the rider app is built with for the E2E run (see playwright.config.ts). */
export const SUPABASE_URL = "http://127.0.0.1:54321";
export const PUBLISHABLE_KEY = "sb_publishable_e2e";
const BUCKET = "id-captures";
const FLOW_PREFIX = "/functions/v1/flow";
const UPLOAD_PREFIX = `/storage/v1/object/upload/sign/${BUCKET}/`;
const CAPTURE_PATH = /^[0-9a-f-]{36}\/(document_front|document_back)-[0-9a-f-]{36}\.jpg$/;
const QUALITY_KEYS = ["source", "sharpness", "glareRatio", "meanLuma", "framing", "videoWidth", "videoHeight", "elapsedMs"];

export interface FlowCall {
  /** e.g. "POST /upload-url" */
  route: string;
  body: unknown;
}

export interface StoredObject {
  /** Content type of the multipart file part (the bucket only accepts image/jpeg). */
  contentType: string | null;
  bytes: Buffer;
  jpeg: JpegInfo | null;
}

export interface StorageAttempt {
  path: string;
  status: number;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
  ) {
    super(code);
  }
}

export class FakeBackend {
  /** 32 random bytes in base64url, like the server's tokens. */
  readonly token = randomBytes(32).toString("base64url");
  readonly verificationId = randomUUID();

  /** Flow Edge Function calls, in order. */
  readonly calls: FlowCall[] = [];
  /** Every PUT to the signed upload URL, with the status answered. */
  readonly storageAttempts: StorageAttempt[] = [];
  /** Objects in the bucket, by path. */
  readonly objects = new Map<string, StoredObject>();
  /** Captures accepted by POST /captures, in order. */
  readonly captures: { path: string; kind: CaptureSide; quality: ClientQuality; object: StoredObject }[] = [];
  /** Requests the real backend would refuse or never receive: each one is a bug in the app. */
  readonly problems: string[] = [];

  status: FlowStatus = "created";
  consentGiven = false;
  declaredDocument: DeclaredDocument | null = null;
  readonly expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

  #expired = false;
  #failUploads: { count: number; status: number } = { count: 0, status: 503 };
  readonly #uploadTokens = new Map<string, { token: string; kind: CaptureSide }>();
  readonly #latest = new Map<CaptureSide, string>();

  /** From now on every flow call answers 410 session_expired, as after `session_expires_at`. */
  expire(): void {
    this.#expired = true;
  }

  /** The next `count` uploads to storage fail with `status` (default 503, a storage outage). */
  failUploads(count: number, status = 503): void {
    this.#failUploads = { count, status };
  }

  /** The flow routes called, e.g. ["GET /session", "POST /consent", ...]. */
  get routes(): string[] {
    return this.calls.map((c) => c.route);
  }

  session(): FlowSession {
    return {
      verificationId: this.verificationId,
      status: this.status,
      locale: "fr",
      consentGiven: this.consentGiven,
      declaredDocument: this.declaredDocument,
      requiredSides: this.declaredDocument ? [...REQUIRED_SIDES[this.declaredDocument]] : null,
      captures: [...this.#latest.keys()].map((kind) => ({ kind, createdAt: new Date().toISOString() })),
      expiresAt: this.expiresAt,
      isTest: true,
    };
  }

  async install(page: Page): Promise<void> {
    // Routes match in reverse order of registration: the catch-all goes first.
    await page.route(
      (url) => url.origin === SUPABASE_URL,
      (route) => {
        const req = route.request();
        if (req.method() !== "OPTIONS") this.problems.push(`unexpected request: ${req.method()} ${req.url()}`);
        return this.#reply(route, req.method() === "OPTIONS" ? 204 : 404, req.method() === "OPTIONS" ? null : { message: "not found" });
      },
    );
    await page.route(`${SUPABASE_URL}/rest/v1/rpc/health`, (route) =>
      route.request().method() === "OPTIONS" ? this.#reply(route, 204, null) : this.#reply(route, 200, "ok"),
    );
    await page.route(
      (url) => url.origin === SUPABASE_URL && url.pathname.startsWith(UPLOAD_PREFIX),
      (route) => this.#storage(route),
    );
    await page.route(
      (url) => url.origin === SUPABASE_URL && url.pathname.startsWith(FLOW_PREFIX),
      (route) => this.#flow(route),
    );
  }

  // Cross-origin from the app (localhost:<port> to 127.0.0.1:54321), so every answer needs CORS.
  #reply(route: Route, status: number, body: unknown): Promise<void> {
    const origin = route.request().headers()["origin"] ?? "*";
    return route.fulfill({
      status,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "authorization, apikey, content-type, x-session-token, x-client-info, x-upsert",
        "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
        vary: "origin",
        ...(body === null ? {} : { "content-type": "application/json" }),
      },
      body: body === null ? "" : JSON.stringify(body),
    });
  }

  async #flow(route: Route): Promise<void> {
    const req = route.request();
    if (req.method() === "OPTIONS") return this.#reply(route, 204, null);
    const path = new URL(req.url()).pathname.slice(FLOW_PREFIX.length) || "/";
    const name = `${req.method()} ${path}`;
    let body: unknown = null;
    try {
      body = req.postData() ? JSON.parse(req.postData() as string) : null;
    } catch {
      this.problems.push(`${name}: body is not JSON`);
    }
    this.calls.push({ route: name, body });
    this.#checkHeaders(name, req);
    try {
      return this.#reply(route, 200, this.#handle(name, body, req));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      return this.#reply(route, err.status, { error: { code: err.code, message: err.code } });
    }
  }

  #checkHeaders(name: string, req: Request): void {
    const headers = req.headers();
    if (headers["apikey"] !== PUBLISHABLE_KEY) this.problems.push(`${name}: missing or wrong apikey header`);
    if (headers["authorization"]) this.problems.push(`${name}: sends an Authorization header (riders never sign in)`);
  }

  /** Rejects a request the app should never send: the real server answers 400 bad_request. */
  #badRequest(name: string, why: string): never {
    this.problems.push(`${name}: ${why}`);
    throw new ApiError(400, "bad_request");
  }

  #handle(name: string, body: unknown, req: Request): unknown {
    if (req.headers()[SESSION_TOKEN_HEADER] !== this.token) throw new ApiError(401, "invalid_session");
    if (this.#expired) throw new ApiError(410, "session_expired");
    if (name === "GET /session") return this.session();
    if (this.status !== "created" && this.status !== "in_progress") throw new ApiError(409, "already_submitted");
    const input = (body ?? {}) as Record<string, unknown>;

    switch (name) {
      case "POST /consent": {
        if (input.consentVersion !== CONSENT_VERSION) this.#badRequest(name, `consentVersion ${String(input.consentVersion)}`);
        if (input.language !== "fr" && input.language !== "en") this.#badRequest(name, `language ${String(input.language)}`);
        this.consentGiven = true;
        this.status = "in_progress";
        return this.session();
      }
      case "POST /document-type": {
        if (!this.consentGiven) throw new ApiError(403, "consent_required");
        const doc = input.declaredDocument;
        if (!(DECLARED_DOCUMENTS as readonly unknown[]).includes(doc)) this.#badRequest(name, `declaredDocument ${String(doc)}`);
        this.declaredDocument = doc as DeclaredDocument;
        return this.session();
      }
      case "POST /upload-url": {
        if (!this.consentGiven) throw new ApiError(403, "consent_required");
        if (!this.declaredDocument) throw new ApiError(409, "document_type_required");
        const kind = input.kind as CaptureSide;
        if (!REQUIRED_SIDES[this.declaredDocument].includes(kind)) throw new ApiError(400, "invalid_kind");
        if (this.#uploadTokens.size >= CAPTURE_LIMITS.maxUploadUrlsPerSession) throw new ApiError(429, "too_many_uploads");
        const path = `${this.verificationId}/${kind}-${randomUUID()}.jpg`;
        const token = randomBytes(16).toString("hex");
        this.#uploadTokens.set(path, { token, kind });
        return { path, token, bucket: BUCKET };
      }
      case "POST /captures":
        return this.#completeCapture(name, input);
      case "POST /submit": {
        if (!this.declaredDocument) throw new ApiError(409, "missing_sides");
        if (REQUIRED_SIDES[this.declaredDocument].some((side) => !this.#latest.has(side))) throw new ApiError(409, "missing_sides");
        this.status = "submitted";
        return this.session();
      }
      default:
        this.problems.push(`unknown flow route: ${name}`);
        throw new ApiError(404, "not_found");
    }
  }

  #completeCapture(name: string, input: Record<string, unknown>): unknown {
    const { path, kind, quality } = input as { path: string; kind: CaptureSide; quality: ClientQuality };
    if (typeof path !== "string" || !path.startsWith(`${this.verificationId}/`)) this.#badRequest(name, `path ${String(path)}`);
    const match = CAPTURE_PATH.exec(path);
    if (!match || match[1] !== kind || !(CAPTURE_SIDES as readonly string[]).includes(kind)) this.#badRequest(name, `path/kind ${path} ${kind}`);
    this.#checkQuality(name, quality);

    const object = this.objects.get(path);
    if (!object) throw new ApiError(404, "upload_missing");
    const refuse = (code: ErrorCode): never => {
      this.objects.delete(path); // the server deletes a refused object
      throw new ApiError(422, code);
    };
    if (object.bytes.length < CAPTURE_LIMITS.minBytes) refuse("image_too_small");
    if (object.bytes.length > CAPTURE_LIMITS.maxBytes) refuse("image_too_large");
    if (!object.jpeg) refuse("invalid_image");
    if (Math.max(object.jpeg!.width, object.jpeg!.height) < CAPTURE_LIMITS.minLongSide) refuse("image_resolution_too_low");

    this.captures.push({ path, kind, quality, object });
    this.#latest.set(kind, path);
    return {
      captureId: randomUUID(),
      byteSize: object.bytes.length,
      width: object.jpeg!.width,
      height: object.jpeg!.height,
      sha256: createHash("sha256").update(object.bytes).digest("hex"),
      reusedElsewhere: false,
    };
  }

  #checkQuality(name: string, quality: unknown): void {
    if (typeof quality !== "object" || quality === null) this.#badRequest(name, "quality missing");
    const q = quality as Record<string, unknown>;
    const keys = Object.keys(q).sort();
    if (keys.join() !== [...QUALITY_KEYS].sort().join()) this.#badRequest(name, `quality keys ${keys.join()}`);
    if (q.source !== "auto" && q.source !== "manual") this.#badRequest(name, `quality.source ${String(q.source)}`);
    for (const key of QUALITY_KEYS.slice(1)) {
      if (typeof q[key] !== "number" || !Number.isFinite(q[key])) this.#badRequest(name, `quality.${key} ${String(q[key])}`);
    }
  }

  async #storage(route: Route): Promise<void> {
    const req = route.request();
    if (req.method() === "OPTIONS") return this.#reply(route, 204, null);
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname.slice(UPLOAD_PREFIX.length));
    const attempt = (status: number, body: unknown) => {
      this.storageAttempts.push({ path, status });
      return this.#reply(route, status, body);
    };
    if (req.method() !== "PUT") {
      this.problems.push(`storage: ${req.method()} ${url.pathname}`);
      return attempt(405, { statusCode: "405", error: "Method Not Allowed", message: "method not allowed" });
    }
    if (req.headers()["apikey"] !== PUBLISHABLE_KEY) this.problems.push("storage upload: missing or wrong apikey header");
    const issued = this.#uploadTokens.get(path);
    if (!issued || issued.token !== url.searchParams.get("token")) {
      this.problems.push(`storage upload with an unknown path or token: ${path}`);
      return attempt(400, { statusCode: "403", error: "Unauthorized", message: "invalid signature" });
    }
    if (this.#failUploads.count > 0) {
      this.#failUploads.count--;
      return attempt(this.#failUploads.status, { statusCode: String(this.#failUploads.status), error: "Unavailable", message: "e2e fault" });
    }
    if (this.objects.has(path)) {
      return attempt(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
    }
    const file = readFilePart(req.postDataBuffer() ?? Buffer.alloc(0), req.headers()["content-type"]);
    if (!file) {
      this.problems.push(`storage upload without a file part: ${path}`);
      return attempt(400, { statusCode: "400", error: "Bad Request", message: "no file" });
    }
    // The bucket only accepts image/jpeg (allowed_mime_types).
    if (file.contentType !== "image/jpeg") {
      this.problems.push(`storage upload with content type ${String(file.contentType)}`);
      return attempt(400, { statusCode: "415", error: "invalid_mime_type", message: "mime type not supported" });
    }
    this.objects.set(path, { contentType: file.contentType, bytes: Buffer.from(file.bytes), jpeg: inspectJpeg(file.bytes) });
    return attempt(200, { Key: `${BUCKET}/${path}`, Id: randomUUID() });
  }
}

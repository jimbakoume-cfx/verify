// Face worker API (contract.ts, "Face worker API"): the only door between the face worker (Vercel
// project confiance-verify-face, worker-face/) and the database, for the liveness evaluation (M6) and
// the face match (M7). It keeps every security property of the AI worker's API (worker/handler.ts):
// Ed25519 signatures over the raw body (for this function's own audience), a nonce used once, keys
// looked up in worker_key (scope "face" only), no storage URL ever handed out (the bytes are relayed,
// each relay audited first), no browser origin, and every decision taken here, not by the worker.
import type { AuditEntry } from "../_shared/audit.ts";
import {
  type DeclaredDocument,
  FACE_LIMITS,
  FACE_MATCH_CHECK_NAME,
  FACE_WORKER_AUDIENCE,
  type FaceClaimInput,
  type FaceClaimResponse,
  type FaceJobKind,
  type FaceResultResponse,
  type LivenessAction,
  LIVENESS_EVAL_CHECK_NAME,
  type LivenessTiming,
  WORKER_SIGNATURE_WINDOW_S,
} from "../_shared/contract.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import {
  badRequest,
  createRouter,
  type Handler,
  HttpError,
  jsonResponse,
  parseJsonObject,
  readBodyBytes,
  routePath,
} from "../_shared/http.ts";
import { consoleLogger, type Logger } from "../_shared/log.ts";
import {
  base64UrlDecode,
  canonicalString,
  ED25519_PUBLIC_KEY_BYTES,
  readSignatureHeaders,
  verifyEd25519,
  withinWindow,
} from "../worker/signature.ts";
import { decideFaceMatch, decideLiveness, FACE_MATCH_VERSION, LIVENESS_EVAL_VERSION } from "./decide.ts";
import { validateClaimBody, validateImageRequest, validateResultRequest } from "./validation.ts";

export interface FaceKey {
  publicKey: string;
  revoked: boolean;
}

export type FaceNonceResult = "ok" | "replayed" | "revoked";

/** face_claim. */
export interface ClaimedFaceJob {
  jobId: string;
  attempt: number;
  kind: FaceJobKind;
  testSession: boolean;
  declaredDocument: DeclaredDocument | null;
  actions: LivenessAction[];
  inputs: FaceClaimInput[];
}

/** face_image_lookup. */
export type FaceImageLookup =
  | { result: "ok"; verificationId: string; storagePath: string; byteSize: number }
  | { result: "gone" }
  | { result: "not_found" };

/** face_job_context: what the result of a job is decided against. */
export interface FaceJobContext {
  jobId: string;
  kind: FaceJobKind;
  verificationId: string;
  status: "pending" | "claimed" | "done" | "failed" | "superseded";
  attempts: number;
  /** Every input of the job is still live (not replaced or erased). */
  live: boolean;
  challengeId: string;
  actions: LivenessAction[];
  /** The inputs handed out at the last claim (empty before any claim). */
  inputs: { captureId: string; role: "frame" | "document"; index: number | null; step: number | null }[];
  /** When the job was created (the frames recorded); missing from a database before the real-test fixes. */
  createdAt?: string | null;
}

export interface FaceResultRecord {
  kid: string;
  jobId: string;
  attempt: number;
  checkName: typeof LIVENESS_EVAL_CHECK_NAME | typeof FACE_MATCH_CHECK_NAME;
  version: string;
  outcome: "pass" | "flag" | "fail";
  score: number | null;
  details: Record<string, unknown>;
  /** The worker's measures, kept with the job (never readable by staff). */
  evidence: Record<string, unknown>;
}

export type FaceRecordResult = "recorded" | "already_done" | "gone" | "not_found";

export interface FaceRepo {
  /** worker_key with scope "face"; null when unknown (or of another scope). */
  getKey(kid: string): Promise<FaceKey | null>;
  useNonce(kid: string, nonce: string, expiresAt: string): Promise<FaceNonceResult>;
  claim(): Promise<ClaimedFaceJob | null>;
  lookupImage(jobId: string, attempt: number, captureId: string): Promise<FaceImageLookup>;
  jobContext(jobId: string): Promise<FaceJobContext | null>;
  recordResult(record: FaceResultRecord): Promise<FaceRecordResult>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface FaceImageStorage {
  download(path: string): Promise<Blob | null>;
}

export interface FaceDeps {
  repo: FaceRepo;
  images: FaceImageStorage;
  now?: () => Date;
  log?: Logger;
}

export const NONCE_MARGIN_S = 60;

export function createFaceHandler(deps: FaceDeps): Handler {
  const { repo, images } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? consoleLogger;

  /** As worker/handler.ts: header shape, window, capped body, key, signature, then the nonce. */
  function signed(route: (signed: { kid: string; body: Uint8Array<ArrayBuffer> }) => Promise<Response>): Handler {
    return async (req) => {
      const headers = readSignatureHeaders(req.headers);
      if (!headers) throw new HttpError(401, "invalid_signature", "The signature headers are missing or malformed.");
      if (!withinWindow(headers.timestamp, now().getTime())) {
        throw new HttpError(401, "invalid_signature", "The timestamp is outside the accepted window.");
      }
      const body = await readBodyBytes(req, FACE_LIMITS.maxBodyBytes);
      const key = await repo.getKey(headers.kid);
      const publicKey = key && !key.revoked ? base64UrlDecode(key.publicKey, ED25519_PUBLIC_KEY_BYTES) : null;
      if (!publicKey) throw new HttpError(401, "invalid_signature", "Unknown or revoked key.");
      const message = canonicalString({
        kid: headers.kid,
        method: req.method,
        path: routePath(new URL(req.url).pathname, "face"),
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        bodySha256: await sha256Hex(body),
        audience: FACE_WORKER_AUDIENCE,
      });
      if (!(await verifyEd25519(publicKey, new TextEncoder().encode(message), headers.signature))) {
        throw new HttpError(401, "invalid_signature", "The signature does not match the request.");
      }
      const expiresAt = new Date((Number(headers.timestamp) + WORKER_SIGNATURE_WINDOW_S + NONCE_MARGIN_S) * 1000);
      const nonce = await repo.useNonce(headers.kid, headers.nonce, expiresAt.toISOString());
      if (nonce === "replayed") throw new HttpError(401, "replayed_request");
      if (nonce !== "ok") throw new HttpError(401, "invalid_signature", "Unknown or revoked key.");
      return route({ kid: headers.kid, body });
    };
  }

  const postClaim = signed(async ({ body }) => {
    const check = validateClaimBody(body.length === 0 ? null : parseJsonObject(body));
    if (!check.ok) throw badRequest(check.message);
    const job = await repo.claim();
    if (!job) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    const response: FaceClaimResponse = {
      jobId: job.jobId,
      attempt: job.attempt,
      kind: job.kind,
      testSession: job.testSession,
      declaredDocument: job.declaredDocument,
      actions: job.actions,
      inputs: job.inputs,
    };
    return jsonResponse(200, response);
  });

  // One input of the job, relayed: no image URL ever leaves Supabase, and never without a record.
  const postImage = signed(async ({ kid, body }) => {
    const check = validateImageRequest(parseJsonObject(body));
    if (!check.ok) throw badRequest(check.message);
    const { jobId, attempt, captureId } = check.value;
    const found = await repo.lookupImage(jobId, attempt, captureId);
    if (found.result === "not_found") throw new HttpError(404, "not_found", "No such input of a job attempt holding a lease.");
    if (found.result === "gone") throw new HttpError(410, "image_gone");
    const blob = await images.download(found.storagePath);
    if (!blob) throw new HttpError(410, "image_gone");
    try {
      await repo.audit({
        actorType: "system",
        actorId: kid,
        action: "face.image",
        targetType: "capture",
        targetId: captureId,
        details: { jobId, attempt, verificationId: found.verificationId, byteSize: blob.size },
      });
    } catch (err) {
      log.error("face.image_audit_failed", err);
      throw new HttpError(500, "audit_failed");
    }
    return new Response(blob, {
      status: 200,
      headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  });

  const postResult = signed(async ({ kid, body }) => {
    const check = validateResultRequest(parseJsonObject(body));
    if (!check.ok) throw badRequest(check.message);
    const result = check.value;
    const job = await repo.jobContext(result.jobId);
    if (!job || result.attempt > job.attempts) throw new HttpError(404, "not_found", "No such job attempt.");
    if (job.status === "done") return resultResponse("already_done");
    if (job.status === "superseded" || !job.live) throw new HttpError(410, "image_gone");
    if (job.kind !== result.kind) throw badRequest("kind is not the job's.");
    const frames = job.inputs.filter((input) => input.role === "frame");
    // How long the case waited for this result (fixes after the PM's first real test: the rider's
    // result must come within 10 s of the end of the face check). Logged and kept with the check.
    const created = job.createdAt ? Date.parse(job.createdAt) : Number.NaN;
    const sinceJobMs = Number.isFinite(created) ? Math.min(86_400_000, Math.max(0, now().getTime() - created)) : undefined;
    const timing: LivenessTiming = sinceJobMs === undefined ? { ...result.timing } : { ...result.timing, sinceJobMs };
    log.info?.("face.result_timing", { kind: result.kind, ...timing });

    let record: Omit<FaceResultRecord, "kid" | "jobId" | "attempt">;
    if (result.kind === "liveness") {
      const evidence = result.liveness!;
      const known = new Set(frames.map((f) => f.index));
      if (evidence.frames.some((f) => !known.has(f.index))) throw badRequest("liveness.frames names a frame the job does not have.");
      const decision = decideLiveness(evidence, {
        challengeId: job.challengeId,
        actions: job.actions,
        frames: frames.map((f) => ({ index: f.index ?? -1, step: f.step ?? -1 })),
        engine: result.engine,
        timing,
      });
      record = {
        checkName: LIVENESS_EVAL_CHECK_NAME,
        version: LIVENESS_EVAL_VERSION,
        outcome: decision.outcome,
        score: decision.score,
        details: decision.details as unknown as Record<string, unknown>,
        evidence: evidence as unknown as Record<string, unknown>,
      };
    } else {
      const evidence = result.faceMatch!;
      const document = job.inputs.find((input) => input.role === "document");
      if (!document) throw new HttpError(410, "image_gone");
      if (evidence.selfie.found) {
        const frame = frames.find((f) => f.captureId === evidence.selfie.captureId);
        if (!frame || frame.index !== evidence.selfie.frameIndex) throw badRequest("faceMatch.selfie is not a frame of the job.");
      }
      const decision = decideFaceMatch(evidence, { documentCaptureId: document.captureId, engine: result.engine, timing });
      record = {
        checkName: FACE_MATCH_CHECK_NAME,
        version: FACE_MATCH_VERSION,
        outcome: decision.outcome,
        score: decision.score,
        details: decision.details as unknown as Record<string, unknown>,
        evidence: evidence as unknown as Record<string, unknown>,
      };
    }
    const status = await repo.recordResult({ kid, jobId: result.jobId, attempt: result.attempt, ...record });
    if (status === "recorded" || status === "already_done") return resultResponse(status);
    if (status === "gone") throw new HttpError(410, "image_gone");
    throw new HttpError(404, "not_found", "No such job attempt.");
  });

  return createRouter({
    name: "face",
    // Never called from a browser: any request carrying an Origin header is refused.
    allowedOrigins: new Set(),
    log,
    maxBodyBytes: FACE_LIMITS.maxBodyBytes,
    routes: {
      "/claim": { POST: postClaim },
      "/image": { POST: postImage },
      "/result": { POST: postResult },
    },
  });
}

function resultResponse(status: FaceResultResponse["status"]): Response {
  const response: FaceResultResponse = { status };
  return jsonResponse(200, response);
}

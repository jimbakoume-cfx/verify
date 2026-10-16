// Worker API (contract.ts, "Worker API"): the only door between the AI worker (Vercel, Python) and the
// database. Routing, signature checks and decisions only: data access goes through the injected
// WorkerRepo / ImageStorage so every rule can be tested with in-memory fakes.
//
// Every request is signed by the worker (Ed25519, signature.ts). The raw body bytes are capped and
// verified before anything parses them, and each nonce is accepted once. The worker never sees a
// storage URL: the photo's bytes are relayed. Values read from a document (code lines, printed fields)
// pass through here on their way to the database, which encrypts them; they are never logged,
// audited or put into check_result.details.
import type { AuditEntry } from "../_shared/audit.ts";
import {
  type CaptureSide,
  type DeclaredDocument,
  MRZ_EXPECTATION,
  type MrzFormat,
  WORKER_LIMITS,
  WORKER_SIGNATURE_WINDOW_S,
  type WorkerClaimResponse,
  type WorkerResultResponse,
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
import { CASE_WRITE_ROUNDS, type CaseChecksPayload, type CaseSnapshot, decideCaseChecks } from "./case.ts";
import type { SideDocumentData } from "./consistency.ts";
import { type CaptureCheck, type CaptureEvidence, decideCapture } from "./decide.ts";
import {
  base64UrlDecode,
  canonicalString,
  ED25519_PUBLIC_KEY_BYTES,
  readSignatureHeaders,
  verifyEd25519,
  withinWindow,
} from "./signature.ts";
import { validateClaimBody, validateImageRequest, validateResultRequest } from "./validation.ts";

export interface WorkerKey {
  /** base64url of the 32-byte Ed25519 public key. */
  publicKey: string;
  revoked: boolean;
}

/** worker_use_nonce: 'revoked' when the key was revoked after it was looked up. */
export type NonceResult = "ok" | "replayed" | "revoked";

/** worker_claim. */
export interface ClaimedJob {
  jobId: string;
  attempt: number;
  captureId: string;
  kind: CaptureSide;
  declaredDocument: DeclaredDocument;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
}

/** worker_image_lookup. */
export type ImageLookup =
  | { result: "ok"; captureId: string; verificationId: string; storagePath: string; byteSize: number }
  | { result: "gone" }
  | { result: "not_found" };

/** What worker_record_result stores for one result. */
export interface ResultRecord {
  kid: string;
  jobId: string;
  attempt: number;
  /** Of the snapshot the case-level checks were decided from. */
  fingerprint: string;
  checks: CaptureCheck[];
  evidence: CaptureEvidence;
  caseChecks: CaseChecksPayload | null;
  /** Encrypted by the database. */
  mrzLines: string | null;
  mrzFormat: MrzFormat | null;
  fields: string | null;
}

export type RecordResult = "recorded" | "already_done" | "stale" | "gone" | "not_found";

export interface WorkerRepo {
  /** worker_key; null when unknown. */
  getKey(kid: string): Promise<WorkerKey | null>;
  useNonce(kid: string, nonce: string, expiresAt: string): Promise<NonceResult>;
  /** worker_claim: the next job, or null when there is none. */
  claim(): Promise<ClaimedJob | null>;
  lookupImage(jobId: string, attempt: number): Promise<ImageLookup>;
  /** worker_case_snapshot for a job; null when the job does not exist. */
  jobSnapshot(jobId: string): Promise<CaseSnapshot | null>;
  /** worker_record_result: everything in one transaction, the first result per job wins. */
  recordResult(record: ResultRecord): Promise<RecordResult>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface ImageStorage {
  /** The object's bytes, or null when it does not exist. */
  download(path: string): Promise<Blob | null>;
}

export interface WorkerDeps {
  repo: WorkerRepo;
  images: ImageStorage;
  now?: () => Date;
  log?: Logger;
}

/** A nonce is remembered this long after its timestamp stops being accepted (clock differences). */
export const NONCE_MARGIN_S = 60;

interface Signed {
  kid: string;
  body: Uint8Array<ArrayBuffer>;
}

export function createWorkerHandler(deps: WorkerDeps): Handler {
  const { repo, images } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? consoleLogger;

  /**
   * Cheapest checks first: header shape, then the time window, then the body (capped), then the key,
   * then the signature over the raw bytes. The nonce is recorded last, so that unsigned requests
   * cannot fill the table. Every failure is a 401 whose message names the step, never a value.
   */
  function signed(route: (signed: Signed) => Promise<Response>): Handler {
    return async (req) => {
      const headers = readSignatureHeaders(req.headers);
      if (!headers) throw new HttpError(401, "invalid_signature", "The signature headers are missing or malformed.");
      if (!withinWindow(headers.timestamp, now().getTime())) {
        throw new HttpError(401, "invalid_signature", "The timestamp is outside the accepted window.");
      }
      const body = await readBodyBytes(req, WORKER_LIMITS.maxBodyBytes);
      const key = await repo.getKey(headers.kid);
      const publicKey = key && !key.revoked ? base64UrlDecode(key.publicKey, ED25519_PUBLIC_KEY_BYTES) : null;
      if (!publicKey) throw new HttpError(401, "invalid_signature", "Unknown or revoked key.");
      const message = canonicalString({
        kid: headers.kid,
        method: req.method,
        path: routePath(new URL(req.url).pathname, "worker"),
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        bodySha256: await sha256Hex(body),
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

  function workerAudit(kid: string, action: string, target: { type: string; id: string }, details: Record<string, unknown>) {
    return repo.audit({ actorType: "system", actorId: kid, action, targetType: target.type, targetId: target.id, details });
  }

  const postClaim = signed(async ({ body }) => {
    const check = validateClaimBody(body.length === 0 ? null : parseJsonObject(body));
    if (!check.ok) throw badRequest(check.message);
    const job = await repo.claim();
    if (!job) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    const response: WorkerClaimResponse = {
      jobId: job.jobId,
      attempt: job.attempt,
      captureId: job.captureId,
      side: job.kind,
      declaredDocument: job.declaredDocument,
      mrzExpectation: MRZ_EXPECTATION[job.declaredDocument],
      image: { sha256: job.sha256, byteSize: job.byteSize, width: job.width, height: job.height },
    };
    return jsonResponse(200, response);
  });

  // The bytes are relayed from storage: no image URL ever leaves Supabase.
  const postImage = signed(async ({ kid, body }) => {
    const check = validateImageRequest(parseJsonObject(body));
    if (!check.ok) throw badRequest(check.message);
    const { jobId, attempt } = check.value;
    const found = await repo.lookupImage(jobId, attempt);
    if (found.result === "not_found") throw new HttpError(404, "not_found", "No such job attempt holds a lease.");
    if (found.result === "gone") throw new HttpError(410, "image_gone");
    const blob = await images.download(found.storagePath);
    if (!blob) throw new HttpError(410, "image_gone");
    // An ID photo leaves Supabase for an outside processor: never without a record of it.
    try {
      await workerAudit(kid, "worker.image", { type: "capture", id: found.captureId }, {
        jobId,
        attempt,
        verificationId: found.verificationId,
        byteSize: blob.size,
      });
    } catch (err) {
      log.error("worker.image_audit_failed", err);
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

    for (let round = 0; round < CASE_WRITE_ROUNDS; round++) {
      const snapshot = await repo.jobSnapshot(result.jobId);
      const job = snapshot?.job;
      if (!snapshot || !job || result.attempt > job.attempts) {
        throw new HttpError(404, "not_found", "No such job attempt.");
      }
      if (job.status === "done") return resultResponse("already_done");
      if (job.status === "superseded" || !job.captureLive) throw new HttpError(410, "image_gone");

      const today = now();
      const capture = decideCapture(result, job.kind, snapshot.declaredDocument, today);
      const sides = snapshot.sides.map((side) =>
        side.captureId === job.captureId ? { ...side, evidence: capture.evidence } : side
      );
      // M4: this photo's values come from the request (the database has not stored them yet); the
      // other photos' from the snapshot. Never the card sub-type: consistency does not use it.
      const { subtype: _subtype, ...printed } = result.fields;
      const read: SideDocumentData = {
        kind: job.kind,
        captureId: job.captureId,
        mrzLines: capture.mrzLines ? capture.mrzLines.split("\n") : null,
        fields: Object.keys(printed).length > 0 ? printed : null,
      };
      const documentData = [...snapshot.documentData.filter((d) => d.captureId !== job.captureId), read];
      const status = await repo.recordResult({
        kid,
        jobId: result.jobId,
        attempt: result.attempt,
        fingerprint: snapshot.fingerprint,
        checks: capture.checks,
        evidence: capture.evidence,
        caseChecks: decideCaseChecks({ declaredDocument: snapshot.declaredDocument, sides, documentData }, today),
        mrzLines: capture.mrzLines,
        mrzFormat: capture.mrzFormat,
        fields: capture.fields,
      });
      if (status === "recorded" || status === "already_done") return resultResponse(status);
      if (status === "gone") throw new HttpError(410, "image_gone");
      if (status === "not_found") throw new HttpError(404, "not_found", "No such job attempt.");
      // stale: the other side's result landed meanwhile; decide again with it.
    }
    log.error("worker.result_stale");
    throw new HttpError(500, "server_error");
  });

  return createRouter({
    name: "worker",
    // Never called from a browser: any request carrying an Origin header is refused.
    allowedOrigins: new Set(),
    log,
    maxBodyBytes: WORKER_LIMITS.maxBodyBytes,
    routes: {
      "/claim": { POST: postClaim },
      "/image": { POST: postImage },
      "/result": { POST: postResult },
    },
  });
}

function resultResponse(status: WorkerResultResponse["status"]): Response {
  const response: WorkerResultResponse = { status };
  return jsonResponse(200, response);
}

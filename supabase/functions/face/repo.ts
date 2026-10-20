// Supabase implementation of FaceRepo and FaceImageStorage (service role). Every database answer is
// checked field by field: anything unexpected is a bug, not data.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DECLARED_DOCUMENTS,
  FACE_JOB_KINDS,
  type FaceClaimInput,
  LIVENESS_ACTIONS,
  type LivenessAction,
} from "../_shared/contract.ts";
import { dbError, insertAudit } from "../_shared/db.ts";
import { isOneOf, isPlainObject, isUuid } from "../_shared/http.ts";
import { InternalError } from "../_shared/log.ts";
import { createImageStorage } from "../worker/repo.ts";
import type {
  ClaimedFaceJob,
  FaceImageLookup,
  FaceImageStorage,
  FaceJobContext,
  FaceNonceResult,
  FaceRecordResult,
  FaceRepo,
} from "./handler.ts";

const JOB_STATUSES = ["pending", "claimed", "done", "failed", "superseded"] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const intOrNull = (value: unknown): value is number | null => value === null || isInt(value);

function parseActions(value: unknown): LivenessAction[] | null {
  return Array.isArray(value) && value.every((a) => isOneOf(LIVENESS_ACTIONS, a)) ? (value as LivenessAction[]) : null;
}

/** One input of face_claim's answer. */
export function parseClaimInput(value: unknown): FaceClaimInput | null {
  if (!isPlainObject(value)) return null;
  const { captureId, role, index, step, atMs, sha256, byteSize, width, height } = value;
  if (!isUuid(captureId) || (role !== "frame" && role !== "document")) return null;
  if (!intOrNull(index) || !intOrNull(step) || !intOrNull(atMs)) return null;
  if ((role === "frame") !== (index !== null && step !== null && atMs !== null)) return null;
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256) || !isInt(byteSize) || !isInt(width) || !isInt(height)) return null;
  return { captureId, role, index, step, atMs, sha256, byteSize, width, height };
}

/** face_claim's JSON answer (null: no job). */
export function parseClaim(data: unknown): ClaimedFaceJob | null {
  if (data === null) return null;
  const fail = () => new InternalError("rpc.face_claim returned an unexpected value");
  if (!isPlainObject(data)) throw fail();
  const { jobId, attempt, kind, testSession, declaredDocument, actions, inputs } = data;
  const parsedActions = parseActions(actions);
  if (
    !isUuid(jobId) || !isInt(attempt) || !isOneOf(FACE_JOB_KINDS, kind) || typeof testSession !== "boolean" ||
    (declaredDocument !== null && !isOneOf(DECLARED_DOCUMENTS, declaredDocument)) || !parsedActions || !Array.isArray(inputs)
  ) {
    throw fail();
  }
  const parsedInputs = inputs.map((input: unknown) => {
    const parsed = parseClaimInput(input);
    if (!parsed) throw fail();
    return parsed;
  });
  return { jobId, attempt, kind, testSession, declaredDocument, actions: parsedActions, inputs: parsedInputs };
}

/** face_job_context's JSON answer (null: no such job). */
export function parseJobContext(data: unknown): FaceJobContext | null {
  if (data === null) return null;
  const fail = () => new InternalError("rpc.face_job_context returned an unexpected value");
  if (!isPlainObject(data)) throw fail();
  const { jobId, kind, verificationId, status, attempts, live, challengeId, actions, inputs } = data;
  const parsedActions = parseActions(actions);
  if (
    !isUuid(jobId) || !isOneOf(FACE_JOB_KINDS, kind) || !isUuid(verificationId) || !isOneOf(JOB_STATUSES, status) ||
    !isInt(attempts) || typeof live !== "boolean" || !isUuid(challengeId) || !parsedActions || !Array.isArray(inputs)
  ) {
    throw fail();
  }
  const parsedInputs = inputs.map((input: unknown) => {
    if (!isPlainObject(input) || !isUuid(input.captureId) || (input.role !== "frame" && input.role !== "document")) throw fail();
    if (!intOrNull(input.index) || !intOrNull(input.step)) throw fail();
    const role: "frame" | "document" = input.role;
    return { captureId: input.captureId, role, index: input.index, step: input.step };
  });
  return { jobId, kind, verificationId, status, attempts, live, challengeId, actions: parsedActions, inputs: parsedInputs };
}

export function createFaceRepo(db: SupabaseClient): FaceRepo {
  return {
    async getKey(kid) {
      // The face worker's keys only (scope "face"): the AI worker's keys are unknown here.
      const { data, error } = await db.from("worker_key").select("public_key, revoked_at").eq("kid", kid)
        .eq("scope", "face").maybeSingle<{ public_key: string; revoked_at: string | null }>();
      if (error) throw dbError("worker_key.select", error);
      return data ? { publicKey: data.public_key, revoked: data.revoked_at !== null } : null;
    },

    async useNonce(kid, nonce, expiresAt) {
      const { data, error } = await db.rpc("face_use_nonce", { p_kid: kid, p_nonce: nonce, p_expires_at: expiresAt });
      if (error) throw dbError("rpc.face_use_nonce", error);
      if (data !== "ok" && data !== "replayed" && data !== "revoked") {
        throw new InternalError("rpc.face_use_nonce returned an unexpected value");
      }
      return data satisfies FaceNonceResult;
    },

    async claim() {
      const { data, error } = await db.rpc("face_claim");
      if (error) throw dbError("rpc.face_claim", error);
      return parseClaim(data);
    },

    async lookupImage(jobId, attempt, captureId) {
      const { data, error } = await db.rpc("face_image_lookup", { p_job: jobId, p_attempt: attempt, p_capture: captureId });
      if (error) throw dbError("rpc.face_image_lookup", error);
      const row = ((data ?? []) as { result: string; verification_id: string | null; storage_path: string | null; byte_size: number | null }[])[0];
      if (row?.result === "gone" || row?.result === "not_found") return { result: row.result };
      if (row?.result !== "ok" || !row.verification_id || !row.storage_path || row.byte_size === null) {
        throw new InternalError("rpc.face_image_lookup returned an unexpected row");
      }
      const found: FaceImageLookup = {
        result: "ok",
        verificationId: row.verification_id,
        storagePath: row.storage_path,
        byteSize: row.byte_size,
      };
      return found;
    },

    async jobContext(jobId) {
      const { data, error } = await db.rpc("face_job_context", { p_job: jobId });
      if (error) throw dbError("rpc.face_job_context", error);
      return parseJobContext(data);
    },

    async recordResult(r) {
      const { data, error } = await db.rpc("face_record_result", {
        p_kid: r.kid,
        p_job: r.jobId,
        p_attempt: r.attempt,
        p_check: r.checkName,
        p_version: r.version,
        p_outcome: r.outcome,
        p_score: r.score,
        p_details: r.details,
        p_evidence: r.evidence,
      });
      if (error) throw dbError("rpc.face_record_result", error);
      if (data !== "recorded" && data !== "already_done" && data !== "gone" && data !== "not_found") {
        throw new InternalError("rpc.face_record_result returned an unexpected value");
      }
      return data satisfies FaceRecordResult;
    },

    audit: (entry) => insertAudit(db, entry),
  };
}

export function createFaceImageStorage(db: SupabaseClient): FaceImageStorage {
  return createImageStorage(db);
}

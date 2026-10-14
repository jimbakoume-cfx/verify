// Supabase implementation of WorkerRepo, CaseStore and ImageStorage (service role).
import type { SupabaseClient } from "@supabase/supabase-js";
import { CAPTURE_SIDES, DECLARED_DOCUMENTS } from "../_shared/contract.ts";
import { ID_CAPTURES_BUCKET } from "../_shared/config.ts";
import { dbError, insertAudit } from "../_shared/db.ts";
import { isOneOf, isPlainObject, isUuid } from "../_shared/http.ts";
import { InternalError } from "../_shared/log.ts";
import type { CaseSnapshot, CaseStore, JobStatus, SnapshotJob } from "./case.ts";
import { type CaseSide, parseEvidence } from "./decide.ts";
import type { ClaimedJob, ImageLookup, ImageStorage, NonceResult, RecordResult, WorkerRepo } from "./handler.ts";

const JOB_STATUSES: readonly JobStatus[] = ["pending", "claimed", "done", "failed", "superseded"];
const FINGERPRINT_RE = /^[0-9a-f]{32}$/;

/** worker_case_snapshot's JSON, checked field by field; anything unexpected is a bug, not data. */
export function parseSnapshot(data: unknown): CaseSnapshot | null {
  if (data === null) return null;
  const fail = () => new InternalError("rpc.worker_case_snapshot returned an unexpected value");
  if (!isPlainObject(data)) throw fail();
  const { verificationId, declaredDocument, fingerprint, sides, job } = data;
  if (!isUuid(verificationId) || typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) throw fail();
  if (declaredDocument !== null && !isOneOf(DECLARED_DOCUMENTS, declaredDocument)) throw fail();
  if (!Array.isArray(sides)) throw fail();
  const parsedSides: CaseSide[] = sides.map((side: unknown) => {
    if (!isPlainObject(side) || !isOneOf(CAPTURE_SIDES, side.kind) || !isUuid(side.captureId)) throw fail();
    const evidence = side.evidence === null ? null : parseEvidence(side.evidence);
    if (side.evidence !== null && evidence === null) throw fail();
    return { kind: side.kind, captureId: side.captureId, evidence };
  });
  let parsedJob: SnapshotJob | null = null;
  if (job !== null) {
    if (
      !isPlainObject(job) || !isUuid(job.id) || !isOneOf(JOB_STATUSES, job.status) ||
      typeof job.attempts !== "number" || !isUuid(job.captureId) || !isOneOf(CAPTURE_SIDES, job.kind) ||
      typeof job.captureLive !== "boolean"
    ) {
      throw fail();
    }
    parsedJob = {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      captureId: job.captureId,
      kind: job.kind,
      captureLive: job.captureLive,
    };
  }
  return { verificationId, declaredDocument, sides: parsedSides, fingerprint, job: parsedJob };
}

export function createWorkerRepo(db: SupabaseClient): WorkerRepo {
  return {
    async getKey(kid) {
      const { data, error } = await db.from("worker_key").select("public_key, revoked_at").eq("kid", kid)
        .maybeSingle<{ public_key: string; revoked_at: string | null }>();
      if (error) throw dbError("worker_key.select", error);
      return data ? { publicKey: data.public_key, revoked: data.revoked_at !== null } : null;
    },

    async useNonce(kid, nonce, expiresAt) {
      const { data, error } = await db.rpc("worker_use_nonce", { p_kid: kid, p_nonce: nonce, p_expires_at: expiresAt });
      if (error) throw dbError("rpc.worker_use_nonce", error);
      if (data !== "ok" && data !== "replayed" && data !== "revoked") {
        throw new InternalError("rpc.worker_use_nonce returned an unexpected value");
      }
      return data satisfies NonceResult;
    },

    async claim() {
      const { data, error } = await db.rpc("worker_claim");
      if (error) throw dbError("rpc.worker_claim", error);
      const rows = (data ?? []) as {
        job_id: string;
        attempt: number;
        capture_id: string;
        kind: unknown;
        declared_document: unknown;
        sha256: string;
        byte_size: number;
        width: number | null;
        height: number | null;
      }[];
      if (rows.length === 0) return null;
      const row = rows[0];
      if (
        !isOneOf(CAPTURE_SIDES, row.kind) || !isOneOf(DECLARED_DOCUMENTS, row.declared_document) ||
        row.width === null || row.height === null
      ) {
        throw new InternalError("rpc.worker_claim returned an unexpected row");
      }
      const job: ClaimedJob = {
        jobId: row.job_id,
        attempt: row.attempt,
        captureId: row.capture_id,
        kind: row.kind,
        declaredDocument: row.declared_document,
        sha256: row.sha256,
        byteSize: row.byte_size,
        width: row.width,
        height: row.height,
      };
      return job;
    },

    async lookupImage(jobId, attempt) {
      const { data, error } = await db.rpc("worker_image_lookup", { p_job: jobId, p_attempt: attempt });
      if (error) throw dbError("rpc.worker_image_lookup", error);
      const row = ((data ?? []) as {
        result: string;
        capture_id: string | null;
        verification_id: string | null;
        storage_path: string | null;
        byte_size: number | null;
      }[])[0];
      if (row?.result === "gone" || row?.result === "not_found") return { result: row.result };
      if (row?.result !== "ok" || !row.capture_id || !row.verification_id || !row.storage_path || row.byte_size === null) {
        throw new InternalError("rpc.worker_image_lookup returned an unexpected row");
      }
      const found: ImageLookup = {
        result: "ok",
        captureId: row.capture_id,
        verificationId: row.verification_id,
        storagePath: row.storage_path,
        byteSize: row.byte_size,
      };
      return found;
    },

    async jobSnapshot(jobId) {
      const { data, error } = await db.rpc("worker_case_snapshot", { p_job: jobId });
      if (error) throw dbError("rpc.worker_case_snapshot", error);
      return parseSnapshot(data);
    },

    async recordResult(r) {
      // The code lines and the fields travel only as RPC parameters: the project does not log
      // parameters, and the database encrypts them before storing (see the M2 and M3 migrations).
      const { data, error } = await db.rpc("worker_record_result", {
        p_kid: r.kid,
        p_job: r.jobId,
        p_attempt: r.attempt,
        p_fingerprint: r.fingerprint,
        p_capture_checks: r.checks,
        p_evidence: r.evidence,
        p_case: r.caseChecks,
        p_mrz_lines: r.mrzLines,
        p_mrz_format: r.mrzFormat,
        p_fields: r.fields,
      });
      if (error) throw dbError("rpc.worker_record_result", error);
      if (
        data !== "recorded" && data !== "already_done" && data !== "stale" && data !== "gone" && data !== "not_found"
      ) {
        throw new InternalError("rpc.worker_record_result returned an unexpected value");
      }
      return data satisfies RecordResult;
    },

    audit: (entry) => insertAudit(db, entry),
  };
}

export function createCaseStore(db: SupabaseClient): CaseStore {
  return {
    async snapshot(verificationId) {
      const { data, error } = await db.rpc("worker_case_snapshot", { p_verification: verificationId });
      if (error) throw dbError("rpc.worker_case_snapshot", error);
      return parseSnapshot(data);
    },

    async write(verificationId, fingerprint, checks) {
      const { data, error } = await db.rpc("worker_write_case", {
        p_verification: verificationId,
        p_fingerprint: fingerprint,
        p_case: checks,
      });
      if (error) throw dbError("rpc.worker_write_case", error);
      if (data !== "ok" && data !== "stale" && data !== "not_found") {
        throw new InternalError("rpc.worker_write_case returned an unexpected value");
      }
      return data;
    },
  };
}

export function createImageStorage(db: SupabaseClient): ImageStorage {
  return {
    async download(path) {
      const { data, error } = await db.storage.from(ID_CAPTURES_BUCKET).download(path);
      if (error) {
        if (isNotFound(error)) return null;
        throw dbError("storage.download", error);
      }
      return data;
    },
  };
}

// The Storage API has reported a missing object both as HTTP 404 and as HTTP 400 with statusCode "404"
// (the same rule as flow/repo.ts).
function isNotFound(error: { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown }): boolean {
  return error.status === 404 || error.statusCode === "404" || error.code === "NoSuchKey" ||
    error.code === "not_found" || (typeof error.message === "string" && /not found/i.test(error.message));
}

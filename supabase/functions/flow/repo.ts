// Supabase implementation of FlowRepo and CaptureStorage (service role).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CaptureSide, DeclaredDocument, FlowStatus } from "../_shared/contract.ts";
import { ID_CAPTURES_BUCKET } from "../_shared/config.ts";
import { dbError, insertAudit } from "../_shared/db.ts";
import { InternalError } from "../_shared/log.ts";
import type { CheckStateRow } from "./checks.ts";
import type {
  CaptureStorage,
  FlowRepo,
  FlowVerification,
  MrzRecordResult,
  StoredCapture,
  SubmitResult,
} from "./handler.ts";

const VERIFICATION_COLUMNS = "id, status, locale, declared_document, session_expires_at, is_test";

interface VerificationRow {
  id: string;
  status: FlowStatus;
  locale: "fr" | "en";
  declared_document: DeclaredDocument | null;
  session_expires_at: string | null;
  is_test: boolean;
}

function toVerification(row: VerificationRow): FlowVerification {
  return {
    id: row.id,
    status: row.status,
    locale: row.locale,
    declaredDocument: row.declared_document,
    expiresAt: row.session_expires_at,
    isTest: row.is_test,
  };
}

export function createFlowRepo(db: SupabaseClient): FlowRepo {
  async function verificationBy(column: "session_token_hash" | "id", value: string) {
    const { data, error } = await db.from("verification").select(VERIFICATION_COLUMNS).eq(column, value)
      .maybeSingle<VerificationRow>();
    if (error) throw dbError("verification.select", error);
    return data ? toVerification(data) : null;
  }

  return {
    findVerificationByTokenHash: (tokenHash) => verificationBy("session_token_hash", tokenHash),
    getVerification: (id) => verificationBy("id", id),

    async hasConsent(verificationId) {
      const { data, error } = await db.from("consent_record").select("id").eq("verification_id", verificationId)
        .limit(1);
      if (error) throw dbError("consent_record.select", error);
      return data.length > 0;
    },

    async insertConsent(c) {
      const { error } = await db.from("consent_record").insert({
        verification_id: c.verificationId,
        consent_version: c.consentVersion,
        language: c.language,
        user_agent: c.userAgent,
      });
      if (error) throw dbError("consent_record.insert", error);
    },

    async markInProgress(verificationId) {
      const { error } = await db.from("verification").update({ status: "in_progress" }).eq("id", verificationId)
        .eq("status", "created");
      if (error) throw dbError("verification.mark_in_progress", error);
    },

    async setDeclaredDocument(verificationId, document) {
      // The status filter closes the race with a concurrent submit.
      const { data, error } = await db.from("verification").update({ declared_document: document })
        .eq("id", verificationId).in("status", ["created", "in_progress"]).select("id");
      if (error) throw dbError("verification.declare_document", error);
      return (data ?? []).length > 0;
    },

    async listActiveCaptures(verificationId) {
      const { data, error } = await db.from("capture").select("kind, created_at")
        .eq("verification_id", verificationId).is("deleted_at", null);
      if (error) throw dbError("capture.list", error);
      return (data as { kind: string; created_at: string }[]).map((r) => ({ kind: r.kind, createdAt: r.created_at }));
    },

    async claimUploadSlot(verificationId, max) {
      const { data, error } = await db.rpc("flow_claim_upload_slot", { p_verification: verificationId, p_max: max });
      if (error) throw dbError("rpc.flow_claim_upload_slot", error);
      return data === true;
    },

    async findCaptureByPath(verificationId, path) {
      const { data, error } = await db.from("capture").select("id, byte_size, width, height, sha256, quality")
        .eq("verification_id", verificationId).eq("storage_path", path).is("deleted_at", null)
        .maybeSingle<{
          id: string;
          byte_size: number;
          width: number | null;
          height: number | null;
          sha256: string;
          quality: { server?: { reusedElsewhere?: unknown } } | null;
        }>();
      if (error) throw dbError("capture.select_by_path", error);
      if (!data) return null;
      const stored: StoredCapture = {
        id: data.id,
        byteSize: data.byte_size,
        width: data.width ?? 0,
        height: data.height ?? 0,
        sha256: data.sha256,
        reusedElsewhere: data.quality?.server?.reusedElsewhere === true,
      };
      return stored;
    },

    async isShaUsedElsewhere(sha256, verificationId) {
      // Deleted rows count too: the hash outlives the image, and reuse is still a signal.
      const { data, error } = await db.from("capture").select("id").eq("sha256", sha256)
        .neq("verification_id", verificationId).limit(1);
      if (error) throw dbError("capture.select_by_sha", error);
      return data.length > 0;
    },

    async insertCapture(c) {
      const { data, error } = await db.from("capture").insert({
        verification_id: c.verificationId,
        kind: c.kind,
        storage_path: c.storagePath,
        sha256: c.sha256,
        mime_type: "image/jpeg",
        byte_size: c.byteSize,
        width: c.width,
        height: c.height,
        quality: c.quality,
      }).select("id").single<{ id: string }>();
      if (error) throw dbError("capture.insert", error);
      return data.id;
    },

    async submit(verificationId, requiredSides: readonly CaptureSide[]) {
      const { data, error } = await db.rpc("flow_submit", {
        p_verification: verificationId,
        p_required: [...requiredSides],
      });
      if (error) throw dbError("rpc.flow_submit", error);
      if (data !== "ok" && data !== "already_submitted" && data !== "missing_sides") {
        throw new InternalError("rpc.flow_submit returned an unexpected value");
      }
      return data satisfies SubmitResult;
    },

    async findActiveCapture(verificationId, captureId) {
      const { data, error } = await db.from("capture").select("kind").eq("id", captureId)
        .eq("verification_id", verificationId).is("deleted_at", null).maybeSingle<{ kind: string }>();
      if (error) throw dbError("capture.select_active", error);
      return data ? { kind: data.kind } : null;
    },

    async recordMrz(r) {
      // The lines travel only as an RPC parameter: the project does not log parameters, and the
      // database encrypts them before storing (see the M2 migration).
      const { data, error } = await db.rpc("flow_record_mrz", {
        p_verification: r.verificationId,
        p_capture: r.captureId,
        p_lines: r.lines,
        p_format: r.format,
        p_outcome: r.outcome,
        p_details: r.details,
      });
      if (error) throw dbError("rpc.flow_record_mrz", error);
      if (data !== "ok" && data !== "exists" && data !== "not_found") {
        throw new InternalError("rpc.flow_record_mrz returned an unexpected value");
      }
      return data satisfies MrzRecordResult;
    },

    audit: (entry) => insertAudit(db, entry),

    async captureFollowUp(captureId) {
      const [replaced, job] = await Promise.all([
        db.from("capture").select("storage_path").eq("superseded_by", captureId),
        db.from("worker_job").select("status").eq("capture_id", captureId).maybeSingle<{ status: string }>(),
      ]);
      if (replaced.error) throw dbError("capture.select_superseded", replaced.error);
      if (job.error) throw dbError("worker_job.select", job.error);
      return {
        supersededPaths: (replaced.data as { storage_path: string }[]).map((row) => row.storage_path),
        jobPending: job.data?.status === "pending",
      };
    },

    async markRingFailed(captureId) {
      // Only while it waits: a worker that claimed it meanwhile was reached after all.
      const { error } = await db.from("worker_job").update({ ring_failed_at: new Date().toISOString() })
        .eq("capture_id", captureId).eq("status", "pending");
      if (error) throw dbError("worker_job.mark_ring_failed", error);
    },

    async checkState(verificationId) {
      const { data, error } = await db.rpc("flow_check_state", { p_verification: verificationId });
      if (error) throw dbError("rpc.flow_check_state", error);
      return ((data ?? []) as {
        capture_id: string;
        kind: string;
        live: boolean;
        created_at: string;
        job_status: string | null;
        job_error: string | null;
        ring_failed: boolean;
        quality_verdict: string | null;
        phone_mrz_pass: boolean | null;
      }[]).map((row): CheckStateRow => ({
        captureId: row.capture_id,
        kind: row.kind,
        live: row.live,
        createdAt: row.created_at,
        jobStatus: row.job_status,
        jobError: row.job_error,
        ringFailed: row.ring_failed,
        qualityVerdict: row.quality_verdict,
        phoneMrzPass: row.phone_mrz_pass,
      }));
    },

    async workerEnabledForRealSessions() {
      const { data, error } = await db.from("worker_settings").select("enabled_for_real_sessions").limit(1)
        .maybeSingle<{ enabled_for_real_sessions: boolean }>();
      if (error) throw dbError("worker_settings.select", error);
      // No settings row: the worker claims nothing either (fail closed).
      return data?.enabled_for_real_sessions === true;
    },
  };
}

export function createCaptureStorage(db: SupabaseClient): CaptureStorage {
  const bucket = () => db.storage.from(ID_CAPTURES_BUCKET);
  return {
    async createSignedUploadUrl(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path);
      if (error) throw dbError("storage.create_signed_upload_url", error);
      return { path: data.path, token: data.token };
    },

    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error) {
        if (isNotFound(error)) return null;
        throw dbError("storage.download", error);
      }
      return new Uint8Array(await data.arrayBuffer());
    },

    async remove(path) {
      const { error } = await bucket().remove([path]);
      if (error) throw dbError("storage.remove", error);
    },
  };
}

// The Storage API has reported a missing object both as HTTP 404 and as HTTP 400 with statusCode "404".
function isNotFound(error: { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown }): boolean {
  return error.status === 404 || error.statusCode === "404" || error.code === "NoSuchKey" ||
    error.code === "not_found" || (typeof error.message === "string" && /not found/i.test(error.message));
}

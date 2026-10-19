// Supabase implementation of FlowRepo and CaptureStorage (service role).
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type DeclaredDocument,
  type FlowStatus,
  type LivenessAction,
  SERVER_CHECK_NAMES,
} from "../_shared/contract.ts";
import { ID_CAPTURES_BUCKET } from "../_shared/config.ts";
import { dbError, insertAudit } from "../_shared/db.ts";
import { InternalError } from "../_shared/log.ts";
import type { CheckStateRow } from "./checks.ts";
import type {
  CaptureStorage,
  ChallengeIssue,
  FlowRepo,
  FlowVerification,
  LivenessRecordResult,
  MrzRecordResult,
  RequiredKind,
  StoredCapture,
  StoredChallenge,
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
        keep_face_images: c.keepFaceImages,
        keep_face_images_version: c.keepFaceImagesVersion,
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

    async submit(verificationId, requiredKinds: readonly RequiredKind[]) {
      const { data, error } = await db.rpc("flow_submit", {
        p_verification: verificationId,
        p_required: [...requiredKinds],
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

    async consistencyFlags(verificationId) {
      // Generic codes only (check_result.details of the case-level consistency check, M4).
      const { data, error } = await db.from("check_result").select("details")
        .eq("verification_id", verificationId).is("capture_id", null).eq("check_name", SERVER_CHECK_NAMES.consistency)
        .maybeSingle<{ details: { flags?: unknown } | null }>();
      if (error) throw dbError("check_result.consistency", error);
      const flags = data?.details?.flags;
      return Array.isArray(flags) ? flags.filter((flag): flag is string => typeof flag === "string") : [];
    },

    async issueLivenessChallenge(issue) {
      const { data, error } = await db.rpc("flow_issue_liveness_challenge", {
        p_verification: issue.verificationId,
        p_actions: issue.actions,
        p_code: issue.code,
        p_ttl_seconds: issue.ttlSeconds,
        p_max: issue.max,
      });
      if (error) throw dbError("rpc.flow_issue_liveness_challenge", error);
      const row = ((data ?? []) as { result: string; challenge_id: string | null; expires_at: string | null }[])[0];
      if (row?.result === "ok" && row.challenge_id && row.expires_at) {
        return { result: "ok", challengeId: row.challenge_id, expiresAt: row.expires_at } satisfies ChallengeIssue;
      }
      if (row?.result === "too_many" || row?.result === "closed") return { result: row.result } satisfies ChallengeIssue;
      throw new InternalError("rpc.flow_issue_liveness_challenge returned an unexpected value");
    },

    async getLivenessChallenge(verificationId, challengeId) {
      const { data, error } = await db.from("liveness_challenge")
        .select("id, actions, code, created_at, expires_at, superseded_at, used_at")
        .eq("id", challengeId).eq("verification_id", verificationId)
        .maybeSingle<{
          id: string;
          actions: LivenessAction[];
          code: string;
          created_at: string;
          expires_at: string;
          superseded_at: string | null;
          used_at: string | null;
        }>();
      if (error) throw dbError("liveness_challenge.select", error);
      if (!data) return null;
      const challenge: StoredChallenge = {
        id: data.id,
        actions: data.actions,
        code: data.code,
        createdAt: data.created_at,
        expiresAt: data.expires_at,
        supersededAt: data.superseded_at,
        usedAt: data.used_at,
      };
      return challenge;
    },

    async livenessFramePaths(challengeId) {
      const { data, error } = await db.from("capture").select("storage_path")
        .eq("liveness_challenge_id", challengeId).is("deleted_at", null);
      if (error) throw dbError("capture.select_frames", error);
      return (data as { storage_path: string }[]).map((row) => row.storage_path);
    },

    async shasUsedElsewhere(sha256s, verificationId) {
      // Deleted rows count too, as for the photos (isShaUsedElsewhere).
      const { data, error } = await db.from("capture").select("id").in("sha256", [...sha256s])
        .neq("verification_id", verificationId).limit(1);
      if (error) throw dbError("capture.select_frames_by_sha", error);
      return data.length > 0;
    },

    async recordLiveness(r) {
      // The code travels only as an RPC parameter (the project does not log parameters); the
      // database compares it with the challenge's and never writes it to the audit log.
      const { data, error } = await db.rpc("flow_record_liveness", {
        p_verification: r.verificationId,
        p_challenge: r.challengeId,
        p_code: r.code,
        p_frames: r.frames,
        p_version: r.version,
        p_outcome: r.outcome,
        p_details: r.details,
      });
      if (error) throw dbError("rpc.flow_record_liveness", error);
      const row = ((data ?? []) as { result: string; superseded_paths: string[] | null }[])[0];
      switch (row?.result) {
        case "ok":
          return { result: "ok", supersededPaths: row.superseded_paths ?? [] } satisfies LivenessRecordResult;
        case "not_found":
        case "used":
        case "expired":
        case "code_mismatch":
        case "closed":
          return { result: row.result } satisfies LivenessRecordResult;
        default:
          throw new InternalError("rpc.flow_record_liveness returned an unexpected value");
      }
    },

    async hasLiveness(verificationId) {
      const { data, error } = await db.from("capture").select("id").eq("verification_id", verificationId)
        .eq("kind", "liveness_frame").is("deleted_at", null).limit(1);
      if (error) throw dbError("capture.select_liveness", error);
      return data.length > 0;
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

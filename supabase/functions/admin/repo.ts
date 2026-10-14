// Supabase implementation of AdminRepo, StaffAuth and SignedUrlStorage (service role).
import { isAuthApiError, isAuthWeakPasswordError, type SupabaseClient } from "@supabase/supabase-js";
import { ID_CAPTURES_BUCKET } from "../_shared/config.ts";
import { MRZ_FORMATS } from "../_shared/contract.ts";
import { dbError, insertAudit } from "../_shared/db.ts";
import { isOneOf } from "../_shared/http.ts";
import { InternalError } from "../_shared/log.ts";
import type {
  AdminRepo,
  CaptureRecord,
  DocumentDataRow,
  InviteResult,
  PasswordResult,
  SignedUrlStorage,
  StaffAuth,
  StaffRole,
} from "./handler.ts";

function toInviteResult(data: unknown): InviteResult {
  return data === "ok" ? "ok" : "invalid";
}

export function createAdminRepo(db: SupabaseClient): AdminRepo {
  return {
    async inviteVerify(email, codeHash) {
      const { data, error } = await db.rpc("staff_invite_verify", { p_email: email, p_code_hash: codeHash });
      if (error) throw dbError("rpc.staff_invite_verify", error);
      return toInviteResult(data);
    },

    async findAuthUser(email) {
      const { data, error } = await db.rpc("staff_find_auth_user", { p_email: email });
      if (error) throw dbError("rpc.staff_find_auth_user", error);
      const rows = (data ?? []) as { user_id: string; email_confirmed: boolean }[];
      return rows.length > 0 ? { userId: rows[0].user_id, emailConfirmed: rows[0].email_confirmed } : null;
    },

    async inviteAccept(email, codeHash, userId) {
      const { data, error } = await db.rpc("staff_invite_accept", {
        p_email: email,
        p_code_hash: codeHash,
        p_user_id: userId,
      });
      if (error) throw dbError("rpc.staff_invite_accept", error);
      return toInviteResult(data);
    },

    async getStaffProfile(userId) {
      const { data, error } = await db.from("staff_profile").select("role, active").eq("user_id", userId)
        .maybeSingle<{ role: StaffRole; active: boolean }>();
      if (error) throw dbError("staff_profile.select", error);
      return data;
    },

    async ensureApiClient(name, apiKeyHash) {
      const find = async () => {
        const { data, error } = await db.from("api_client").select("id").eq("name", name).maybeSingle<{ id: string }>();
        if (error) throw dbError("api_client.select", error);
        return data?.id ?? null;
      };
      const existing = await find();
      if (existing) return existing;
      // ignoreDuplicates: a concurrent request may create it first; either way it exists afterwards.
      const { error } = await db.from("api_client").upsert({ name, api_key_hash: apiKeyHash }, {
        onConflict: "name",
        ignoreDuplicates: true,
      });
      if (error) throw dbError("api_client.insert", error);
      const created = await find();
      if (!created) throw new InternalError("api_client missing after insert");
      return created;
    },

    async createApplicant(a) {
      const { data, error } = await db.from("applicant").insert({
        api_client_id: a.apiClientId,
        external_user_id: a.externalUserId,
        subject_type: "rider",
      }).select("id").single<{ id: string }>();
      if (error) throw dbError("applicant.insert", error);
      return data.id;
    },

    async createVerification(v) {
      const { data, error } = await db.from("verification").insert({
        applicant_id: v.applicantId,
        attempt_no: 1,
        locale: v.locale,
        session_token_hash: v.tokenHash,
        session_expires_at: v.expiresAt,
        is_test: true,
      }).select("id").single<{ id: string }>();
      if (error) throw dbError("verification.insert", error);
      return data.id;
    },

    async getCapture(captureId) {
      const { data, error } = await db.from("capture").select("id, verification_id, storage_path, deleted_at")
        .eq("id", captureId).maybeSingle<
          { id: string; verification_id: string; storage_path: string; deleted_at: string | null }
        >();
      if (error) throw dbError("capture.select", error);
      if (!data) return null;
      const record: CaptureRecord = {
        id: data.id,
        verificationId: data.verification_id,
        storagePath: data.storage_path,
        deletedAt: data.deleted_at,
      };
      return record;
    },

    async isAssignedReviewer(verificationId, userId) {
      const { data, error } = await db.from("review_task").select("id").eq("verification_id", verificationId)
        .eq("assigned_to", userId).eq("status", "assigned").limit(1);
      if (error) throw dbError("review_task.select", error);
      return data.length > 0;
    },

    async verificationExists(verificationId) {
      const { data, error } = await db.from("verification").select("id").eq("id", verificationId).limit(1);
      if (error) throw dbError("verification.select", error);
      return data.length > 0;
    },

    async readDocumentData(verificationId, actorId, role) {
      // A POST call (supabase-js default), so PostgREST runs it read-write: the audit insert needs that.
      const { data, error } = await db.rpc("staff_read_document_data", {
        p_verification: verificationId,
        p_actor: actorId,
        p_role: role,
      });
      if (error) throw dbError("rpc.staff_read_document_data", error);
      const rows = (data ?? []) as { capture_id: string; source: unknown; format: unknown; lines: string; recorded_at: string }[];
      return rows.map((row) => {
        if (row.source !== "mrz_phone" || !isOneOf(MRZ_FORMATS, row.format) || typeof row.lines !== "string") {
          throw new InternalError("rpc.staff_read_document_data returned an unexpected row");
        }
        const item: DocumentDataRow = {
          captureId: row.capture_id,
          source: row.source,
          format: row.format,
          lines: row.lines,
          recordedAt: row.recorded_at,
        };
        return item;
      });
    },

    audit: (entry) => insertAudit(db, entry),
  };
}

export function createStaffAuth(db: SupabaseClient): StaffAuth {
  function passwordResult(context: string, userId: string | undefined, error: unknown): PasswordResult {
    // Supabase Auth's own policy (length, required characters, leaked-password check) refused it.
    if (isAuthWeakPasswordError(error) || (isAuthApiError(error) && error.code === "weak_password")) {
      return { ok: false, reason: "weak_password" };
    }
    if (error) throw dbError(context, error as { code?: unknown; status?: unknown });
    if (!userId) throw new InternalError(`${context} returned no user`);
    return { ok: true, userId };
  }

  return {
    async getUserId(accessToken) {
      const { data, error } = await db.auth.getUser(accessToken);
      if (error) {
        // Invalid, expired or revoked tokens and deleted users are client errors: "unauthorized".
        if (isAuthApiError(error) && [400, 401, 403, 404].includes(error.status)) return null;
        throw dbError("auth.get_user", error);
      }
      return data.user?.id ?? null;
    },

    async createUser(email, password) {
      const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
      return passwordResult("auth.admin.create_user", data.user?.id, error);
    },

    async setPassword(userId, password) {
      const { data, error } = await db.auth.admin.updateUserById(userId, { password, email_confirm: true });
      return passwordResult("auth.admin.update_user", data.user?.id, error);
    },
  };
}

export function createSignedUrlStorage(db: SupabaseClient): SignedUrlStorage {
  return {
    async createSignedUrl(path, expiresIn) {
      const { data, error } = await db.storage.from(ID_CAPTURES_BUCKET).createSignedUrl(path, expiresIn);
      if (error) throw dbError("storage.create_signed_url", error);
      return data.signedUrl;
    },
  };
}

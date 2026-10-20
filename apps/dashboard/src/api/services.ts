// Everything the signed-in screens need from the backend, behind one interface so the dev-only
// screen preview can swap in fake data.
import { createContext, useContext } from "react";
import {
  type CaptureViewResponse,
  type DecisionRequest,
  type DecisionResponse,
  type DocumentDataResponse,
  type getSupabase,
  LIVENESS_CHECK_NAME,
  MRZ_CHECK_NAME,
  type TestSessionRequest,
  type TestSessionResponse,
  type ThresholdVersionRequest,
  type ThresholdVersionResponse,
} from "@verify/shared";
import { ClientError } from "../lib/errors";
import { FACE_CHECK_NAMES, FACE_JOB_COLUMNS, type FaceChecks, toFaceChecks } from "../lib/faceChecks";
import { type LivenessCheckRecord, toLivenessCheck } from "../lib/liveness";
import {
  CAPTURE_COLUMNS,
  type CaptureRecord,
  CHECK_COLUMNS,
  countCaptures,
  JOB_COLUMNS,
  type MrzCheckRecord,
  SERVER_CHECK_NAME_LIST,
  type ServerChecks,
  STAFF_PROFILE_COLUMNS,
  type StaffProfile,
  toCapture,
  toMrzCheck,
  toServerChecks,
  toStaffProfile,
  toVerification,
  VERIFICATION_COLUMNS,
  type VerificationListItem,
  type VerificationSummary,
} from "../lib/records";
import {
  DECISION_COLUMNS,
  type DecisionRecord,
  REASON_CODE_COLUMNS,
  type ReasonCodeRecord,
  THRESHOLD_COLUMNS,
  type ThresholdVersionRecord,
  toDecision,
  toReasonCode,
  toThresholdVersion,
} from "../lib/risk";
import * as admin from "./admin";

export type Supabase = NonNullable<ReturnType<typeof getSupabase>>;

export interface DashboardServices {
  /** The 20 most recent verifications this staff member may see (RLS filters them). */
  recentVerifications(): Promise<VerificationListItem[]>;
  /** Null when the case does not exist or RLS hides it. */
  verification(id: string): Promise<VerificationSummary | null>;
  captures(verificationId: string): Promise<CaptureRecord[]>;
  /** Results of the MRZ check, latest first. Outcomes and counts only: no data read from the document. */
  mrzChecks(verificationId: string): Promise<MrzCheckRecord[]>;
  /** The server's checks (M3). Outcomes, generic codes and metrics only: no data read from the document. */
  serverChecks(verificationId: string): Promise<ServerChecks>;
  /** M5: the face check's liveness_capture check; null when the case has none. Codes, counts and timings only. */
  livenessCheck(verificationId: string): Promise<LivenessCheckRecord | null>;
  /** M6/M7: the face worker's liveness and face_match checks and each face job's status. Codes and scores only. */
  faceChecks(verificationId: string): Promise<FaceChecks>;
  createTestSession(request: TestSessionRequest): Promise<TestSessionResponse>;
  viewCapture(captureId: string): Promise<CaptureViewResponse>;
  /**
   * The decrypted data read from a case's documents: code lines from the phone and the server, printed
   * fields from the server (POST /admin/document-data, audited before decryption).
   */
  documentData(verificationId: string): Promise<DocumentDataResponse>;
  /** M8: the decisions of a case, latest first. */
  decisions(verificationId: string): Promise<DecisionRecord[]>;
  /** M8: the rider reasons a reject can give (active ones). */
  reasonCodes(): Promise<ReasonCodeRecord[]>;
  decide(request: DecisionRequest): Promise<DecisionResponse>;
  /** M8: every threshold version, newest first. */
  thresholdVersions(): Promise<ThresholdVersionRecord[]>;
  /** M8: staff names by user id (admins read every profile; others only their own). */
  staffNames(): Promise<Map<string, string>>;
  createThresholdVersion(request: ThresholdVersionRequest): Promise<ThresholdVersionResponse>;
}

export const RECENT_LIMIT = 20;

function dbError(error: { message?: string; code?: string }): ClientError {
  // postgrest-js reports a failed fetch as an error without a SQL state code.
  return new ClientError(!error.code && /fetch/i.test(error.message ?? "") ? "network" : "server_error");
}

export async function fetchOwnProfile(supabase: Supabase, userId: string): Promise<StaffProfile | null> {
  const { data, error } = await supabase
    .from("staff_profile")
    .select(STAFF_PROFILE_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw dbError(error);
  return toStaffProfile(data);
}

export function createSupabaseServices(supabase: Supabase): DashboardServices {
  async function accessToken(): Promise<string> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new ClientError("unauthorized");
    return token;
  }

  return {
    async recentVerifications() {
      const { data, error } = await supabase
        .from("verification")
        .select(VERIFICATION_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(RECENT_LIMIT);
      if (error) throw dbError(error);
      const rows = (data ?? []).map(toVerification).filter((v): v is VerificationSummary => v !== null);
      if (rows.length === 0) return [];

      const { data: captureRows, error: captureError } = await supabase
        .from("capture")
        .select("verification_id, deleted_at")
        .in(
          "verification_id",
          rows.map((v) => v.id),
        );
      if (captureError) throw dbError(captureError);
      const counts = countCaptures(captureRows ?? []);
      return rows.map((v) => ({ ...v, captureCount: counts.get(v.id) ?? 0 }));
    },

    async verification(id) {
      const { data, error } = await supabase.from("verification").select(VERIFICATION_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw dbError(error);
      return toVerification(data);
    },

    async captures(verificationId) {
      const { data, error } = await supabase
        .from("capture")
        .select(CAPTURE_COLUMNS)
        .eq("verification_id", verificationId)
        .order("created_at", { ascending: false });
      if (error) throw dbError(error);
      return (data ?? []).map(toCapture).filter((c): c is CaptureRecord => c !== null);
    },

    async mrzChecks(verificationId) {
      const { data, error } = await supabase
        .from("check_result")
        .select(CHECK_COLUMNS)
        .eq("verification_id", verificationId)
        .eq("check_name", MRZ_CHECK_NAME)
        .order("created_at", { ascending: false });
      if (error) throw dbError(error);
      return (data ?? []).map(toMrzCheck).filter((c): c is MrzCheckRecord => c !== null);
    },

    // Queries of their own, like the MRZ checks: a failure leaves the rest of the case readable.
    async serverChecks(verificationId) {
      const [checks, jobs] = await Promise.all([
        supabase
          .from("check_result")
          .select(CHECK_COLUMNS)
          .eq("verification_id", verificationId)
          .in("check_name", [...SERVER_CHECK_NAME_LIST])
          .order("created_at", { ascending: false }),
        // Each photo's job status only: the other columns (evidence, error codes) are not granted.
        supabase.from("worker_job").select(JOB_COLUMNS).eq("verification_id", verificationId),
      ]);
      if (checks.error) throw dbError(checks.error);
      if (jobs.error) throw dbError(jobs.error);
      return toServerChecks(checks.data ?? [], jobs.data ?? []);
    },

    async livenessCheck(verificationId) {
      const { data, error } = await supabase
        .from("check_result")
        .select(CHECK_COLUMNS)
        .eq("verification_id", verificationId)
        .eq("check_name", LIVENESS_CHECK_NAME)
        .is("capture_id", null)
        .maybeSingle();
      if (error) throw dbError(error);
      return data ? toLivenessCheck(data) : null;
    },

    async faceChecks(verificationId) {
      const [checks, jobs] = await Promise.all([
        supabase
          .from("check_result")
          .select(CHECK_COLUMNS)
          .eq("verification_id", verificationId)
          .in("check_name", [...FACE_CHECK_NAMES])
          .is("capture_id", null),
        // Each face job's kind and status only (the other columns are not granted).
        supabase.from("face_job").select(FACE_JOB_COLUMNS).eq("verification_id", verificationId),
      ]);
      if (checks.error) throw dbError(checks.error);
      if (jobs.error) throw dbError(jobs.error);
      return toFaceChecks(checks.data ?? [], jobs.data ?? []);
    },

    async createTestSession(request) {
      return admin.createTestSession(await accessToken(), request);
    },

    async viewCapture(captureId) {
      return admin.viewCapture(await accessToken(), { captureId });
    },

    async documentData(verificationId) {
      return admin.documentData(await accessToken(), { verificationId });
    },

    async decisions(verificationId) {
      const { data, error } = await supabase
        .from("decision")
        .select(DECISION_COLUMNS)
        .eq("verification_id", verificationId)
        .order("created_at", { ascending: false });
      if (error) throw dbError(error);
      return (data ?? []).map(toDecision).filter((d): d is DecisionRecord => d !== null);
    },

    async reasonCodes() {
      const { data, error } = await supabase.from("reason_code").select(REASON_CODE_COLUMNS).eq("active", true).order("code");
      if (error) throw dbError(error);
      return (data ?? []).map(toReasonCode).filter((r): r is ReasonCodeRecord => r !== null);
    },

    async decide(request) {
      return admin.decide(await accessToken(), request);
    },

    async thresholdVersions() {
      const { data, error } = await supabase.from("threshold_config").select(THRESHOLD_COLUMNS).order("version", { ascending: false });
      if (error) throw dbError(error);
      return (data ?? []).map(toThresholdVersion).filter((v): v is ThresholdVersionRecord => v !== null);
    },

    async staffNames() {
      const { data, error } = await supabase.from("staff_profile").select("user_id, full_name");
      if (error) throw dbError(error);
      const names = new Map<string, string>();
      for (const row of (data ?? []) as { user_id?: unknown; full_name?: unknown }[]) {
        if (typeof row.user_id === "string" && typeof row.full_name === "string") names.set(row.user_id, row.full_name);
      }
      return names;
    },

    async createThresholdVersion(request) {
      return admin.createThresholdVersion(await accessToken(), request);
    },
  };
}

export const ServicesContext = createContext<DashboardServices | null>(null);

export function useServices(): DashboardServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("ServicesContext is missing");
  return services;
}

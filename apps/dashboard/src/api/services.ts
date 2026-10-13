// Everything the signed-in screens need from the backend, behind one interface so the dev-only
// screen preview can swap in fake data.
import { createContext, useContext } from "react";
import type { CaptureViewResponse, TestSessionRequest, TestSessionResponse, getSupabase } from "@verify/shared";
import { ClientError } from "../lib/errors";
import {
  CAPTURE_COLUMNS,
  type CaptureRecord,
  countCaptures,
  STAFF_PROFILE_COLUMNS,
  type StaffProfile,
  toCapture,
  toStaffProfile,
  toVerification,
  VERIFICATION_COLUMNS,
  type VerificationListItem,
  type VerificationSummary,
} from "../lib/records";
import * as admin from "./admin";

export type Supabase = NonNullable<ReturnType<typeof getSupabase>>;

export interface DashboardServices {
  /** The 20 most recent verifications this staff member may see (RLS filters them). */
  recentVerifications(): Promise<VerificationListItem[]>;
  /** Null when the case does not exist or RLS hides it. */
  verification(id: string): Promise<VerificationSummary | null>;
  captures(verificationId: string): Promise<CaptureRecord[]>;
  createTestSession(request: TestSessionRequest): Promise<TestSessionResponse>;
  viewCapture(captureId: string): Promise<CaptureViewResponse>;
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

    async createTestSession(request) {
      return admin.createTestSession(await accessToken(), request);
    },

    async viewCapture(captureId) {
      return admin.viewCapture(await accessToken(), { captureId });
    },
  };
}

export const ServicesContext = createContext<DashboardServices | null>(null);

export function useServices(): DashboardServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("ServicesContext is missing");
  return services;
}

// Rows read directly from Supabase (RLS decides which ones come back), checked and reshaped for the UI.
// Rows are typed `unknown` because there are no generated database types; nothing is trusted blindly.
import { DECLARED_DOCUMENTS, type DeclaredDocument, type FlowStatus } from "@verify/shared";
import { isStaffRole, type StaffRole } from "./roles";

export interface StaffProfile {
  userId: string;
  role: StaffRole;
  fullName: string;
  active: boolean;
}

export interface VerificationSummary {
  id: string;
  status: FlowStatus;
  declaredDocument: DeclaredDocument | null;
  isTest: boolean;
  createdAt: string;
  submittedAt: string | null;
  sessionExpiresAt: string | null;
}

export interface VerificationListItem extends VerificationSummary {
  /** Captures still holding an image (not erased). */
  captureCount: number;
}

/** Metrics the rider app measured, plus what the server added after checking the upload. */
export interface CaptureQuality {
  source: "auto" | "manual" | null;
  sharpness: number | null;
  glareRatio: number | null;
  meanLuma: number | null;
  framing: number | null;
  videoWidth: number | null;
  videoHeight: number | null;
  elapsedMs: number | null;
  reusedElsewhere: boolean | null;
}

export interface CaptureRecord {
  id: string;
  /** capture_kind enum: document_front, document_back, selfie, liveness_frame. */
  kind: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  sha256: string;
  deleted: boolean;
  quality: CaptureQuality;
}

// Record<FlowStatus, …> makes the compiler flag any status added to the contract but not here.
const STATUS_SET: Record<FlowStatus, true> = {
  created: true,
  in_progress: true,
  submitted: true,
  processing: true,
  in_review: true,
  approved: true,
  rejected: true,
  expired: true,
  cancelled: true,
};
export const VERIFICATION_STATUSES = Object.keys(STATUS_SET) as FlowStatus[];

/** Kinds that exist in the database enum; M1 only produces the two document sides. */
export const CAPTURE_KINDS = ["document_front", "document_back", "selfie", "liveness_frame"] as const;

/** Columns each query asks for, kept next to the code that reads them. */
export const STAFF_PROFILE_COLUMNS = "user_id, role, full_name, active";
export const VERIFICATION_COLUMNS = "id, status, declared_document, is_test, created_at, submitted_at, session_expires_at";
export const CAPTURE_COLUMNS = "id, verification_id, kind, byte_size, width, height, quality, created_at, sha256, deleted_at";

type Row = Record<string, unknown>;

const asRow = (value: unknown): Row | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function isFlowStatus(value: unknown): value is FlowStatus {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STATUS_SET, value);
}

export function isDeclaredDocument(value: unknown): value is DeclaredDocument {
  return typeof value === "string" && (DECLARED_DOCUMENTS as readonly string[]).includes(value);
}

export function toStaffProfile(value: unknown): StaffProfile | null {
  const row = asRow(value);
  const userId = str(row?.user_id);
  if (!row || !userId || !isStaffRole(row.role)) return null;
  return { userId, role: row.role, fullName: str(row.full_name) ?? "", active: row.active === true };
}

export function toVerification(value: unknown): VerificationSummary | null {
  const row = asRow(value);
  const id = str(row?.id);
  const createdAt = str(row?.created_at);
  if (!row || !id || !createdAt || !isFlowStatus(row.status)) return null;
  return {
    id,
    status: row.status,
    declaredDocument: isDeclaredDocument(row.declared_document) ? row.declared_document : null,
    isTest: row.is_test === true,
    createdAt,
    submittedAt: str(row.submitted_at),
    sessionExpiresAt: str(row.session_expires_at),
  };
}

export function toCaptureQuality(value: unknown): CaptureQuality {
  const q = asRow(value) ?? {};
  const server = asRow(q.server);
  const reused = server?.reusedElsewhere;
  return {
    source: q.source === "auto" || q.source === "manual" ? q.source : null,
    sharpness: num(q.sharpness),
    glareRatio: num(q.glareRatio),
    meanLuma: num(q.meanLuma),
    framing: num(q.framing),
    videoWidth: num(q.videoWidth),
    videoHeight: num(q.videoHeight),
    elapsedMs: num(q.elapsedMs),
    reusedElsewhere: typeof reused === "boolean" ? reused : null,
  };
}

export function toCapture(value: unknown): CaptureRecord | null {
  const row = asRow(value);
  const id = str(row?.id);
  const kind = str(row?.kind);
  const createdAt = str(row?.created_at);
  const byteSize = num(row?.byte_size);
  if (!row || !id || !kind || !createdAt || byteSize === null) return null;
  return {
    id,
    kind,
    byteSize,
    width: num(row.width),
    height: num(row.height),
    createdAt,
    sha256: str(row.sha256) ?? "",
    deleted: row.deleted_at !== null && row.deleted_at !== undefined,
    quality: toCaptureQuality(row.quality),
  };
}

/** Live (not erased) captures per verification id, from rows holding verification_id + deleted_at. */
export function countCaptures(rows: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of rows) {
    const row = asRow(value);
    const id = str(row?.verification_id);
    if (!row || !id || (row.deleted_at !== null && row.deleted_at !== undefined)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Front before back, then the newest first within a kind. */
export function sortCaptures(captures: readonly CaptureRecord[]): CaptureRecord[] {
  const rank = (kind: string) => {
    const i = (CAPTURE_KINDS as readonly string[]).indexOf(kind);
    return i < 0 ? CAPTURE_KINDS.length : i;
  };
  return [...captures].sort((a, b) => rank(a.kind) - rank(b.kind) || b.createdAt.localeCompare(a.createdAt));
}

/** A rider link is still usable only before submission and before its expiry. */
export function sessionOpen(v: VerificationSummary, nowMs: number): boolean {
  if (v.status !== "created" && v.status !== "in_progress") return false;
  const expires = v.sessionExpiresAt ? Date.parse(v.sessionExpiresAt) : Number.NaN;
  return Number.isFinite(expires) && expires > nowMs;
}

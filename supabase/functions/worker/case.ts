// The case-level server checks (classification and document_policy) are decided from a snapshot of
// the case and written only if the case has not changed since: the database compares the snapshot's
// fingerprint under the case lock and answers 'stale' otherwise (see the M3 migration). Used by the
// worker function after a result and by the flow function after a photo was replaced.
import type { CaptureSide, DeclaredDocument, PolicyReason } from "../_shared/contract.ts";
import { type CaseDecision, type CaseSide, decideCase, SERVER_CHECKS_VERSION } from "./decide.ts";

export type JobStatus = "pending" | "claimed" | "done" | "failed" | "superseded";

/** worker_case_snapshot: the job's state, when the snapshot was taken for a job. */
export interface SnapshotJob {
  id: string;
  status: JobStatus;
  attempts: number;
  captureId: string;
  kind: CaptureSide;
  captureLive: boolean;
}

export interface CaseSnapshot {
  verificationId: string;
  declaredDocument: DeclaredDocument | null;
  /** The newest live photo of each side, with the evidence of its finished job. */
  sides: CaseSide[];
  fingerprint: string;
  job: SnapshotJob | null;
}

/** The case-level checks as worker_record_result and worker_write_case store them. */
export interface CaseChecksPayload {
  version: string;
  classification: CaseDecision["classification"] | null;
  reasons: PolicyReason[];
}

/** Null: no photo of the case has a server result; the database then drops the classification. */
export function caseChecksPayload(decision: CaseDecision | null): CaseChecksPayload | null {
  return decision
    ? { version: SERVER_CHECKS_VERSION, classification: decision.classification, reasons: decision.reasons }
    : null;
}

export type CaseWriteResult = "ok" | "stale" | "not_found";

export interface CaseStore {
  /** worker_case_snapshot for a case; null when the case does not exist. */
  snapshot(verificationId: string): Promise<CaseSnapshot | null>;
  /** worker_write_case: 'stale' when the case changed since the snapshot with this fingerprint. */
  write(verificationId: string, fingerprint: string, checks: CaseChecksPayload | null): Promise<CaseWriteResult>;
}

/**
 * Two photos of a case finishing at the same moment make one write stale; deciding again from a fresh
 * snapshot settles it. More rounds than that means something keeps changing the case: give up and
 * let the next write decide.
 */
export const CASE_WRITE_ROUNDS = 5;

/** Decides the case again from its current photos and writes the result. */
export async function refreshCase(store: CaseStore, verificationId: string): Promise<CaseWriteResult> {
  for (let round = 0; round < CASE_WRITE_ROUNDS; round++) {
    const snapshot = await store.snapshot(verificationId);
    if (!snapshot) return "not_found";
    const decision = decideCase(snapshot.declaredDocument, snapshot.sides);
    const result = await store.write(verificationId, snapshot.fingerprint, caseChecksPayload(decision));
    if (result !== "stale") return result;
  }
  return "stale";
}

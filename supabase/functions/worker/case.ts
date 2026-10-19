// The case-level server checks (classification, consistency and document_policy) are decided from a
// snapshot of the case and written only if the case has not changed since: the database compares the
// snapshot's fingerprint under the case lock and answers 'stale' otherwise (see the M3 migration). Used
// by the worker function after a result and by the flow function after a photo was replaced or the
// document changed.
//
// M4: the snapshot also carries the values the consistency checks compare (documentData), decrypted
// by the database for this decision only. They are never logged, and only generic codes come out.
import {
  type CaptureSide,
  type DeclaredDocument,
  type PolicyReason,
  REQUIRED_SIDES,
} from "../_shared/contract.ts";
import { type ConsistencyDecision, decideConsistency, type SideDocumentData } from "./consistency.ts";
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
  /** M4: what the server read on those photos (code lines, printed fields without the sub-type). */
  documentData: SideDocumentData[];
  fingerprint: string;
  job: SnapshotJob | null;
}

/** The case-level checks as worker_record_result and worker_write_case store them. */
export interface CaseChecksPayload {
  version: string;
  classification: CaseDecision["classification"] | null;
  /** The decided reasons and, since M4, the consistency flags, sorted. */
  reasons: PolicyReason[];
  /** M4; null drops the stored check. */
  consistency: ConsistencyDecision | null;
}

/** The snapshot's parts the decision depends on. */
export type CaseInputs = Pick<CaseSnapshot, "declaredDocument" | "sides" | "documentData">;

/**
 * Every case-level check from the newest live photo of each side the declared document needs. Null:
 * no such photo has a server result; the database then drops the case-level checks.
 */
export function decideCaseChecks(inputs: CaseInputs, now: Date): CaseChecksPayload | null {
  const { declaredDocument: declared } = inputs;
  const decision = decideCase(declared, inputs.sides);
  if (!decision) return null;
  // The same photos as decideCase: checked, and of a side this document needs.
  const required: readonly CaptureSide[] | null = declared ? REQUIRED_SIDES[declared] : null;
  const data = inputs.sides
    .filter((side) => side.evidence !== null && (!required || required.includes(side.kind)))
    .map((side): SideDocumentData =>
      inputs.documentData.find((d) => d.captureId === side.captureId) ??
        { kind: side.kind, captureId: side.captureId, mrzLines: null, fields: null }
    );
  const consistency = decideConsistency(declared, data, now);
  const reasons = [...new Set<PolicyReason>([...decision.reasons, ...consistency.details.flags])].sort();
  return { version: SERVER_CHECKS_VERSION, classification: decision.classification, reasons, consistency };
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
export async function refreshCase(
  store: CaseStore,
  verificationId: string,
  now: () => Date = () => new Date(),
): Promise<CaseWriteResult> {
  for (let round = 0; round < CASE_WRITE_ROUNDS; round++) {
    const snapshot = await store.snapshot(verificationId);
    if (!snapshot) return "not_found";
    const result = await store.write(verificationId, snapshot.fingerprint, decideCaseChecks(snapshot, now()));
    if (result !== "stale") return result;
  }
  return "stale";
}

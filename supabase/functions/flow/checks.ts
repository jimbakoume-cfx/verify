// GET /flow/checks (M3): what the rider is told about the server's check of each photo. Pure, from the
// rows of flow_check_state, so every rule is tested with tables. Nothing personal is returned.
// M4: also whether the document has expired, from the case's consistency flags.
import {
  type CaptureSide,
  type FlowCheckSide,
  type FlowChecks,
  SERVER_RETAKES_PER_SIDE,
} from "../_shared/contract.ts";
import { isRetakeReason } from "../worker/decide.ts";

/** One document photo of the case (flow_check_state). */
export interface CheckStateRow {
  captureId: string;
  kind: string;
  /** Not erased or replaced. */
  live: boolean;
  createdAt: string;
  /** worker_job.status; null for a photo taken before M3 (no job). */
  jobStatus: string | null;
  jobError: string | null;
  /** The flow function could not ring the worker for this photo. */
  ringFailed: boolean;
  /** quality_server details.verdict, once the server has checked the photo. */
  qualityVerdict: string | null;
  /** The phone read every check digit of this photo's code lines right (its mrz check passed). */
  phoneMrzPass: boolean | null;
}

/** What GET /flow/checks needs from the case's consistency check (M4). */
export interface ExpiryState {
  /** The consistency check's firm flags include document_expired (code lines, every check digit right). */
  expiredFlag: boolean;
  /** The side that carries the declared document's code lines; null when it has none. */
  mrzSide: CaptureSide | null;
}

const NO_EXPIRY: ExpiryState = { expiredFlag: false, mrzSide: null };

/**
 * The state of the newest live photo of each required side; null when a required side has no live
 * photo. 'retake' only for no_document or unreadable, only while the side has had fewer than
 * SERVER_RETAKES_PER_SIDE server retakes, and never when the phone read the photo's code lines with
 * every check digit right (the photo is then readable, whatever the server's reader made of it).
 * Beyond that a bad photo is flagged for staff, never refused. 'unchecked' at once when the server
 * cannot check the photo (job given up, over budget, session not eligible, or the worker unreachable).
 * `expired` (M4) only once the newest photo of the side that carries the code lines has been checked:
 * the flag then comes from that very photo (a replaced photo's data is deleted and the case decided
 * again), never from an earlier one.
 */
export function flowChecks(
  requiredSides: readonly CaptureSide[],
  rows: readonly CheckStateRow[],
  expiry: ExpiryState = NO_EXPIRY,
): FlowChecks | null {
  const sides: FlowCheckSide[] = [];
  for (const kind of requiredSides) {
    const ofSide = rows.filter((row) => row.kind === kind);
    const newest = ofSide.filter((row) => row.live)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!newest) return null;
    // Earlier photos of the side the server found unusable: each was a retake it asked for.
    const retakes = ofSide.filter((row) => row !== newest && isRetakeReason(row.qualityVerdict)).length;
    sides.push({ kind, captureId: newest.captureId, ...sideState(newest, retakes) });
  }
  const mrzSide = sides.find((side) => side.kind === expiry.mrzSide);
  const expired = expiry.expiredFlag && (mrzSide?.state === "ok" || mrzSide?.state === "retake");
  return { done: sides.every((side) => side.state !== "pending"), sides, expired };
}

function sideState(row: CheckStateRow, retakes: number): Pick<FlowCheckSide, "state" | "reason"> {
  switch (row.jobStatus) {
    case "pending":
      return { state: row.ringFailed ? "unchecked" : "pending", reason: null };
    case "claimed":
      return { state: "pending", reason: null };
    case "done":
      if (isRetakeReason(row.qualityVerdict) && retakes < SERVER_RETAKES_PER_SIDE && row.phoneMrzPass !== true) {
        return { state: "retake", reason: row.qualityVerdict };
      }
      return { state: "ok", reason: null };
    default:
      // failed (budget, ineligible, attempts, expired), or no job at all.
      return { state: "unchecked", reason: null };
  }
}

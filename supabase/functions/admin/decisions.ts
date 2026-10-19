// M8: staff decisions and threshold versions (contract.ts, "Decisions and thresholds"). Request checks
// and the database's answers; the routes are in handler.ts, the Supabase calls in repo.ts. The database
// re-checks every rule (staff_decide, staff_create_threshold_version) and writes the audit entries.
import {
  DECISION_NOTE_MAX_LENGTH,
  type DecisionOutcome,
  type DecisionRequest,
  STAFF_DECISIONS,
  THRESHOLD_NOTE_MAX_LENGTH,
  THRESHOLD_NOTE_MIN_LENGTH,
  type ThresholdVersionRequest,
} from "../_shared/contract.ts";
import { badRequest, HttpError, isOneOf, isPlainObject, isUuid } from "../_shared/http.ts";
import { thresholdConfigErrors } from "../_shared/risk.ts";

/** What staff_decide answers; "forbidden" when the database refused the staff member (a role changed meanwhile). */
export type DecideResult =
  | {
    result: "ok";
    decisionId: string;
    status: "approved" | "rejected";
    recommendation: DecisionOutcome | null;
    agreesWithRecommendation: boolean | null;
    thresholdVersion: number | null;
  }
  | { result: "not_found" | "already_decided" | "not_submitted" | "note_required" | "invalid_reason" | "forbidden" };

/** What staff_create_threshold_version answers. */
export type ThresholdResult =
  | { result: "created"; version: number; rescored: number }
  | { result: "stale"; version: number }
  | { result: "invalid"; errors: string[] }
  | { result: "invalid_note" | "unchanged" | "forbidden" };

export interface DecisionRepo {
  /** staff_decide: re-checks the access rule, records the decision, closes the case and audits. */
  decide(input: {
    verificationId: string;
    actorId: string;
    role: "reviewer" | "supervisor";
    outcome: DecisionRequest["outcome"];
    reasonCode: string | null;
    note: string | null;
  }): Promise<DecideResult>;
  /** staff_create_threshold_version: admin only; the new version is active at once and audited. */
  createThresholdVersion(input: {
    actorId: string;
    baseVersion: number;
    config: Record<string, unknown>;
    note: string;
  }): Promise<ThresholdResult>;
}

/** reason_code.code values look like this (DOC_EXPIRED, OTHER). */
const REASON_CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
// Free text typed by staff: printable characters, tabs and line breaks only.
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** A staff note: trimmed, null when empty; 400 when too long or holding control characters. */
export function normaliseNote(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest("note must be a string.");
  const note = value.trim();
  if ([...note].length > maxLength) throw badRequest("note is too long.");
  if (CONTROL_RE.test(note)) throw badRequest("note holds control characters.");
  return note === "" ? null : note;
}

export function parseDecisionRequest(body: Record<string, unknown>): DecisionRequest {
  if (!isUuid(body.verificationId)) throw badRequest("verificationId must be a UUID.");
  if (!isOneOf(STAFF_DECISIONS, body.outcome)) throw badRequest("outcome must be approve or reject.");
  const reasonCode = body.reasonCode ?? null;
  if (reasonCode !== null && (typeof reasonCode !== "string" || !REASON_CODE_RE.test(reasonCode))) {
    throw badRequest("reasonCode is not a reason code.");
  }
  // A reject tells the rider why; an approval has nothing to explain to them.
  if ((body.outcome === "reject") !== (reasonCode !== null)) throw new HttpError(422, "invalid_reason");
  return {
    verificationId: body.verificationId.toLowerCase(),
    outcome: body.outcome,
    reasonCode,
    note: normaliseNote(body.note, DECISION_NOTE_MAX_LENGTH),
  };
}

export function parseThresholdRequest(body: Record<string, unknown>): ThresholdVersionRequest {
  const { baseVersion, config } = body;
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 1) {
    throw badRequest("baseVersion must be a version number.");
  }
  if (!isPlainObject(config)) throw badRequest("config must be an object.");
  const errors = thresholdConfigErrors(config);
  // The codes only (paths and generic codes): the dashboard shows its own text for each.
  if (errors.length > 0) throw badRequest(`Invalid configuration: ${errors.slice(0, 10).join(", ")}`);
  const note = normaliseNote(body.note, THRESHOLD_NOTE_MAX_LENGTH);
  if (note === null || [...note].length < THRESHOLD_NOTE_MIN_LENGTH) throw badRequest("A reason (note) is required.");
  return { baseVersion, config, note };
}

// What the case page shows about the server's checks (M3): per side, the newest live photo and the
// server's results for it; per case, the document recognised, the reasons a person must decide and,
// since M4, the consistency of the document's data. Pure functions, so the rules are tested without
// rendering.
import {
  CAPTURE_SIDES,
  type CaptureSide,
  type ClassificationDetails,
  type ConsistencyDetails,
  type ConsistencyFlag,
  type DeclaredDocument,
  type DocumentPolicyDetails,
  HARD_FLAGS,
  MRZ_EXPECTATION,
  type MrzFormat,
  type MrzServerDetails,
  type OcrFieldsDetails,
  POLICY_REASONS,
  type PolicyReason,
  type QualityServerDetails,
  REQUIRED_SIDES,
} from "@verify/shared";
import { type CaptureRecord, type CheckRecord, newestLiveCaptures, type ServerChecks, type ServerJobState } from "./records";

/**
 * Decided per photo, from its own job. no_photo: nothing to check yet. pending: its job is queued or
 * being read. unchecked: the server gave up on this photo (worker down, daily budget reached, real
 * session while only test sessions are processed). not_sent: the photo has no job, because it was
 * taken before the server checks existed. checked: the server's results for this photo are in.
 */
export type ServerSideState = "no_photo" | "pending" | "unchecked" | "not_sent" | "checked";

const STATE_OF_JOB: Record<ServerJobState, ServerSideState> = { waiting: "pending", done: "checked", failed: "unchecked" };

export interface ServerSide {
  side: CaptureSide;
  /** The newest live photo of the side: older and erased photos are not shown here. */
  capture: CaptureRecord | null;
  state: ServerSideState;
  quality: CheckRecord<QualityServerDetails> | null;
  /** Only on the side that carries the declared document's code lines. */
  mrz: CheckRecord<MrzServerDetails> | null;
  fields: CheckRecord<OcrFieldsDetails> | null;
  /** The declared document carries its code lines on this side, in this format. */
  mrzFormat: MrzFormat | null;
}

export interface ServerOverview {
  sides: ServerSide[];
  classification: CheckRecord<ClassificationDetails> | null;
  policy: CheckRecord<DocumentPolicyDetails> | null;
  /** M4: the document compared with itself and with today's date. */
  consistency: CheckRecord<ConsistencyDetails> | null;
  /** The reasons a person must decide, in the contract's order (the hard flags first). */
  reasons: PolicyReason[];
  /** Flagged, but for no reason this dashboard knows (a newer server version). */
  unknownFlag: boolean;
  /** Some photo has a server result, or the server has decided something about the case. */
  started: boolean;
}

/** Newest result for this photo, if any (the database keeps one per photo and check). */
function forCapture<T extends { captureId: string | null }>(checks: readonly T[], captureId: string): T | null {
  return checks.find((c) => c.captureId === captureId) ?? null;
}

/**
 * The sides the declared document needs (or, before it is chosen, those photographed), front first,
 * plus any other document side photographed. `checks` lists are latest first, as toServerChecks
 * returns them.
 */
export function serverOverview(
  declared: DeclaredDocument | null,
  captures: readonly CaptureRecord[],
  checks: ServerChecks,
): ServerOverview {
  const newest = newestLiveCaptures(captures);
  const required: readonly CaptureSide[] = declared ? REQUIRED_SIDES[declared] : [];
  const expectation = declared ? MRZ_EXPECTATION[declared] : null;
  // In the contract's order (the hard flags first), whatever order they were given in.
  const given = checks.policy?.details?.reasons ?? [];
  const reasons = POLICY_REASONS.filter((reason) => given.includes(reason));

  const sides = CAPTURE_SIDES.filter((side) => required.includes(side) || newest.has(side)).map((side): ServerSide => {
    const capture = newest.get(side) ?? null;
    const quality = capture ? forCapture(checks.quality, capture.id) : null;
    const mrz = capture ? forCapture(checks.mrz, capture.id) : null;
    const fields = capture ? forCapture(checks.fields, capture.id) : null;
    // Never from the case-wide server_unchecked reason: one photo given up on says nothing about the
    // other side, which may still be on its way.
    let state: ServerSideState = "no_photo";
    if (capture) {
      const job = checks.jobs.get(capture.id);
      state = quality || mrz || fields ? "checked" : job ? STATE_OF_JOB[job] : "not_sent";
    }
    return {
      side,
      capture,
      state,
      quality,
      mrz,
      fields,
      mrzFormat: expectation?.side === side ? expectation.format : null,
    };
  });

  return {
    sides,
    classification: checks.classification,
    policy: checks.policy,
    consistency: checks.consistency,
    reasons,
    unknownFlag: checks.policy?.outcome === "flag" && checks.policy.details !== null && reasons.length === 0,
    started: sides.some((s) => s.state === "checked") || checks.classification !== null || checks.policy !== null ||
      checks.consistency !== null,
  };
}

/**
 * A hard flag (M4, PM 2026-10-15): such a case is never approved automatically once automatic
 * decisions exist (M8). The page shows these reasons first, in red, with their own badge.
 */
export function isHardFlag(code: string): code is ConsistencyFlag {
  return (HARD_FLAGS as readonly string[]).includes(code);
}

/** What the consistency check was based on, as the page says it. */
export const CONSISTENCY_BASIS_KEY: Record<ConsistencyDetails["basis"], string> = {
  mrz: "serverChecks.consistency.basis.mrz",
  printed: "serverChecks.consistency.basis.printed",
  none: "serverChecks.consistency.basis.none",
};

/**
 * Label of the server's sharpness. It is the phone's focus score (compared with 5), not the raw
 * Laplacian variance the Photos section shows as "Sharpness": for the same photo the two differ 15-25
 * times, so they never share a label.
 */
export const SERVER_FOCUS_LABEL = "serverChecks.quality.focus";

export type Tone = "neutral" | "ok" | "warn" | "bad";

/** Badge colour of the photo check's verdict: retake reasons are the worst, "poor" is only flagged. */
export const VERDICT_TONE: Record<QualityServerDetails["verdict"], Tone> = {
  ok: "ok",
  poor: "warn",
  no_document: "bad",
  unreadable: "bad",
};

/** Whether the document recognised is the one declared: unknown when nothing was recognised. */
export function declaredMatch(details: Pick<ClassificationDetails, "matchesDeclared">): "yes" | "no" | "unknown" {
  if (details.matchesDeclared === null) return "unknown";
  return details.matchesDeclared ? "yes" : "no";
}

/**
 * Whether "Show data read" may have something to show: lines the phone read, or any photo the server
 * has processed (it may have stored code lines or printed text; even the presence of a card's
 * sub-type is not in check_result, so the server is asked and an empty answer says so).
 */
export function mayHaveDocumentData(phoneLinesRead: boolean, server: ServerChecks | undefined): boolean {
  if (phoneLinesRead) return true;
  if (!server) return false;
  return server.quality.length > 0 || server.mrz.length > 0 || server.fields.length > 0;
}

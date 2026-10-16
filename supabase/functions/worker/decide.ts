// Decisions of the server checks (M3), made from the AI worker's evidence. Pure: no I/O, so each rule
// is tested with tables (decide.test.ts). The worker only measures and reads; everything that becomes
// a check result, a retake or a reason for staff to look is decided here.
//
// Privacy: check_result.details (built here) hold outcomes, generic codes, counts and metrics only.
// Never a value read from the document, never the card sub-type, never a nationality: supervisors and
// admins read check_result directly. Values go to the database only as the encrypted rows' plaintext.
// The keyword counts stay in the job's evidence: on a passport, they tell a Cameroonian one (its
// "RÉPUBLIQUE DU CAMEROUN" header) from a foreign one.
import {
  type CaptureSide,
  type ClassificationDetails,
  type DeclaredDocument,
  type DetectedDocumentType,
  KEYWORD_GROUPS,
  type KeywordGroup,
  MRZ_EXPECTATION,
  type MrzExpectation,
  type MrzFormat,
  type MrzServerDetails,
  type OcrFieldsDetails,
  type PolicyReason,
  type QualityServerDetails,
  REQUIRED_SIDES,
  type RetakeReason,
  SERVER_CHECK_NAMES,
  type WorkerFields,
  type WorkerQuality,
  type WorkerResultRequest,
} from "../_shared/contract.ts";
import { documentCodeFits, MRZ_PARSER_VERSION, type ParsedMrz, parseMrz } from "../_shared/mrz.ts";
import { correctMrz } from "../_shared/mrzCorrect.ts";

/**
 * Bump when a rule below changes: stored with each server check (check_result.check_version). The
 * database labels a policy it writes on its own (a job given up) the same way.
 */
export const SERVER_CHECKS_VERSION = "server-checks-v1";

export type CheckOutcome = "pass" | "flag";

// ---------------------------------------------------------------------------
// Photo quality
// ---------------------------------------------------------------------------
/**
 * Provisional, until tuned on the PM's real photos. Only "no text at all" asks for a retake; the
 * other limits are the phone's starting values (packages/capture DEFAULT_THRESHOLDS) and only flag.
 */
export const SERVER_QUALITY_THRESHOLDS = {
  /** Fewer lines of text than this: no usable text (or no document, when none was found either). */
  minTextLines: 3,
  minDocumentConfidence: 0.5,
  minSharpness: 5,
  maxGlareRatio: 0.02,
  minMeanLuma: 50,
  maxMeanLuma: 225,
} as const;

export type QualityVerdict = QualityServerDetails["verdict"];

/**
 * no_document: no card or page found and almost no text. unreadable: a document but almost no text.
 * Code lines read on the photo prove it readable, whatever the metrics say. poor: readable, but a
 * metric is off (flagged, never retaken). ok: nothing to say.
 */
export function qualityVerdict(q: WorkerQuality, codeLinesRead: boolean): QualityVerdict {
  const t = SERVER_QUALITY_THRESHOLDS;
  if (!codeLinesRead && q.textLines < t.minTextLines) return q.documentFound ? "unreadable" : "no_document";
  const poor = !q.documentFound || q.documentConfidence < t.minDocumentConfidence || q.sharpness < t.minSharpness ||
    q.glareRatio > t.maxGlareRatio || q.meanLuma < t.minMeanLuma || q.meanLuma > t.maxMeanLuma;
  return poor ? "poor" : "ok";
}

export function isRetakeReason(verdict: unknown): verdict is RetakeReason {
  return verdict === "no_document" || verdict === "unreadable";
}

// ---------------------------------------------------------------------------
// Code lines read by the server
// ---------------------------------------------------------------------------
/** ICAO code of Cameroon, as issuing state and as nationality. */
export const CAMEROON = "CMR";

/**
 * Document family told by code lines (firm). foreign_card: an ID-1 card issued by another state,
 * which is not accepted. Kept only in the job's evidence and turned into generic codes below.
 */
export type MrzFamily = "passport" | "cni_biometric" | "residence_permit" | "foreign_card";

/**
 * TD3 with a code starting P: a passport, from any state. TD1 issued by Cameroon: the new CNI when
 * the holder is Cameroonian, otherwise one of the new foreigner cards (which one comes from the printed
 * title, into the encrypted fields only). TD1 from another state: foreign_card.
 */
export function mrzFamily(parsed: ParsedMrz): MrzFamily | null {
  if (parsed.format === "TD3") return /^P/.test(parsed.documentCode) ? "passport" : null;
  if (!/^[IAC]/.test(parsed.documentCode)) return null;
  if (parsed.issuingState !== CAMEROON) return "foreign_card";
  return parsed.nationality === CAMEROON ? "cni_biometric" : "residence_permit";
}

export interface ServerMrzRead {
  /** The expected code lines, on the side that carries them (stored encrypted); null otherwise. */
  lines: string[] | null;
  /** check_result mrz_server, on the side that carries the code lines; null on the other side. */
  check: { outcome: CheckOutcome; details: MrzServerDetails } | null;
  /** Firm evidence of the document family, from whichever code lines were read. */
  family: { family: MrzFamily; valid: boolean } | null;
  /** Code lines of either format were read: the photo is readable. */
  anyRead: boolean;
}

const OTHER_FORMAT: Record<MrzFormat, MrzFormat> = { TD1: "TD3", TD3: "TD1" };

/**
 * Runs the shared corrector and parser (the same as the phone's) on the worker's candidate lines.
 * The side that carries the code lines tries the expected format first, then the other one (a TD1
 * card shown for a declared passport says so); any other side tries both, for the classification
 * only. Lines are kept only when they are the expected ones on the expected side.
 */
export function readServerMrz(
  candidates: readonly string[],
  expectation: MrzExpectation | null,
  side: CaptureSide,
  today: Date,
): ServerMrzRead {
  const carries = expectation !== null && expectation.side === side;
  const formats: MrzFormat[] = carries ? [expectation.format, OTHER_FORMAT[expectation.format]] : ["TD1", "TD3"];
  const text = candidates.join("\n");
  const reads = formats.flatMap((format) => {
    const corrected = correctMrz(text, format);
    const parsed = corrected.lines ? parseMrz(corrected.lines, today) : null;
    return corrected.lines && parsed ? [{ format, lines: corrected.lines, corrections: corrected.corrections, parsed }] : [];
  });
  const expected = carries ? reads.find((r) => r.format === expectation.format) ?? null : null;
  const used = expected ?? reads[0] ?? null;
  const family = used ? mrzFamily(used.parsed) : null;

  let check: ServerMrzRead["check"] = null;
  if (carries) {
    const codeFits = used ? documentCodeFits(expectation.format, used.parsed.documentCode) : null;
    const pass = expected !== null && expected.parsed.valid && expected.parsed.datesValid && codeFits === true;
    check = {
      outcome: pass ? "pass" : "flag",
      details: {
        parserVersion: MRZ_PARSER_VERSION,
        found: expected !== null,
        format: used?.format ?? null,
        // Copied field by field so that nothing else from the parser (names, numbers, dates) can reach details.
        checks: used
          ? {
            documentNumber: used.parsed.checks.documentNumber,
            birthDate: used.parsed.checks.birthDate,
            expiryDate: used.parsed.checks.expiryDate,
            ...(used.parsed.checks.personalNumber === undefined ? {} : { personalNumber: used.parsed.checks.personalNumber }),
            composite: used.parsed.checks.composite,
          }
          : null,
        documentCodeFits: codeFits,
        datesValid: used?.parsed.datesValid ?? null,
        corrections: used?.corrections ?? 0,
        // Filled in by the database, which compares with the phone's report (worker_record_result).
        phone: "missing",
      },
    };
  }
  return {
    lines: expected ? [...expected.lines] : null,
    check,
    family: family && used ? { family, valid: used.parsed.valid } : null,
    anyRead: reads.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Printed fields
// ---------------------------------------------------------------------------
/** Every field of WorkerFields, in the order they are stored. */
export const WORKER_FIELD_NAMES = [
  "surname",
  "givenNames",
  "documentNumber",
  "birthDate",
  "expiryDate",
  "issueDate",
  "subtype",
] as const satisfies readonly (keyof WorkerFields)[];

/**
 * Names of the fields read (never their values). The sub-type is left out: even its presence says
 * something about the card, and it is visible only through the audited viewer.
 */
export function fieldsCheck(fields: WorkerFields): { outcome: CheckOutcome; details: OcrFieldsDetails } {
  const found = WORKER_FIELD_NAMES.filter((name) => name !== "subtype" && fields[name] !== undefined);
  return { outcome: found.length > 0 ? "pass" : "flag", details: { found, provisional: true } };
}

/** The fields as stored encrypted (a JSON object in a fixed key order); null when nothing was read. */
export function fieldsPlaintext(fields: WorkerFields): string | null {
  const ordered: WorkerFields = {};
  for (const name of WORKER_FIELD_NAMES) {
    const value = fields[name];
    if (value !== undefined) ordered[name] = value;
  }
  return Object.keys(ordered).length > 0 ? JSON.stringify(ordered) : null;
}

// ---------------------------------------------------------------------------
// One photo's result
// ---------------------------------------------------------------------------
/**
 * What the case-level decision keeps from one photo, stored with its job (never readable by staff,
 * and still nothing read from the document).
 */
export interface CaptureEvidence {
  /** Family told by code lines on this photo, if any were read. */
  mrz: { family: MrzFamily; valid: boolean } | null;
  /** On the side that carries the code lines: whether the expected ones were read. Null elsewhere. */
  expectedMrzFound: boolean | null;
  /**
   * On the side that carries the code lines: whether its mrz_server check passed (expected lines read,
   * every check digit right, real dates, a document code that fits). Null elsewhere.
   */
  expectedMrzValid: boolean | null;
  /** Never copied into check_result (see the top of this file). */
  keywordHits: Partial<Record<KeywordGroup, number>>;
  qrPresent: boolean;
  orientation: "landscape" | "portrait" | null;
}

export interface CaptureCheck {
  name: typeof SERVER_CHECK_NAMES.quality | typeof SERVER_CHECK_NAMES.mrz | typeof SERVER_CHECK_NAMES.fields;
  version: string;
  outcome: CheckOutcome;
  details: QualityServerDetails | MrzServerDetails | OcrFieldsDetails;
}

export interface CaptureDecision {
  verdict: QualityVerdict;
  checks: CaptureCheck[];
  evidence: CaptureEvidence;
  /** The expected code lines joined with "\n", and their format; null when they were not read. */
  mrzLines: string | null;
  mrzFormat: MrzFormat | null;
  /** WorkerFields as a JSON object; null when no field was read. */
  fields: string | null;
}

/** Decides everything about one photo from the worker's (validated) result. */
export function decideCapture(
  result: WorkerResultRequest,
  side: CaptureSide,
  declared: DeclaredDocument | null,
  today: Date,
): CaptureDecision {
  const expectation = declared ? MRZ_EXPECTATION[declared] : null;
  const mrz = readServerMrz(result.mrzCandidates, expectation, side, today);
  const verdict = qualityVerdict(result.quality, mrz.anyRead);
  const q = result.quality;
  const quality: QualityServerDetails = {
    verdict,
    // Copied field by field: only the known metrics are stored.
    quality: {
      sharpness: q.sharpness,
      glareRatio: q.glareRatio,
      meanLuma: q.meanLuma,
      documentFound: q.documentFound,
      documentConfidence: q.documentConfidence,
      longSide: q.longSide,
      textLines: q.textLines,
    },
    provisional: true,
    engine: result.engine,
    timing: { ms: result.timing.ms, cold: result.timing.cold },
  };
  const checks: CaptureCheck[] = [{
    name: SERVER_CHECK_NAMES.quality,
    version: SERVER_CHECKS_VERSION,
    outcome: verdict === "ok" ? "pass" : "flag",
    details: quality,
  }];
  if (mrz.check) {
    checks.push({ name: SERVER_CHECK_NAMES.mrz, version: MRZ_PARSER_VERSION, ...mrz.check });
  }
  checks.push({ name: SERVER_CHECK_NAMES.fields, version: SERVER_CHECKS_VERSION, ...fieldsCheck(result.fields) });

  const keywordHits: Partial<Record<KeywordGroup, number>> = {};
  for (const group of KEYWORD_GROUPS) {
    const hits = result.classification.keywordHits[group];
    if (hits !== undefined && hits > 0) keywordHits[group] = hits;
  }
  return {
    verdict,
    checks,
    evidence: {
      mrz: mrz.family,
      expectedMrzFound: mrz.check ? mrz.lines !== null : null,
      expectedMrzValid: mrz.check ? mrz.check.outcome === "pass" : null,
      keywordHits,
      qrPresent: result.classification.qrPresent,
      orientation: result.classification.orientation,
    },
    mrzLines: mrz.lines ? mrz.lines.join("\n") : null,
    mrzFormat: mrz.lines && expectation ? expectation.format : null,
    fields: fieldsPlaintext(result.fields),
  };
}

// ---------------------------------------------------------------------------
// The whole case: classification and the reasons a person must decide
// ---------------------------------------------------------------------------
export interface CaseSide {
  kind: CaptureSide;
  captureId: string;
  /** Null while the photo has no server result. */
  evidence: CaptureEvidence | null;
}

export interface CaseDecision {
  classification: { outcome: CheckOutcome; score: number; details: ClassificationDetails };
  /** Decided from the photos. The database adds server_unchecked, phone_report_missing and mrz_disagreement. */
  reasons: PolicyReason[];
}

/** Keyword groups that each point to one document family; the others only support. */
const FAMILY_OF_GROUP: Partial<Record<KeywordGroup, DetectedDocumentType>> = {
  national_id: "cni_legacy", // or cni_biometric: see keywordFamily
  passport: "passport",
  residence: "residence_permit",
  driving_licence: "driving_licence",
  voter_card: "voter_card",
};

/**
 * Documents a person always decides (PM, 2026-10-14): no machine-checkable data (old CNI, driving
 * licence, voter card), and every residence permit, so that the reason never tells a refugee card
 * from the others.
 */
export const MANUAL_REVIEW_DOCUMENTS: readonly DetectedDocumentType[] = [
  "cni_legacy",
  "driving_licence",
  "voter_card",
  "residence_permit",
];

/** Provisional keyword classifications are capped here; code lines give 1 (all check digits right) or 0.8. */
const KEYWORD_CONFIDENCE_CAP = 0.5;

function keywordFamily(sides: readonly CaseSide[]): { detected: DetectedDocumentType; confidence: number } | null {
  const totals = new Map<DetectedDocumentType, number>();
  for (const side of sides) {
    for (const [group, family] of Object.entries(FAMILY_OF_GROUP) as [KeywordGroup, DetectedDocumentType][]) {
      const hits = side.evidence?.keywordHits[group] ?? 0;
      if (hits > 0) totals.set(family, (totals.get(family) ?? 0) + hits);
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0][1] === ranked[1][1])) return null;
  const sum = ranked.reduce((s, [, hits]) => s + hits, 0);
  let detected = ranked[0][0];
  if (detected === "cni_legacy") {
    // The new CNI's front is upright and its back carries a QR code; the old card has neither.
    const front = sides.find((s) => s.kind === "document_front")?.evidence;
    const newCard = front?.orientation === "portrait" || sides.some((s) => s.evidence?.qrPresent === true);
    if (newCard) detected = "cni_biometric";
  }
  return { detected, confidence: round(KEYWORD_CONFIDENCE_CAP * (ranked[0][1] / sum)) };
}

/**
 * The case-level checks from the newest live photo of each side the declared document needs, or null
 * while no such photo has a server result. A photo of another side (left from an earlier choice of
 * document, M4) does not count. Code lines decide the family firmly (the side that carries them
 * first); otherwise keywords decide provisionally (shown as such, never a retake or a decision on
 * their own).
 */
export function decideCase(declared: DeclaredDocument | null, sides: readonly CaseSide[]): CaseDecision | null {
  const required: readonly CaptureSide[] | null = declared ? REQUIRED_SIDES[declared] : null;
  const known = sides.filter((s) => s.evidence !== null && (!required || required.includes(s.kind)));
  if (known.length === 0) return null;
  const expectation = declared ? MRZ_EXPECTATION[declared] : null;

  const firm = known
    .filter((s) => s.evidence!.mrz !== null)
    .sort((a, b) => rank(b) - rank(a))[0];
  function rank(s: CaseSide): number {
    return (expectation && s.kind === expectation.side ? 2 : 0) + (s.evidence!.mrz!.valid ? 1 : 0);
  }

  let detected: DetectedDocumentType = "unknown";
  let basis: ClassificationDetails["basis"] = "none";
  let confidence = 0;
  if (firm) {
    const mrz = firm.evidence!.mrz!;
    detected = mrz.family === "foreign_card" ? "unknown" : mrz.family;
    basis = "mrz";
    confidence = mrz.valid ? 1 : 0.8;
  } else {
    const byKeywords = keywordFamily(known);
    if (byKeywords) {
      detected = byKeywords.detected;
      basis = "keywords";
      confidence = byKeywords.confidence;
    }
  }

  const provisional = basis !== "mrz";
  const matchesDeclared = declared && detected !== "unknown" ? detected === declared : null;
  // Field by field, and no keyword counts (see the top of this file): the database refuses any other key.
  const details: ClassificationDetails = {
    detected,
    basis,
    provisional,
    matchesDeclared,
    confidence,
    qrPresent: known.some((s) => s.evidence!.qrPresent),
  };

  const reasons = new Set<PolicyReason>();
  if ((declared && MANUAL_REVIEW_DOCUMENTS.includes(declared)) || MANUAL_REVIEW_DOCUMENTS.includes(detected)) {
    reasons.add("manual_review_document");
  }
  if (known.some((s) => s.evidence!.mrz?.family === "foreign_card")) reasons.add("unsupported_document");
  if (!provisional && matchesDeclared === false) reasons.add("type_mismatch");
  // Printed words only: provisional. Nothing at all (no code lines, no title, or tied titles): its own
  // reason, so the page never says "recognised from printed words" about a document it did not recognise.
  if (basis === "keywords") reasons.add("provisional_classification");
  if (basis === "none") reasons.add("unrecognised_document");
  // The side that carries the code lines, when it has a result (known sides all have evidence).
  const mrzEvidence = expectation ? known.find((s) => s.kind === expectation.side)?.evidence ?? null : null;
  if (expectation?.required && mrzEvidence?.expectedMrzFound === false) reasons.add("mrz_unreadable_server");
  // The expected lines were read but fail a check digit, a date or the document code: the one firm sign
  // of a damaged or altered document, even when the phone read the very same lines.
  if (mrzEvidence?.expectedMrzFound === true && mrzEvidence.expectedMrzValid === false) reasons.add("mrz_invalid_server");

  return {
    classification: {
      outcome: !provisional && matchesDeclared === true ? "pass" : "flag",
      score: confidence,
      details,
    },
    reasons: [...reasons].sort(),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Evidence read back from the database
// ---------------------------------------------------------------------------
const FAMILIES: readonly MrzFamily[] = ["passport", "cni_biometric", "residence_permit", "foreign_card"];

/** The evidence stored with a job, checked field by field; null when it is not what decideCapture wrote. */
export function parseEvidence(value: unknown): CaptureEvidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  let mrz: CaptureEvidence["mrz"] = null;
  if (v.mrz !== null) {
    const m = v.mrz as Record<string, unknown> | undefined;
    if (typeof m !== "object" || m === null || !FAMILIES.includes(m.family as MrzFamily) || typeof m.valid !== "boolean") {
      return null;
    }
    mrz = { family: m.family as MrzFamily, valid: m.valid };
  }
  if (v.expectedMrzFound !== null && typeof v.expectedMrzFound !== "boolean") return null;
  if (v.expectedMrzValid !== null && typeof v.expectedMrzValid !== "boolean") return null;
  if (typeof v.qrPresent !== "boolean") return null;
  if (v.orientation !== null && v.orientation !== "landscape" && v.orientation !== "portrait") return null;
  const hits = v.keywordHits;
  if (typeof hits !== "object" || hits === null || Array.isArray(hits)) return null;
  const keywordHits: Partial<Record<KeywordGroup, number>> = {};
  for (const [group, count] of Object.entries(hits)) {
    if (!(KEYWORD_GROUPS as readonly string[]).includes(group)) return null;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
    keywordHits[group as KeywordGroup] = count;
  }
  return {
    mrz,
    expectedMrzFound: v.expectedMrzFound as boolean | null,
    expectedMrzValid: v.expectedMrzValid as boolean | null,
    keywordHits,
    qrPresent: v.qrPresent,
    orientation: v.orientation as CaptureEvidence["orientation"],
  };
}

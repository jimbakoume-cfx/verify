// Risk score, thresholds and recommendation (M8): the Phase 1 rules, transparent and deterministic.
//
// The database computes and stores every assessment (supabase/migrations/20261019000000_m8_decisions.sql:
// private.risk_evaluate and private.risk_config_errors), because only the database sees every write that
// can change a case (a worker result, the phone's report, the sweep giving up on a photo, a new threshold
// version). This file is the same rules in TypeScript: the dashboard validates and compares threshold
// versions with it, and the shared vectors (supabase/tests/risk_vectors.json) are run by both, so the two
// can never drift apart unnoticed.
//
// Imported by Deno (Edge Functions) and, via packages/shared/src/flowApi.ts, by the web apps.
// Types, constants and pure functions only.
import { DECLARED_DOCUMENTS, type DeclaredDocument, type DecisionOutcome } from "./contract.ts";

// ---------------------------------------------------------------------------
// Signals: what the score adds up. Generic codes only, never a value read from a document.
// ---------------------------------------------------------------------------
/**
 * Every signal the score knows, most severe first (this order is also the order of every list in an
 * assessment). Most are the document_policy reasons (M3/M4); the others:
 * - image_reused: the same photo bytes (SHA-256) were uploaded in another verification (M1);
 * - mrz_phone_flag: the phone's report of the code lines was flagged (unreadable, or check digits wrong);
 * - quality_poor: the server found a photo poor (thresholds not tuned yet);
 * - print_name_mismatch: the printed name differs from firm code lines that the phone read the same way
 *   (fixes after the PM's first real test, 2026-10-20): printed-text OCR is provisional, so a name that
 *   differs is a note for staff, never a firm signal (a differing number or date stays mrz_print_mismatch);
 * - liveness_flag, face_match_flag: the liveness (M6) or face match (M7) check ran and did not pass
 *   (flag or fail; both provisional, so they can only send a case to a person).
 * server_unchecked is not a signal: a photo the server could not check is a missing check.
 */
export const RISK_SIGNALS = [
  "document_expired",
  "under_18",
  "image_reused",
  "unsupported_document",
  "mrz_disagreement",
  "mrz_invalid_server",
  "mrz_print_mismatch",
  "type_mismatch",
  "date_logic",
  "number_format",
  "manual_review_document",
  "print_name_mismatch",
  "unrecognised_document",
  "mrz_unreadable_server",
  "mrz_phone_flag",
  "phone_report_missing",
  "provisional_classification",
  "quality_poor",
  "liveness_flag",
  "face_match_flag",
] as const;
export type RiskSignal = (typeof RISK_SIGNALS)[number];

/**
 * Signals added after threshold versions were already stored: a version may leave them out, and then
 * uses the default setting below (normaliseThresholdConfig writes it). Every other signal is required.
 */
export const OPTIONAL_SIGNALS = ["print_name_mismatch"] as const;
export type OptionalSignal = (typeof OPTIONAL_SIGNALS)[number];
export type RequiredSignal = Exclude<RiskSignal, OptionalSignal>;
/** The setting of an optional signal a version leaves out: a note, adding nothing to the score. */
export const OPTIONAL_SIGNAL_DEFAULTS: Record<OptionalSignal, SignalSetting> = {
  print_name_mismatch: { weight: 0, enabled: true },
};
const isOptionalSignal = (code: string): code is OptionalSignal => (OPTIONAL_SIGNALS as readonly string[]).includes(code);

/**
 * Firm signals: computed from code lines whose check digits are all right, or from exact facts (a
 * repeated SHA-256). Only they can make a reject recommendation; every other signal is provisional
 * (printed text, keywords, untuned quality thresholds, uncalibrated liveness and face scores) and
 * can at most send the case to a person. under_18 may come from printed text, so it is provisional.
 */
export const FIRM_SIGNALS: readonly RiskSignal[] = [
  "document_expired",
  "image_reused",
  "unsupported_document",
  "mrz_disagreement",
  "mrz_invalid_server",
  "mrz_print_mismatch",
  "type_mismatch",
  "date_logic",
  "number_format",
];

/**
 * Hard flags every threshold version must keep (PM decisions): an expired document and a holder under
 * 18 are never approved automatically (M4), and some documents are always decided by a person (M3).
 */
export const MANDATORY_HARD_FLAGS: readonly RiskSignal[] = ["document_expired", "under_18", "manual_review_document"];

/** Declared documents always decided by a person (PM, 2026-10-14); every version keeps them. */
export const MANDATORY_REVIEW_DOCUMENTS: readonly DeclaredDocument[] = [
  "cni_legacy",
  "residence_permit",
  "driving_licence",
  "voter_card",
];

/**
 * Checks a case must have before it can be recommended for approval. Not configurable.
 * - server_checks: a photo the declared document needs has no server result (waiting, or given up).
 * - liveness (M6), face_match (M7): the face worker's case-level checks, written for test sessions
 *   (and, for liveness, real sessions once the face switch is on).
 */
export const REQUIRED_CHECKS = ["server_checks", "liveness", "face_match"] as const;
export type RequiredCheck = (typeof REQUIRED_CHECKS)[number];

/** check_result.check_name of the checks written by M6 and M7 (contract.ts LIVENESS_EVAL_CHECK_NAME, FACE_MATCH_CHECK_NAME). */
export const PLACEHOLDER_CHECK_NAMES = { liveness: "liveness", faceMatch: "face_match" } as const;

/**
 * Checks whose threshold is not calibrated (M7): the face match, until it is set on Cameroonian
 * impostor pairs (NIST shows a ~14x higher false-match rate for West Africans at a fixed threshold).
 * The database lists a case's face match under RiskFacts.reviewOnly (private.face_match_review_only).
 * Such a check never helps approve a case (reason review_only_check), unless the active threshold
 * version says otherwise: since the PM's decision of 2026-10-20 (automatic approval), the setting
 * faceMatchCountsForApproval lets a passed face match count. Admins switch it off from the dashboard.
 */
export const REVIEW_ONLY_CHECKS = ["face_match"] as const;

/**
 * Why the recommendation is what it is; every condition that holds is listed, in this order.
 * - hard_flag: a hard flag is present (review, whatever the score);
 * - unknown_signal: a signal this version of the rules does not know (review);
 * - always_review_document: the declared document is always decided by a person (review);
 * - firm_score_high: the firm signals alone reach the reject cut-off (reject, unless one of the above);
 * - provisional_signals: the score reaches the reject cut-off only with provisional signals (review);
 * - score_between: the score is between the two cut-offs (review);
 * - score_low: the score is at or under the approve cut-off;
 * - missing_checks: a required check is missing (no approval);
 * - review_only_check: a check that may never approve is present (M7: the face match; no approval).
 */
export const RISK_REASONS = [
  "hard_flag",
  "unknown_signal",
  "always_review_document",
  "firm_score_high",
  "provisional_signals",
  "score_between",
  "score_low",
  "missing_checks",
  "review_only_check",
] as const;
export type RiskReason = (typeof RISK_REASONS)[number];

/**
 * Why the system may not approve a case on its own (automatic approval, PM 2026-10-20). Every one that
 * holds is listed, in this order; the case is approved automatically only when none does. A case that is
 * not approved automatically is never rejected automatically either: it waits for a person.
 * - auto_decide_off: automatic approval is switched off in the active version (autoDecide);
 * - real_session: not a test session (the face match runs on test sessions only, licence);
 * - not_recommended: the rules do not recommend approval (a hard flag, an unknown signal, a document
 *   always reviewed, a check missing or review-only, a score above the approve cut-off...);
 * - document_not_firm: the document check is not firm (RiskFacts.documentFirm), e.g. a document
 *   without code lines, or code lines with a wrong check digit;
 * - document_expired, under_18, mrz_print_mismatch: present, whatever their weight;
 * - hard_flag: a hard flag of the version is present;
 * - firm_signal: any firm signal is present, whatever its weight (even switched off);
 * - unknown_signal: a signal the rules do not know;
 * - quality_not_ok: the server's photo check is missing or did not find every photo ok;
 * - liveness_not_passed, face_match_not_passed: missing, or ran and did not pass;
 * - face_match_not_counted: the version does not let the uncalibrated face match count;
 * - score_above_cutoff: the score is above the approve cut-off.
 */
export const AUTO_APPROVAL_BLOCKERS = [
  "auto_decide_off",
  "real_session",
  "not_recommended",
  "document_not_firm",
  "document_expired",
  "under_18",
  "mrz_print_mismatch",
  "hard_flag",
  "firm_signal",
  "unknown_signal",
  "quality_not_ok",
  "liveness_not_passed",
  "face_match_not_passed",
  "face_match_not_counted",
  "score_above_cutoff",
] as const;
export type AutoApprovalBlocker = (typeof AUTO_APPROVAL_BLOCKERS)[number];

export interface AutoApproval {
  /** True only when no blocker holds: the system records an approval (actor system). */
  eligible: boolean;
  blockers: AutoApprovalBlocker[];
}

/** The rider-facing reason code (reason_code table) of a reject, from its first firm signal. */
export const SIGNAL_REJECT_CODES: Partial<Record<RiskSignal, string>> = {
  document_expired: "DOC_EXPIRED",
  image_reused: "DOC_NOT_ORIGINAL",
  unsupported_document: "DOC_UNSUPPORTED",
  mrz_disagreement: "DOC_INVALID",
  mrz_invalid_server: "DOC_INVALID",
  mrz_print_mismatch: "DOC_INVALID",
  type_mismatch: "DOC_INVALID",
  date_logic: "DOC_INVALID",
  number_format: "DOC_INVALID",
};
export const FALLBACK_REJECT_CODE = "OTHER";

// ---------------------------------------------------------------------------
// Threshold configuration (threshold_config.config, schema 2)
// ---------------------------------------------------------------------------
export const THRESHOLD_CONFIG_SCHEMA = 2;
/** Weights and cut-offs are numbers from 0 to 1 with at most 4 decimals (risk_score is numeric(5,4)). */
export const SCORE_DECIMALS = 4;
const SCALE = 10 ** SCORE_DECIMALS;

export interface SignalSetting {
  /** Added to the score when the signal is present and enabled. */
  weight: number;
  /** Off: the signal adds nothing to the score (a hard flag still sends the case to a person). */
  enabled: boolean;
}

export interface ThresholdConfig {
  schema: typeof THRESHOLD_CONFIG_SCHEMA;
  /** Every required signal; an optional one (OPTIONAL_SIGNALS) may be missing (signalSetting gives its default). */
  signals: Record<RequiredSignal, SignalSetting> & Partial<Record<OptionalSignal, SignalSetting>>;
  /** A score at or under this is low enough to approve. */
  approveMax: number;
  /** Firm signals adding up to this or more recommend a reject. Strictly above approveMax. */
  rejectMin: number;
  /** Present → review, whatever the score. Always holds MANDATORY_HARD_FLAGS. */
  hardFlags: RiskSignal[];
  /** Declared documents always decided by a person. Always holds MANDATORY_REVIEW_DOCUMENTS. */
  alwaysReviewDocuments: DeclaredDocument[];
  /**
   * Automatic approval (PM, 2026-10-20). Off by default. Never a reject: the system only ever approves,
   * and only a test session whose every condition holds (AUTO_APPROVAL_BLOCKERS); anything else waits
   * for a person.
   */
  autoDecide: boolean;
  /**
   * The face match (uncalibrated) may help approve a case: its pass no longer makes the case review-only.
   * Optional in a stored version (missing means false: versions made before 2026-10-20 lack it);
   * normaliseThresholdConfig always writes it.
   */
  faceMatchCountsForApproval?: boolean;
}

export const THRESHOLD_CONFIG_KEYS = [
  "schema",
  "signals",
  "approveMax",
  "rejectMin",
  "hardFlags",
  "alwaysReviewDocuments",
  "autoDecide",
] as const satisfies readonly (keyof ThresholdConfig)[];

/** Keys a configuration may leave out (versions stored before they existed); each has a default. */
export const THRESHOLD_CONFIG_OPTIONAL_KEYS = ["faceMatchCountsForApproval"] as const satisfies readonly (keyof ThresholdConfig)[];

/** Version 2, the first M8 version (the migration seeds exactly this). */
export const DEFAULT_THRESHOLD_CONFIG: ThresholdConfig = {
  schema: 2,
  signals: {
    document_expired: { weight: 1, enabled: true },
    under_18: { weight: 1, enabled: true },
    image_reused: { weight: 0.6, enabled: true },
    unsupported_document: { weight: 0.5, enabled: true },
    mrz_disagreement: { weight: 0.5, enabled: true },
    mrz_invalid_server: { weight: 0.5, enabled: true },
    mrz_print_mismatch: { weight: 0.5, enabled: true },
    type_mismatch: { weight: 0.3, enabled: true },
    date_logic: { weight: 0.4, enabled: true },
    number_format: { weight: 0.2, enabled: true },
    manual_review_document: { weight: 0, enabled: true },
    unrecognised_document: { weight: 0.3, enabled: true },
    mrz_unreadable_server: { weight: 0.2, enabled: true },
    mrz_phone_flag: { weight: 0.1, enabled: true },
    phone_report_missing: { weight: 0.1, enabled: true },
    provisional_classification: { weight: 0.1, enabled: true },
    quality_poor: { weight: 0.1, enabled: true },
    liveness_flag: { weight: 0.5, enabled: true },
    face_match_flag: { weight: 0.5, enabled: true },
  },
  approveMax: 0.15,
  rejectMin: 0.9,
  hardFlags: ["document_expired", "under_18", "image_reused", "unsupported_document", "manual_review_document"],
  alwaysReviewDocuments: ["cni_legacy", "residence_permit", "driving_licence", "voter_card"],
  autoDecide: false,
};

/**
 * The version the automatic-approval migration (20261021000000_auto_approval.sql) adds on top of the
 * active one, from version 2's settings: automatic approval on, and the face match counted (PM
 * decision 2026-10-20). An admin switches either off by saving a new version.
 */
export const AUTO_APPROVAL_CONFIG: ThresholdConfig = {
  ...DEFAULT_THRESHOLD_CONFIG,
  autoDecide: true,
  faceMatchCountsForApproval: true,
};

/**
 * The version the migration 20261022000000_real_test_fixes.sql adds on top of the active one ("Fixes
 * after the PM's first real test"): the automatic-approval version with the new provisional signal
 * print_name_mismatch written out (weight 0: a note for staff that never blocks an automatic approval).
 */
export const REAL_TEST_FIXES_CONFIG: ThresholdConfig = {
  ...AUTO_APPROVAL_CONFIG,
  signals: { ...AUTO_APPROVAL_CONFIG.signals, print_name_mismatch: { weight: 0, enabled: true } },
};

/** The setting of `code` in `config`: its own, or the default of an optional signal the version leaves out. */
export function signalSetting(config: ThresholdConfig, code: RiskSignal): SignalSetting {
  const own = (config.signals as Partial<Record<RiskSignal, SignalSetting>>)[code];
  if (own) return own;
  if (isOptionalSignal(code)) return OPTIONAL_SIGNAL_DEFAULTS[code];
  throw new Error(`threshold configuration without ${code}`);
}

/** "path:code", e.g. "signals.date_logic.weight:out_of_range". Sorted, each once. */
export type ConfigError = string;

export const CONFIG_ERROR_CODES = [
  "not_object",
  "unknown_key",
  "missing_key",
  "schema",
  "not_number",
  "out_of_range",
  "too_precise",
  "not_boolean",
  "not_array",
  "unknown_value",
  "duplicate",
  "mandatory",
  "order",
] as const;
export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Basis points (1/10000) of a valid weight or cut-off; exact for every value with 4 decimals. */
export function toUnits(value: number): number {
  return Math.round(value * SCALE);
}

function checkScore(value: unknown, path: string, errors: Set<string>): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.add(`${path}:not_number`);
    return;
  }
  if (value < 0 || value > 1) errors.add(`${path}:out_of_range`);
  // Within 1e-9 of a whole number of basis points: any 4-decimal number qualifies despite binary floating
  // point, anything finer does not (the database checks the exact decimal).
  else if (Math.abs(value * SCALE - Math.round(value * SCALE)) > 1e-9) errors.add(`${path}:too_precise`);
}

function checkExactKeys(
  value: Json,
  keys: readonly string[],
  path: string,
  errors: Set<string>,
  optional: readonly string[] = [],
): void {
  const prefix = path ? `${path}.` : "";
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && !optional.includes(key)) errors.add(`${prefix}${key}:unknown_key`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) errors.add(`${prefix}${key}:missing_key`);
}

function checkList<T extends string>(
  value: unknown,
  path: string,
  known: readonly T[],
  mandatory: readonly T[],
  errors: Set<string>,
): void {
  if (!Array.isArray(value)) {
    errors.add(`${path}:not_array`);
    return;
  }
  const seen = new Set<unknown>();
  for (const item of value) {
    if (typeof item !== "string" || !(known as readonly string[]).includes(item)) errors.add(`${path}:unknown_value`);
    else if (seen.has(item)) errors.add(`${path}:duplicate`);
    seen.add(item);
  }
  if (mandatory.some((item) => !seen.has(item))) errors.add(`${path}:mandatory`);
}

/**
 * Every problem with a threshold configuration, as sorted "path:code" strings; empty when it is valid.
 * The database applies the same rules (private.risk_config_errors) before storing a version.
 */
export function thresholdConfigErrors(value: unknown): ConfigError[] {
  const errors = new Set<string>();
  if (!isObject(value)) return [":not_object"];
  checkExactKeys(value, THRESHOLD_CONFIG_KEYS, "", errors, THRESHOLD_CONFIG_OPTIONAL_KEYS);
  if (Object.hasOwn(value, "schema") && value.schema !== THRESHOLD_CONFIG_SCHEMA) errors.add("schema:schema");

  if (Object.hasOwn(value, "signals")) {
    const signals = value.signals;
    if (!isObject(signals)) errors.add("signals:not_object");
    else {
      checkExactKeys(signals, RISK_SIGNALS.filter((code) => !isOptionalSignal(code)), "signals", errors, OPTIONAL_SIGNALS);
      for (const code of RISK_SIGNALS) {
        const setting = signals[code];
        if (setting === undefined) continue;
        const path = `signals.${code}`;
        if (!isObject(setting)) {
          errors.add(`${path}:not_object`);
          continue;
        }
        checkExactKeys(setting, ["weight", "enabled"], path, errors);
        if (Object.hasOwn(setting, "weight")) checkScore(setting.weight, `${path}.weight`, errors);
        if (Object.hasOwn(setting, "enabled") && typeof setting.enabled !== "boolean") {
          errors.add(`${path}.enabled:not_boolean`);
        }
      }
    }
  }
  if (Object.hasOwn(value, "approveMax")) checkScore(value.approveMax, "approveMax", errors);
  if (Object.hasOwn(value, "rejectMin")) checkScore(value.rejectMin, "rejectMin", errors);
  if (typeof value.approveMax === "number" && typeof value.rejectMin === "number" && value.approveMax >= value.rejectMin) {
    errors.add("rejectMin:order");
  }
  if (Object.hasOwn(value, "hardFlags")) checkList(value.hardFlags, "hardFlags", RISK_SIGNALS, MANDATORY_HARD_FLAGS, errors);
  if (Object.hasOwn(value, "alwaysReviewDocuments")) {
    checkList(value.alwaysReviewDocuments, "alwaysReviewDocuments", DECLARED_DOCUMENTS, MANDATORY_REVIEW_DOCUMENTS, errors);
  }
  if (Object.hasOwn(value, "autoDecide") && typeof value.autoDecide !== "boolean") errors.add("autoDecide:not_boolean");
  if (Object.hasOwn(value, "faceMatchCountsForApproval") && typeof value.faceMatchCountsForApproval !== "boolean") {
    errors.add("faceMatchCountsForApproval:not_boolean");
  }
  return [...errors].sort();
}

export function isThresholdConfig(value: unknown): value is ThresholdConfig {
  return thresholdConfigErrors(value).length === 0;
}

/**
 * The same configuration with its lists in a canonical order (the order of RISK_SIGNALS and
 * DECLARED_DOCUMENTS), so that two versions compare equal when they mean the same.
 */
export function normaliseThresholdConfig(config: ThresholdConfig): ThresholdConfig {
  const signals = {} as Record<RiskSignal, SignalSetting>;
  for (const code of RISK_SIGNALS) {
    const setting = signalSetting(config, code);
    signals[code] = { weight: setting.weight, enabled: setting.enabled };
  }
  return {
    schema: THRESHOLD_CONFIG_SCHEMA,
    signals,
    approveMax: config.approveMax,
    rejectMin: config.rejectMin,
    hardFlags: RISK_SIGNALS.filter((code) => config.hardFlags.includes(code)),
    alwaysReviewDocuments: DECLARED_DOCUMENTS.filter((doc) => config.alwaysReviewDocuments.includes(doc)),
    autoDecide: config.autoDecide,
    faceMatchCountsForApproval: config.faceMatchCountsForApproval === true,
  };
}

/** Whether a configuration lets the (uncalibrated) face match help approve; missing means no. */
export function faceMatchCounts(config: ThresholdConfig): boolean {
  return config.faceMatchCountsForApproval === true;
}

/** One difference between two versions, for the dashboard and the audit log. */
export type ConfigChange =
  | { kind: "weight"; signal: RiskSignal; from: number; to: number }
  | { kind: "enabled"; signal: RiskSignal; from: boolean; to: boolean }
  | { kind: "hardFlag"; signal: RiskSignal; to: boolean }
  | { kind: "approveMax" | "rejectMin"; from: number; to: number }
  | { kind: "alwaysReview"; document: DeclaredDocument; to: boolean }
  | { kind: "autoDecide" | "faceMatchCountsForApproval"; from: boolean; to: boolean };

/** What changes from `from` to `to`, in a fixed order. */
export function diffThresholdConfig(from: ThresholdConfig, to: ThresholdConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  if (toUnits(from.approveMax) !== toUnits(to.approveMax)) {
    changes.push({ kind: "approveMax", from: from.approveMax, to: to.approveMax });
  }
  if (toUnits(from.rejectMin) !== toUnits(to.rejectMin)) changes.push({ kind: "rejectMin", from: from.rejectMin, to: to.rejectMin });
  if (from.autoDecide !== to.autoDecide) changes.push({ kind: "autoDecide", from: from.autoDecide, to: to.autoDecide });
  if (faceMatchCounts(from) !== faceMatchCounts(to)) {
    changes.push({ kind: "faceMatchCountsForApproval", from: faceMatchCounts(from), to: faceMatchCounts(to) });
  }
  for (const signal of RISK_SIGNALS) {
    const a = signalSetting(from, signal);
    const b = signalSetting(to, signal);
    if (toUnits(a.weight) !== toUnits(b.weight)) changes.push({ kind: "weight", signal, from: a.weight, to: b.weight });
    if (a.enabled !== b.enabled) changes.push({ kind: "enabled", signal, from: a.enabled, to: b.enabled });
    const hardA = from.hardFlags.includes(signal);
    const hardB = to.hardFlags.includes(signal);
    if (hardA !== hardB) changes.push({ kind: "hardFlag", signal, to: hardB });
  }
  for (const document of DECLARED_DOCUMENTS) {
    const a = from.alwaysReviewDocuments.includes(document);
    const b = to.alwaysReviewDocuments.includes(document);
    if (a !== b) changes.push({ kind: "alwaysReview", document, to: b });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------
/** What the database gathers from a case (private.risk_facts). */
export interface RiskFacts {
  declaredDocument: DeclaredDocument | null;
  /** Signals present, as codes (any code: one the rules do not know sends the case to a person). */
  signals: string[];
  /** Required checks that are missing. */
  missing: string[];
  /** M7: checks present whose result may never approve (REVIEW_ONLY_CHECKS). Missing means none. */
  reviewOnly?: string[];
  /**
   * Automatic approval: the document check is firm. The declared document has code lines the server
   * read with every check digit right (its mrz_server check passed on the newest photo of that side),
   * the code lines classified it as the declared document, and the dates were checked from them
   * (consistency basis "mrz"). Always false for a document without code lines. Missing means false.
   */
  documentFirm?: boolean;
  /** Automatic approval: a test session (verification.is_test). Missing means false. */
  testSession?: boolean;
}

export interface RiskContribution {
  signal: RiskSignal;
  /** The configured weight. */
  weight: number;
  /** Enabled: the weight was added to the score. */
  counted: boolean;
  firm: boolean;
  hard: boolean;
}

/** Stored on the verification (risk_reasons) and shown on the case page. Generic codes only. */
export interface RiskAssessment {
  recommendation: DecisionOutcome;
  /** Where the score alone falls between the cut-offs. */
  band: DecisionOutcome;
  /** Sum of the counted weights, capped at 1. */
  score: number;
  /** The same over the firm signals only. */
  firmScore: number;
  reasons: RiskReason[];
  /** Every known signal present, in RISK_SIGNALS order. */
  contributions: RiskContribution[];
  hardFlags: RiskSignal[];
  /** Required checks missing, in REQUIRED_CHECKS order (then any other, sorted). */
  missing: string[];
  /** Review-only checks present (M7), in REQUIRED_CHECKS order (then any other, sorted). */
  reviewOnly: string[];
  /**
   * Uncalibrated checks present that this version lets count anyway (faceMatchCountsForApproval):
   * listed so that staff always see that an uncalibrated score helped.
   */
  uncalibratedCounted: string[];
  /** Whether the system may approve this case on its own, and every reason it may not. */
  autoApproval: AutoApproval;
  unknownSignals: string[];
  /** With a reject recommendation: the rider-facing reason code it would use. */
  rejectReasonCode: string | null;
  approveMax: number;
  rejectMin: number;
}

function ordered(values: readonly string[], order: readonly string[]): string[] {
  const set = new Set(values);
  const known = order.filter((value) => set.has(value));
  const others = [...set].filter((value) => !order.includes(value)).sort();
  return [...known, ...others];
}

/**
 * The Phase 1 rules. Deterministic: the same facts and configuration always give the same result,
 * computed in whole basis points (no floating-point sums).
 *   score     = min(1, sum of the weights of the enabled signals present)
 *   firmScore = the same over the firm signals
 *   band      = approve when score <= approveMax, reject when score >= rejectMin, otherwise review
 *   recommendation:
 *     review   when a hard flag or an unknown signal is present, or the document is always reviewed;
 *     reject   when firmScore >= rejectMin;
 *     approve  when score <= approveMax, no required check is missing and no review-only check is present
 *              (the face match is not review-only when the version sets faceMatchCountsForApproval);
 *     review   otherwise.
 *   autoApproval: eligible when no AUTO_APPROVAL_BLOCKERS holds. Never a reject.
 */
export function evaluateRisk(facts: RiskFacts, config: ThresholdConfig): RiskAssessment {
  const present = new Set(facts.signals);
  const contributions: RiskContribution[] = RISK_SIGNALS.filter((code) => present.has(code)).map((signal) => ({
    signal,
    weight: signalSetting(config, signal).weight,
    counted: signalSetting(config, signal).enabled,
    firm: FIRM_SIGNALS.includes(signal),
    hard: config.hardFlags.includes(signal),
  }));
  const unknownSignals = [...present].filter((code) => !(RISK_SIGNALS as readonly string[]).includes(code)).sort();
  const missing = ordered(facts.missing, REQUIRED_CHECKS);
  const uncalibrated = ordered(facts.reviewOnly ?? [], REQUIRED_CHECKS);
  const counts = faceMatchCounts(config);
  const uncalibratedCounted = uncalibrated.filter((check) => counts && check === PLACEHOLDER_CHECK_NAMES.faceMatch);
  const reviewOnly = uncalibrated.filter((check) => !uncalibratedCounted.includes(check));
  const hardFlags = contributions.filter((c) => c.hard).map((c) => c.signal);

  const sum = (list: RiskContribution[]) => Math.min(SCALE, list.reduce((total, c) => total + (c.counted ? toUnits(c.weight) : 0), 0));
  const scoreUnits = sum(contributions);
  const firmUnits = sum(contributions.filter((c) => c.firm));
  const approveUnits = toUnits(config.approveMax);
  const rejectUnits = toUnits(config.rejectMin);
  const alwaysReview = facts.declaredDocument !== null && config.alwaysReviewDocuments.includes(facts.declaredDocument);

  const holds: Record<RiskReason, boolean> = {
    hard_flag: hardFlags.length > 0,
    unknown_signal: unknownSignals.length > 0,
    always_review_document: alwaysReview,
    firm_score_high: firmUnits >= rejectUnits,
    provisional_signals: scoreUnits >= rejectUnits && firmUnits < rejectUnits,
    score_between: scoreUnits > approveUnits && scoreUnits < rejectUnits,
    score_low: scoreUnits <= approveUnits,
    missing_checks: missing.length > 0,
    review_only_check: reviewOnly.length > 0,
  };
  const reasons = RISK_REASONS.filter((reason) => holds[reason]);

  let recommendation: DecisionOutcome = "review";
  if (holds.hard_flag || holds.unknown_signal || holds.always_review_document) recommendation = "review";
  else if (holds.firm_score_high) recommendation = "reject";
  else if (holds.score_low && !holds.missing_checks && !holds.review_only_check) recommendation = "approve";

  const band: DecisionOutcome = scoreUnits <= approveUnits ? "approve" : scoreUnits >= rejectUnits ? "reject" : "review";

  const blocked: Record<AutoApprovalBlocker, boolean> = {
    auto_decide_off: !config.autoDecide,
    real_session: facts.testSession !== true,
    not_recommended: recommendation !== "approve",
    document_not_firm: facts.documentFirm !== true,
    document_expired: present.has("document_expired"),
    under_18: present.has("under_18"),
    mrz_print_mismatch: present.has("mrz_print_mismatch"),
    hard_flag: hardFlags.length > 0,
    firm_signal: FIRM_SIGNALS.some((code) => present.has(code)),
    unknown_signal: unknownSignals.length > 0,
    quality_not_ok: present.has("quality_poor") || missing.includes("server_checks"),
    liveness_not_passed: present.has("liveness_flag") || missing.includes("liveness"),
    face_match_not_passed: present.has("face_match_flag") || missing.includes("face_match"),
    face_match_not_counted: !counts,
    score_above_cutoff: scoreUnits > approveUnits,
  };
  const blockers = AUTO_APPROVAL_BLOCKERS.filter((blocker) => blocked[blocker]);

  const firstFirm = contributions.find((c) => c.firm && c.counted && toUnits(c.weight) > 0);
  return {
    recommendation,
    band,
    score: scoreUnits / SCALE,
    firmScore: firmUnits / SCALE,
    reasons,
    contributions,
    hardFlags,
    missing,
    reviewOnly,
    uncalibratedCounted,
    autoApproval: { eligible: blockers.length === 0, blockers },
    unknownSignals,
    rejectReasonCode: recommendation === "reject"
      ? (firstFirm && SIGNAL_REJECT_CODES[firstFirm.signal]) ?? FALLBACK_REJECT_CODE
      : null,
    approveMax: config.approveMax,
    rejectMin: config.rejectMin,
  };
}

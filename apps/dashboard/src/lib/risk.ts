// M8: the risk assessment stored on each case, the decisions taken, the rider reasons and the threshold
// versions, read directly from Supabase (RLS decides which rows come back) and checked field by field.
import {
  DECISION_OUTCOMES,
  type DecisionOutcome,
  type DecisionRequest,
  isThresholdConfig,
  normaliseThresholdConfig,
  REQUIRED_CHECKS,
  RISK_REASONS,
  RISK_SIGNALS,
  type RiskAssessment,
  type RiskContribution,
  type ThresholdConfig,
} from "@verify/shared";

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** What the case page and the queue show of a case's assessment (verification columns, M8). */
export interface CaseRisk {
  score: number | null;
  recommendation: DecisionOutcome | null;
  /** Null when not assessed yet, or stored in a shape this dashboard does not know. */
  assessment: RiskAssessment | null;
  thresholdVersion: number | null;
  assessedAt: string | null;
  decidedAt: string | null;
}

export const RISK_COLUMNS = "risk_score, risk_recommendation, risk_reasons, threshold_config_version, risk_assessed_at, decided_at";

export function toCaseRisk(value: unknown): CaseRisk {
  const row = asRow(value) ?? {};
  return {
    score: num(row.risk_score),
    recommendation: isOneOf(DECISION_OUTCOMES, row.risk_recommendation) ? row.risk_recommendation : null,
    assessment: toRiskAssessment(row.risk_reasons),
    thresholdVersion: num(row.threshold_config_version),
    assessedAt: str(row.risk_assessed_at),
    decidedAt: str(row.decided_at),
  };
}

/**
 * The stored RiskAssessment (risk.ts), field by field: known codes only, in the rules' order. Unknown
 * signals and missing checks are kept as codes (shown as such). Null when a required field is wrong.
 */
export function toRiskAssessment(value: unknown): RiskAssessment | null {
  const d = asRow(value);
  if (!d) return null;
  const score = num(d.score);
  const firmScore = num(d.firmScore);
  const approveMax = num(d.approveMax);
  const rejectMin = num(d.rejectMin);
  if (
    !isOneOf(DECISION_OUTCOMES, d.recommendation) || !isOneOf(DECISION_OUTCOMES, d.band) || score === null ||
    firmScore === null || approveMax === null || rejectMin === null || !Array.isArray(d.contributions)
  ) {
    return null;
  }
  const contributions: RiskContribution[] = [];
  for (const item of d.contributions) {
    const c = asRow(item);
    const weight = num(c?.weight);
    const counted = bool(c?.counted);
    const firm = bool(c?.firm);
    const hard = bool(c?.hard);
    if (!c || !isOneOf(RISK_SIGNALS, c.signal) || weight === null || counted === null || firm === null || hard === null) continue;
    contributions.push({ signal: c.signal, weight, counted, firm, hard });
  }
  const reasons = strings(d.reasons);
  const hardFlags = strings(d.hardFlags);
  const missing = strings(d.missing);
  return {
    recommendation: d.recommendation,
    band: d.band,
    score,
    firmScore,
    reasons: RISK_REASONS.filter((reason) => reasons.includes(reason)),
    contributions: RISK_SIGNALS.flatMap((signal) => contributions.find((c) => c.signal === signal) ?? []),
    hardFlags: RISK_SIGNALS.filter((signal) => hardFlags.includes(signal)),
    missing: [...REQUIRED_CHECKS.filter((check) => missing.includes(check)), ...missing.filter((m) => !(REQUIRED_CHECKS as readonly string[]).includes(m))],
    unknownSignals: strings(d.unknownSignals),
    rejectReasonCode: str(d.rejectReasonCode),
    approveMax,
    rejectMin,
  };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------
export type QueueSort = "newest" | "recommendation";

/** Reject first (the strongest signals), then review, then approve, then cases without an assessment. */
const RECOMMENDATION_RANK: Record<DecisionOutcome | "none", number> = { reject: 0, review: 1, approve: 2, none: 3 };

/**
 * The list sorted for the queue. "recommendation": undecided cases first (submitted), by recommendation,
 * then the highest score, then the oldest submission. "newest": as the server sent it (newest first).
 */
export function sortQueue<T extends { id: string; status: string; createdAt: string; submittedAt: string | null; risk: CaseRisk | null }>(
  items: readonly T[],
  sort: QueueSort,
): T[] {
  if (sort === "newest") return [...items];
  const waiting = (v: T) => (v.status === "submitted" ? 0 : 1);
  const rank = (v: T) => RECOMMENDATION_RANK[v.risk?.recommendation ?? "none"];
  return [...items].sort((a, b) =>
    waiting(a) - waiting(b) ||
    rank(a) - rank(b) ||
    (b.risk?.score ?? -1) - (a.risk?.score ?? -1) ||
    (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

// ---------------------------------------------------------------------------
// Decisions and rider reasons
// ---------------------------------------------------------------------------
export interface DecisionRecord {
  id: string;
  actorType: "system" | "staff";
  actorId: string | null;
  outcome: DecisionOutcome;
  reasonCode: string | null;
  note: string | null;
  thresholdVersion: number | null;
  recommendation: DecisionOutcome | null;
  band: DecisionOutcome | null;
  riskScore: number | null;
  agreesWithRecommendation: boolean | null;
  createdAt: string;
}

export const DECISION_COLUMNS =
  "id, actor_type, actor_id, outcome, reason_code, note, threshold_config_version, recommendation, risk_band, risk_score, agrees_with_recommendation, created_at";

export function toDecision(value: unknown): DecisionRecord | null {
  const row = asRow(value);
  const id = str(row?.id);
  const createdAt = str(row?.created_at);
  if (!row || !id || !createdAt || (row.actor_type !== "system" && row.actor_type !== "staff") || !isOneOf(DECISION_OUTCOMES, row.outcome)) {
    return null;
  }
  return {
    id,
    actorType: row.actor_type,
    actorId: str(row.actor_id),
    outcome: row.outcome,
    reasonCode: str(row.reason_code),
    note: str(row.note),
    thresholdVersion: num(row.threshold_config_version),
    recommendation: isOneOf(DECISION_OUTCOMES, row.recommendation) ? row.recommendation : null,
    band: isOneOf(DECISION_OUTCOMES, row.risk_band) ? row.risk_band : null,
    riskScore: num(row.risk_score),
    agreesWithRecommendation: bool(row.agrees_with_recommendation),
    createdAt,
  };
}

/** A reason shown to the rider on a reject (reason_code table). */
export interface ReasonCodeRecord {
  code: string;
  riderFr: string;
  riderEn: string;
  active: boolean;
}

export const REASON_CODE_COLUMNS = "code, rider_fr, rider_en, active";

export function toReasonCode(value: unknown): ReasonCodeRecord | null {
  const row = asRow(value);
  const code = str(row?.code);
  if (!row || !code) return null;
  return { code, riderFr: str(row.rider_fr) ?? "", riderEn: str(row.rider_en) ?? "", active: row.active === true };
}

/**
 * Whether the database will ask for a note (staff_decide): against an approve or reject recommendation,
 * to approve a case with a hard flag, or when the case has no assessment.
 */
export function noteRequired(risk: CaseRisk | null, outcome: DecisionRequest["outcome"]): boolean {
  const recommendation = risk?.recommendation ?? null;
  if (recommendation === null) return true;
  if (recommendation !== "review" && recommendation !== outcome) return true;
  return outcome === "approve" && (risk?.assessment?.hardFlags.length ?? 0) > 0;
}

/** Whether a decision went with the recommendation; null when there was nothing to agree with. */
export function agreement(recommendation: DecisionOutcome | null, outcome: DecisionRequest["outcome"]): boolean | null {
  return recommendation === "approve" || recommendation === "reject" ? recommendation === outcome : null;
}

// ---------------------------------------------------------------------------
// Threshold versions
// ---------------------------------------------------------------------------
export interface ThresholdVersionRecord {
  version: number;
  /** Null for a version in an earlier format (version 1, before M8). */
  config: ThresholdConfig | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

export const THRESHOLD_COLUMNS = "version, config, note, created_by, created_at";

export function toThresholdVersion(value: unknown): ThresholdVersionRecord | null {
  const row = asRow(value);
  const version = num(row?.version);
  const createdAt = str(row?.created_at);
  if (!row || version === null || !createdAt) return null;
  return {
    version,
    config: isThresholdConfig(row.config) ? normaliseThresholdConfig(row.config) : null,
    note: str(row.note),
    createdBy: str(row.created_by),
    createdAt,
  };
}

/** The active version: the highest one (versions are never edited). */
export function activeVersion(versions: readonly ThresholdVersionRecord[]): ThresholdVersionRecord | null {
  return versions.reduce<ThresholdVersionRecord | null>((best, v) => (!best || v.version > best.version ? v : best), null);
}

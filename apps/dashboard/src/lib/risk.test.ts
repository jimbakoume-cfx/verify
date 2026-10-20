import { describe, expect, it } from "vitest";
import { AUTO_APPROVAL_CONFIG, DEFAULT_THRESHOLD_CONFIG, evaluateRisk, type RiskFacts } from "@verify/shared";
import {
  activeVersion,
  agreement,
  type CaseRisk,
  filterQueue,
  noteRequired,
  sortQueue,
  toCaseRisk,
  toDecision,
  toReasonCode,
  toRiskAssessment,
  toThresholdVersion,
} from "./risk";

const assess = (facts: Partial<RiskFacts>, config = DEFAULT_THRESHOLD_CONFIG) =>
  evaluateRisk({ declaredDocument: "passport", signals: [], missing: [], ...facts }, config);

describe("toRiskAssessment", () => {
  it("reads back what the rules store", () => {
    const stored = assess({ signals: ["document_expired", "mrz_print_mismatch"], missing: ["liveness", "face_match"] });
    // As PostgREST returns it: JSON.
    expect(toRiskAssessment(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("reads back an automatic approval and the uncalibrated face match it counted", () => {
    const stored = assess({ reviewOnly: ["face_match"], documentFirm: true, testSession: true }, AUTO_APPROVAL_CONFIG);
    expect(stored.autoApproval.eligible).toBe(true);
    expect(toRiskAssessment(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    const blocked = assess({ signals: ["quality_poor"], reviewOnly: ["face_match"], documentFirm: false }, AUTO_APPROVAL_CONFIG);
    expect(toRiskAssessment(JSON.parse(JSON.stringify(blocked)))?.autoApproval).toEqual({
      eligible: false,
      blockers: ["real_session", "document_not_firm", "quality_not_ok"],
    });
  });

  it("reads an assessment stored before automatic approval as not eligible, nothing listed", () => {
    const { autoApproval: _a, uncalibratedCounted: _u, ...old } = assess({});
    const read = toRiskAssessment(old)!;
    expect(read.autoApproval).toEqual({ eligible: false, blockers: [] });
    expect(read.uncalibratedCounted).toEqual([]);
    expect(toRiskAssessment({ ...assess({}), autoApproval: { eligible: "yes", blockers: ["made_up", "real_session"] } })?.autoApproval)
      .toEqual({ eligible: false, blockers: ["real_session"] });
  });

  it("keeps known codes in the rules' order, and unknown missing checks and signals as codes", () => {
    const stored = {
      ...assess({ signals: ["quality_poor", "date_logic"] }),
      reasons: ["missing_checks", "weird", "score_between"],
      hardFlags: ["under_18", "made_up", "document_expired"],
      missing: ["new_check", "face_match", "server_checks"],
      unknownSignals: ["m11_signal"],
    };
    const read = toRiskAssessment(stored)!;
    expect(read.reasons).toEqual(["score_between", "missing_checks"]);
    expect(read.hardFlags).toEqual(["document_expired", "under_18"]);
    expect(read.missing).toEqual(["server_checks", "face_match", "new_check"]);
    expect(read.contributions.map((c) => c.signal)).toEqual(["date_logic", "quality_poor"]);
    expect(read.unknownSignals).toEqual(["m11_signal"]);
  });

  it("drops a malformed contribution, and refuses an assessment without its required fields", () => {
    const stored = assess({ signals: ["date_logic"] });
    expect(toRiskAssessment({ ...stored, contributions: [{ signal: "date_logic", weight: "0.4" }] })?.contributions).toEqual([]);
    for (const bad of [null, [], "x", { ...stored, recommendation: "maybe" }, { ...stored, score: "0.4" }, { ...stored, contributions: null }]) {
      expect(toRiskAssessment(bad)).toBeNull();
    }
  });
});

describe("toCaseRisk", () => {
  it("maps the verification's M8 columns", () => {
    const assessment = assess({ signals: ["mrz_print_mismatch"] });
    expect(toCaseRisk({
      risk_score: 0.5,
      risk_recommendation: "review",
      risk_reasons: assessment,
      threshold_config_version: 3,
      risk_assessed_at: "2026-10-19T10:00:00+00:00",
      decided_at: null,
      auto_approved_at: null,
    })).toEqual({
      score: 0.5,
      recommendation: "review",
      assessment,
      thresholdVersion: 3,
      assessedAt: "2026-10-19T10:00:00+00:00",
      decidedAt: null,
      autoApprovedAt: null,
    });
  });

  it("reads a case not assessed yet as nulls", () => {
    expect(toCaseRisk({})).toEqual({
      score: null,
      recommendation: null,
      assessment: null,
      thresholdVersion: null,
      assessedAt: null,
      decidedAt: null,
      autoApprovedAt: null,
    });
    expect(toCaseRisk({ auto_approved_at: "2026-10-21T08:00:00+00:00" }).autoApprovedAt).toBe("2026-10-21T08:00:00+00:00");
    expect(toCaseRisk({ risk_recommendation: "yes" }).recommendation).toBeNull();
  });
});

describe("sortQueue", () => {
  const risk = (recommendation: CaseRisk["recommendation"], score: number | null): CaseRisk => ({
    score,
    recommendation,
    assessment: null,
    thresholdVersion: 2,
    assessedAt: null,
    decidedAt: null,
    autoApprovedAt: null,
  });
  const item = (id: string, status: string, r: CaseRisk | null, submittedAt: string | null = "2026-10-19T09:00:00Z") => ({
    id,
    status,
    createdAt: "2026-10-19T08:00:00Z",
    submittedAt,
    risk: r,
  });
  const items = [
    item("approved", "approved", risk("approve", 0)),
    item("approve", "submitted", risk("approve", 0.1)),
    item("review-low", "submitted", risk("review", 0.2)),
    item("open", "in_progress", null, null),
    item("reject", "submitted", risk("reject", 1)),
    item("review-high", "submitted", risk("review", 0.6)),
    item("unassessed", "submitted", risk(null, null)),
  ];

  it("keeps the server's order for newest first", () => {
    expect(sortQueue(items, "newest").map((v) => v.id)).toEqual(items.map((v) => v.id));
  });

  it("puts the cases waiting for a decision first: reject, review (highest score first), approve, not assessed", () => {
    expect(sortQueue(items, "recommendation").map((v) => v.id)).toEqual([
      "reject",
      "review-high",
      "review-low",
      "approve",
      "unassessed",
      "approved",
      "open",
    ]);
  });

  it("orders equal cases by the oldest submission first", () => {
    const a = item("a", "submitted", risk("review", 0.5), "2026-10-19T09:30:00Z");
    const b = item("b", "submitted", risk("review", 0.5), "2026-10-19T09:00:00Z");
    expect(sortQueue([a, b], "recommendation").map((v) => v.id)).toEqual(["b", "a"]);
  });

  it("filters the cases approved automatically", () => {
    const auto = item("auto", "approved", { ...risk("approve", 0), autoApprovedAt: "2026-10-21T08:00:00Z" });
    expect(filterQueue([...items, auto], "autoApproved").map((v) => v.id)).toEqual(["auto"]);
    expect(filterQueue([...items, auto], "all")).toHaveLength(items.length + 1);
  });
});

describe("decisions", () => {
  const row = {
    id: "d1",
    actor_type: "staff",
    actor_id: "u1",
    outcome: "approve",
    reason_code: null,
    note: "Checked.",
    threshold_config_version: 3,
    recommendation: "reject",
    risk_band: "reject",
    risk_score: 0.9,
    agrees_with_recommendation: false,
    created_at: "2026-10-19T10:00:00+00:00",
  };

  it("maps a decision row", () => {
    expect(toDecision(row)).toEqual({
      id: "d1",
      actorType: "staff",
      actorId: "u1",
      outcome: "approve",
      reasonCode: null,
      note: "Checked.",
      thresholdVersion: 3,
      recommendation: "reject",
      band: "reject",
      riskScore: 0.9,
      agreesWithRecommendation: false,
      createdAt: row.created_at,
    });
    expect(toDecision({ ...row, actor_type: "api_client" })).toBeNull();
    expect(toDecision({ ...row, outcome: "maybe" })).toBeNull();
    expect(toDecision({ ...row, recommendation: null, agrees_with_recommendation: null })).toMatchObject({
      recommendation: null,
      agreesWithRecommendation: null,
    });
  });

  it("maps a rider reason", () => {
    expect(toReasonCode({ code: "DOC_INVALID", rider_fr: "fr", rider_en: "en", active: true })).toEqual({
      code: "DOC_INVALID",
      riderFr: "fr",
      riderEn: "en",
      active: true,
    });
    expect(toReasonCode({ rider_fr: "fr" })).toBeNull();
  });

  it("asks for a note as the database does", () => {
    const withRisk = (facts: Partial<RiskFacts>): CaseRisk => {
      const assessment = assess(facts);
      return {
        score: assessment.score,
        recommendation: assessment.recommendation,
        assessment,
        thresholdVersion: 2,
        assessedAt: null,
        decidedAt: null,
        autoApprovedAt: null,
      };
    };
    const reject = withRisk({ signals: ["mrz_invalid_server", "mrz_print_mismatch"] });
    expect(noteRequired(reject, "approve")).toBe(true);
    expect(noteRequired(reject, "reject")).toBe(false);
    const hard = withRisk({ signals: ["document_expired"] });
    expect(noteRequired(hard, "approve")).toBe(true);
    expect(noteRequired(hard, "reject")).toBe(false);
    const review = withRisk({ signals: [], missing: ["liveness"] });
    expect(noteRequired(review, "approve")).toBe(false);
    expect(noteRequired(null, "reject")).toBe(true);
  });

  it("says whether a decision agrees, and nothing for a review recommendation", () => {
    expect(agreement("reject", "reject")).toBe(true);
    expect(agreement("approve", "reject")).toBe(false);
    expect(agreement("review", "approve")).toBeNull();
    expect(agreement(null, "approve")).toBeNull();
  });
});

describe("threshold versions", () => {
  it("reads a version of the M8 format, its lists in canonical order", () => {
    const config = { ...DEFAULT_THRESHOLD_CONFIG, hardFlags: [...DEFAULT_THRESHOLD_CONFIG.hardFlags].reverse() };
    expect(toThresholdVersion({ version: 2, config, note: "M8", created_by: null, created_at: "2026-10-19T00:00:00Z" })).toEqual({
      version: 2,
      config: { ...DEFAULT_THRESHOLD_CONFIG, faceMatchCountsForApproval: false },
      note: "M8",
      createdBy: null,
      createdByMigration: null,
      createdAt: "2026-10-19T00:00:00Z",
    });
    expect(toThresholdVersion({
      version: 3,
      config: { ...DEFAULT_THRESHOLD_CONFIG, autoDecide: true, faceMatchCountsForApproval: true },
      note: "PM decision 2026-10-20: automatic approval",
      created_by: null,
      created_by_migration: "20261021000000_auto_approval",
      created_at: "2026-10-21T00:00:00Z",
    })).toMatchObject({ createdByMigration: "20261021000000_auto_approval", config: { autoDecide: true, faceMatchCountsForApproval: true } });
  });

  it("reads an earlier format (version 1) without its configuration", () => {
    expect(toThresholdVersion({ version: 1, config: { phase: "assisted" }, note: "M0", created_at: "2026-10-13T00:00:00Z" })?.config).toBeNull();
    expect(toThresholdVersion({ config: {} })).toBeNull();
  });

  it("finds the active version: the highest", () => {
    const v = (version: number) => ({ version, config: null, note: null, createdBy: null, createdByMigration: null, createdAt: "" });
    expect(activeVersion([v(2), v(4), v(3)])?.version).toBe(4);
    expect(activeVersion([])).toBeNull();
  });
});

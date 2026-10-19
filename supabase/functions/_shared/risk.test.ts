import { describe, expect, it } from "vitest";
import vectors from "../../tests/risk_vectors.json" with { type: "json" };
import { DECLARED_DOCUMENTS, POLICY_REASONS } from "./contract.ts";
import {
  DEFAULT_THRESHOLD_CONFIG,
  diffThresholdConfig,
  evaluateRisk,
  FIRM_SIGNALS,
  isThresholdConfig,
  MANDATORY_HARD_FLAGS,
  MANDATORY_REVIEW_DOCUMENTS,
  normaliseThresholdConfig,
  RISK_SIGNALS,
  type RiskFacts,
  SIGNAL_REJECT_CODES,
  type ThresholdConfig,
  thresholdConfigErrors,
} from "./risk.ts";

const clone = (config: ThresholdConfig): ThresholdConfig => structuredClone(config);
const facts = (signals: string[], missing: string[] = [], declaredDocument: RiskFacts["declaredDocument"] = "passport") => ({
  declaredDocument,
  signals,
  missing,
});

describe("the shared vectors (also run by the database: supabase/tests/70_m8_test.sql)", () => {
  it("list the signals and the default configuration of this code", () => {
    expect(vectors.signals).toEqual([...RISK_SIGNALS]);
    expect(vectors.defaultConfig).toEqual(DEFAULT_THRESHOLD_CONFIG);
  });

  it.each(vectors.assessments.map((v) => [v.name, v] as const))("assessment: %s", (_name, vector) => {
    expect(evaluateRisk(vector.facts as RiskFacts, vector.config as ThresholdConfig)).toEqual(vector.expected);
  });

  it.each(vectors.configErrors.map((v) => [v.name, v] as const))("configuration errors: %s", (_name, vector) => {
    expect(thresholdConfigErrors(vector.config)).toEqual(vector.expected);
  });
});

describe("the default configuration", () => {
  it("is valid, with every signal, and auto decisions off", () => {
    expect(thresholdConfigErrors(DEFAULT_THRESHOLD_CONFIG)).toEqual([]);
    expect(Object.keys(DEFAULT_THRESHOLD_CONFIG.signals)).toEqual([...RISK_SIGNALS]);
    expect(DEFAULT_THRESHOLD_CONFIG.autoDecide).toBe(false);
  });

  it("keeps the PM's hard flags and always-reviewed documents", () => {
    for (const flag of MANDATORY_HARD_FLAGS) expect(DEFAULT_THRESHOLD_CONFIG.hardFlags).toContain(flag);
    expect([...MANDATORY_REVIEW_DOCUMENTS].sort()).toEqual([...DEFAULT_THRESHOLD_CONFIG.alwaysReviewDocuments].sort());
  });
});

describe("signals", () => {
  it("cover every document_policy reason except server_unchecked (a missing check instead)", () => {
    for (const reason of POLICY_REASONS) {
      if (reason === "server_unchecked") expect(RISK_SIGNALS).not.toContain(reason);
      else expect(RISK_SIGNALS).toContain(reason);
    }
  });

  it("give every firm signal a rider reason for a reject, and only firm ones", () => {
    expect(Object.keys(SIGNAL_REJECT_CODES).sort()).toEqual([...FIRM_SIGNALS].sort());
  });

  it("never count under_18, printed or keyword evidence, or uncalibrated scores as firm", () => {
    for (const code of ["under_18", "provisional_classification", "quality_poor", "liveness_flag", "face_match_flag"] as const) {
      expect(FIRM_SIGNALS).not.toContain(code);
    }
  });
});

describe("evaluateRisk", () => {
  it("is deterministic and ignores the order and repetition of its inputs", () => {
    const a = evaluateRisk(facts(["mrz_print_mismatch", "quality_poor", "quality_poor"], ["liveness", "face_match"]), DEFAULT_THRESHOLD_CONFIG);
    const b = evaluateRisk(facts(["quality_poor", "mrz_print_mismatch"], ["face_match", "liveness", "liveness"]), DEFAULT_THRESHOLD_CONFIG);
    expect(a).toEqual(b);
    expect(a.score).toBe(0.6);
  });

  it("never recommends approval while liveness or face match is missing, whatever the thresholds", () => {
    const generous = clone(DEFAULT_THRESHOLD_CONFIG);
    generous.approveMax = 0.99;
    generous.rejectMin = 1;
    for (const missing of [["liveness"], ["face_match"], ["server_checks"]]) {
      const result = evaluateRisk(facts([], missing), generous);
      expect(result.recommendation).toBe("review");
      expect(result.band).toBe("approve");
    }
  });

  it("never recommends a reject from provisional signals, however heavy", () => {
    const heavy = clone(DEFAULT_THRESHOLD_CONFIG);
    for (const code of RISK_SIGNALS) heavy.signals[code].weight = 1;
    heavy.hardFlags = [...MANDATORY_HARD_FLAGS];
    heavy.rejectMin = 0.01;
    heavy.approveMax = 0;
    const provisional = RISK_SIGNALS.filter((code) => !FIRM_SIGNALS.includes(code) && !MANDATORY_HARD_FLAGS.includes(code));
    const result = evaluateRisk(facts(provisional), heavy);
    expect(result.recommendation).toBe("review");
    expect(result.reasons).toContain("provisional_signals");
  });

  it("changes with a threshold: the PM's test", () => {
    const mismatch = facts(["mrz_print_mismatch"], ["liveness", "face_match"]);
    expect(evaluateRisk(mismatch, DEFAULT_THRESHOLD_CONFIG).recommendation).toBe("review");
    const lower = clone(DEFAULT_THRESHOLD_CONFIG);
    lower.rejectMin = 0.5;
    expect(evaluateRisk(mismatch, lower).recommendation).toBe("reject");
  });
});

describe("normaliseThresholdConfig and diffThresholdConfig", () => {
  it("put the lists in a canonical order", () => {
    const shuffled = clone(DEFAULT_THRESHOLD_CONFIG);
    shuffled.hardFlags.reverse();
    shuffled.alwaysReviewDocuments.reverse();
    expect(normaliseThresholdConfig(shuffled)).toEqual(DEFAULT_THRESHOLD_CONFIG);
    expect(diffThresholdConfig(DEFAULT_THRESHOLD_CONFIG, shuffled)).toEqual([]);
  });

  it("list every change in a fixed order", () => {
    const next = clone(DEFAULT_THRESHOLD_CONFIG);
    next.rejectMin = 0.5;
    next.autoDecide = true;
    next.signals.date_logic = { weight: 0.25, enabled: false };
    next.hardFlags = next.hardFlags.filter((code) => code !== "image_reused");
    next.alwaysReviewDocuments.push("passport");
    expect(diffThresholdConfig(DEFAULT_THRESHOLD_CONFIG, next)).toEqual([
      { kind: "rejectMin", from: 0.9, to: 0.5 },
      { kind: "autoDecide", from: false, to: true },
      { kind: "hardFlag", signal: "image_reused", to: false },
      { kind: "weight", signal: "date_logic", from: 0.4, to: 0.25 },
      { kind: "enabled", signal: "date_logic", from: true, to: false },
      { kind: "alwaysReview", document: "passport", to: true },
    ]);
  });

  it("accepts every declared document in the always-reviewed list", () => {
    const all = clone(DEFAULT_THRESHOLD_CONFIG);
    all.alwaysReviewDocuments = [...DECLARED_DOCUMENTS];
    expect(isThresholdConfig(all)).toBe(true);
  });
});

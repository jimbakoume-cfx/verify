// The "Risk and decision" section (M8) and the thresholds page, rendered to HTML on the server side
// (react-dom/server): the recommendation, the score breakdown, the decision form and record, and the
// threshold editor, history and changes, in both languages. Generic codes and labels only.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLD_CONFIG, diffThresholdConfig, evaluateRisk, type RiskFacts, type ThresholdConfig } from "@verify/shared";
import en from "../locales/en.json";
import fr from "../locales/fr.json";
import type { StaffProfile } from "../lib/records";
import type { CaseRisk, DecisionRecord, ThresholdVersionRecord } from "../lib/risk";
import { formFromConfig } from "../lib/thresholdForm";
import { DecisionForm, DecisionView, RecommendationBadge, RiskSummary } from "./CaseRisk";
import { ChangesList, HistoryList, ThresholdEditor } from "./Thresholds";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: "en",
  fallbackLng: "fr",
  interpolation: { escapeValue: false },
});

function render(element: ReactElement, lng: "en" | "fr" = "en"): string {
  void i18n.changeLanguage(lng);
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));
}

const SUPERVISOR: StaffProfile = { userId: "u-sup", role: "supervisor", fullName: "Sup", active: true };
const noop = async () => {};

function risk(facts: Partial<RiskFacts>, config: ThresholdConfig = DEFAULT_THRESHOLD_CONFIG): CaseRisk {
  const assessment = evaluateRisk({ declaredDocument: "passport", signals: [], missing: [], ...facts }, config);
  return {
    score: assessment.score,
    recommendation: assessment.recommendation,
    assessment,
    thresholdVersion: 3,
    assessedAt: "2026-10-19T10:00:00Z",
    decidedAt: null,
  };
}

describe("RiskSummary", () => {
  it("explains a review while liveness and face match are missing, with the score in the approve band", () => {
    const html = render(createElement(RiskSummary, { risk: risk({ missing: ["liveness", "face_match"] }), status: "submitted" }));
    expect(html).toContain("Version 3");
    expect(html).toContain("Low score");
    expect(html).toContain("Checks missing");
    expect(html).toContain("Liveness check (from M6)");
    expect(html).toContain("Face match (from M7)");
    expect(html).toContain("No signal: nothing adds to the score.");
    expect(html).toContain("Approve up to 0.15");
  });

  it("lists every signal with its weight, firm or provisional, and the hard flags in red", () => {
    const html = render(createElement(RiskSummary, {
      risk: risk({ signals: ["document_expired", "mrz_print_mismatch", "quality_poor"] }),
      status: "submitted",
    }));
    expect(html).toContain("Document expired");
    expect(html).toMatch(/<tr class="hard"><th scope="row">Document expired <code class="mono muted">document_expired<\/code>/);
    expect(html).toContain("+0.5");
    expect(html).toContain("Hard flag");
    expect(html.match(/>Firm</g)).toHaveLength(2);
    expect(html.match(/>Provisional</g)).toHaveLength(1);
    expect(html).toContain("A hard flag is present: a person decides, whatever the score.");
  });

  it("shows a reject recommendation with the rider reason it would use, and a switched-off signal", () => {
    const config = { ...DEFAULT_THRESHOLD_CONFIG, rejectMin: 0.5, signals: { ...DEFAULT_THRESHOLD_CONFIG.signals, quality_poor: { weight: 0.1, enabled: false } } };
    const html = render(createElement(RiskSummary, { risk: risk({ signals: ["mrz_invalid_server", "quality_poor"] }, config), status: "submitted" }));
    expect(html).toContain("Firm signals reach the reject cut-off");
    expect(html).toContain("The firm signals alone add up to 0.5 or more");
    expect(html).toContain("Rider reason if rejected: DOC_INVALID");
    expect(html).toContain("Switched off");
  });

  it("says when a case is not assessed yet, or not yet submitted", () => {
    const none: CaseRisk = { score: null, recommendation: null, assessment: null, thresholdVersion: null, assessedAt: null, decidedAt: null };
    expect(render(createElement(RiskSummary, { risk: none, status: "in_progress" }))).toContain("Assessed when the rider submits.");
    expect(render(createElement(RiskSummary, { risk: none, status: "submitted" }))).toContain("Not assessed yet.");
  });

  it("speaks French too", () => {
    const html = render(createElement(RiskSummary, { risk: risk({ signals: ["under_18"] }), status: "submitted" }), "fr");
    expect(html).toContain("Moins de 18 ans");
    expect(html).toContain("Signal bloquant");
    expect(html).toContain("Version des seuils");
  });
});

describe("RecommendationBadge", () => {
  it("colours approve, review and reject", () => {
    expect(render(createElement(RecommendationBadge, { outcome: "approve" }))).toBe('<span class="badge ok">Recommend: approve</span>');
    expect(render(createElement(RecommendationBadge, { outcome: "review" }))).toBe('<span class="badge warn">Recommend: review</span>');
    expect(render(createElement(RecommendationBadge, { outcome: "reject" }))).toBe('<span class="badge bad">Recommend: reject</span>');
    expect(render(createElement(RecommendationBadge, { outcome: null }))).toContain("Not assessed");
    expect(render(createElement(RecommendationBadge, { outcome: "reject", kind: "decision" }))).toContain("Rejected");
  });
});

describe("DecisionView", () => {
  const decision: DecisionRecord = {
    id: "d",
    actorType: "staff",
    actorId: "u-sup",
    outcome: "approve",
    reasonCode: null,
    note: "OCR misread the name.",
    thresholdVersion: 3,
    recommendation: "reject",
    band: "reject",
    riskScore: 0.9,
    agreesWithRecommendation: false,
    createdAt: "2026-10-19T10:05:00Z",
  };

  it("shows who decided, against which recommendation and version, and the note", () => {
    const html = render(createElement(DecisionView, { decision, profile: SUPERVISOR, reasonCodes: [] }));
    expect(html).toContain(">You<");
    expect(html).toContain("Recommend: reject");
    expect(html).toContain("Version 3");
    expect(html).toContain("Went against the recommendation.");
    expect(html).toContain("OCR misread the name.");
  });

  it("shows an automatic reject with its rider reason in the page's language", () => {
    const auto: DecisionRecord = { ...decision, actorType: "system", actorId: null, outcome: "reject", reasonCode: "DOC_INVALID", note: null, agreesWithRecommendation: true };
    const codes = [{ code: "DOC_INVALID", riderFr: "Informations non validées.", riderEn: "Information not validated.", active: true }];
    const html = render(createElement(DecisionView, { decision: auto, profile: SUPERVISOR, reasonCodes: codes }), "fr");
    expect(html).toContain("Automatique");
    expect(html).toContain("Les règles (décision automatique)");
    expect(html).toContain("DOC_INVALID");
    expect(html).toContain("Informations non validées.");
    expect(html).toContain("Conforme à la recommandation.");
  });
});

describe("DecisionForm", () => {
  it("asks for a note before approving against a reject recommendation", () => {
    const html = render(createElement(DecisionForm, {
      risk: risk({ signals: ["mrz_invalid_server", "mrz_print_mismatch"] }),
      reasonCodes: [],
      onSubmit: noop,
      initial: { outcome: "approve" },
    }));
    expect(html).toContain("Note (required)");
    expect(html).toContain("This goes against the recommendation: say why in the note.");
    expect(html).toMatch(/<button type="submit" class="primary dash-inline" disabled="">Record the decision<\/button>/);
  });

  it("offers the rider reasons for a reject, the recommended one chosen", () => {
    const html = render(createElement(DecisionForm, {
      risk: risk({ signals: ["mrz_invalid_server", "mrz_print_mismatch"] }),
      reasonCodes: [
        { code: "DOC_EXPIRED", riderFr: "fr", riderEn: "Your ID has expired.", active: true },
        { code: "DOC_INVALID", riderFr: "fr", riderEn: "Not validated.", active: true },
      ],
      onSubmit: noop,
      initial: { outcome: "reject" },
    }));
    expect(html).toContain("Reason given to the rider");
    expect(html).toContain('<option value="DOC_INVALID" selected="">DOC_INVALID — Not validated.</option>');
    expect(html).toContain("This follows the recommendation.");
    expect(html).toContain("Note (optional)");
    expect(html).not.toMatch(/type="submit"[^>]*disabled/);
  });

  it("leaves a review recommendation to the staff member, a note optional", () => {
    const html = render(createElement(DecisionForm, {
      risk: risk({ missing: ["liveness", "face_match"] }),
      reasonCodes: [],
      onSubmit: noop,
      initial: { outcome: "approve" },
    }));
    expect(html).toContain("The rules leave this case to you.");
    expect(html).toContain("Note (optional)");
  });
});

// ---------------------------------------------------------------------------
// Thresholds page
// ---------------------------------------------------------------------------
const V2: ThresholdVersionRecord = { version: 2, config: DEFAULT_THRESHOLD_CONFIG, note: "M8 defaults", createdBy: null, createdAt: "2026-10-19T00:00:00Z" };

describe("ChangesList", () => {
  it("says each change in words", () => {
    const next: ThresholdConfig = {
      ...DEFAULT_THRESHOLD_CONFIG,
      rejectMin: 0.5,
      autoDecide: true,
      signals: { ...DEFAULT_THRESHOLD_CONFIG.signals, date_logic: { weight: 0.25, enabled: false } },
      hardFlags: DEFAULT_THRESHOLD_CONFIG.hardFlags.filter((code) => code !== "image_reused"),
      alwaysReviewDocuments: [...DEFAULT_THRESHOLD_CONFIG.alwaysReviewDocuments, "passport"],
    };
    const html = render(createElement(ChangesList, { changes: diffThresholdConfig(DEFAULT_THRESHOLD_CONFIG, next), lang: "en" }));
    expect(html).toContain("Reject cut-off: 0.9 → 0.5");
    expect(html).toContain('<li class="hard">Automatic decisions: off → on</li>');
    expect(html).toContain("Weight of “Dates contradict each other”: 0.4 → 0.25");
    expect(html).toContain("“Dates contradict each other” no longer counts in the score");
    expect(html).toContain("“Photo already used in another verification” is no longer a hard flag");
    expect(html).toContain("“Passport” always decided by a person");
  });

  it("writes French numbers in French", () => {
    const next = { ...DEFAULT_THRESHOLD_CONFIG, rejectMin: 0.5 };
    expect(render(createElement(ChangesList, { changes: diffThresholdConfig(DEFAULT_THRESHOLD_CONFIG, next), lang: "fr" }), "fr"))
      .toContain("Seuil de refus : 0,9 → 0,5");
  });
});

describe("HistoryList", () => {
  it("lists every version, newest first, the active one marked, with what each changed", () => {
    const v3: ThresholdVersionRecord = {
      version: 3,
      config: { ...DEFAULT_THRESHOLD_CONFIG, rejectMin: 0.5 },
      note: "PM test",
      createdBy: "u-admin",
      createdAt: "2026-10-19T09:00:00Z",
    };
    const v1: ThresholdVersionRecord = { version: 1, config: null, note: "M0", createdBy: null, createdAt: "2026-10-13T00:00:00Z" };
    const html = render(createElement(HistoryList, { versions: [v1, V2, v3], names: new Map([["u-admin", "Ada Admin"]]) }));
    expect(html.indexOf("Version 3")).toBeLessThan(html.indexOf("Version 2"));
    expect(html.indexOf("Version 2")).toBeLessThan(html.indexOf("Version 1"));
    expect(html.match(/>Active</g)).toHaveLength(1);
    expect(html).toContain("Ada Admin");
    expect(html).toContain("PM test");
    expect(html).toContain("Reject cut-off: 0.9 → 0.5");
    expect(html).toContain("First version of the M8 rules.");
    expect(html).toContain("Earlier format (before M8)");
  });
});

describe("ThresholdEditor", () => {
  it("lists the changes before saving, and lets a valid version with a reason be saved", () => {
    const form = { ...formFromConfig(DEFAULT_THRESHOLD_CONFIG), rejectMin: "0,5", note: "Lower the reject cut-off" };
    const html = render(createElement(ThresholdEditor, { active: V2, initialForm: form, onSave: noop }));
    expect(html).toContain("New version (3)");
    expect(html).toContain("Changes from version 2");
    expect(html).toContain("Reject cut-off: 0.9 → 0.5");
    expect(html).toMatch(/<button type="submit" class="primary dash-inline">Make version 3 active<\/button>/);
    // Mandatory hard flags cannot be unticked.
    expect(html).toMatch(/aria-label="Document expired is a hard flag" disabled=""[^>]*checked=""/);
  });

  it("shows each problem at its field and blocks saving", () => {
    const form = { ...formFromConfig(DEFAULT_THRESHOLD_CONFIG), approveMax: "0.95", note: "Why not" };
    form.weights = { ...form.weights, date_logic: "abc" };
    const html = render(createElement(ThresholdEditor, { active: V2, initialForm: form, onSave: noop }));
    expect(html).toContain("Enter a number, e.g. 0.25.");
    expect(html).toContain("Must be above the approve cut-off.");
    expect(html).toContain("Fix 2 problems above first.");
    expect(html).toMatch(/<button type="submit" class="primary dash-inline" disabled="">/);
  });

  it("blocks saving without a change or without a reason", () => {
    const unchanged = render(createElement(ThresholdEditor, { active: V2, onSave: noop }));
    expect(unchanged).toContain("No change yet.");
    expect(unchanged).toMatch(/<button type="submit" class="primary dash-inline" disabled="">/);
    const noReason = render(createElement(ThresholdEditor, {
      active: V2,
      initialForm: { ...formFromConfig(DEFAULT_THRESHOLD_CONFIG), rejectMin: "0.5" },
      onSave: noop,
    }));
    expect(noReason).toMatch(/<button type="submit" class="primary dash-inline" disabled="">/);
  });
});

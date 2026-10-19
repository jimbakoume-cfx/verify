// "Risk and decision" section of the case page (M8): the recommendation the rules give (approve, review,
// reject), the score and every signal behind it, the threshold version used, and the staff decision.
// Generic codes, weights and cut-offs only: nothing read from the document.
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DECISION_NOTE_MAX_LENGTH,
  type DecisionOutcome,
  type DecisionRequest,
  type Language,
  type RiskAssessment,
  type StaffDecision,
} from "@verify/shared";
import { useServices } from "../api/services";
import { ErrorText } from "../components/Feedback";
import { useAsync } from "../hooks";
import { formatDateTime, formatNumber, shortId, toLanguage } from "../lib/format";
import type { StaffProfile, VerificationSummary } from "../lib/records";
import { agreement, type CaseRisk, type DecisionRecord, noteRequired, type ReasonCodeRecord } from "../lib/risk";
import { canDecide } from "../lib/roles";

const RECOMMENDATION_TONE: Record<DecisionOutcome, "ok" | "warn" | "bad"> = { approve: "ok", review: "warn", reject: "bad" };

/** Approve, Review, Reject: the recommendation (or the band) of the rules. */
export function RecommendationBadge({ outcome, kind = "recommendation" }: { outcome: DecisionOutcome | null; kind?: "recommendation" | "decision" }) {
  const { t } = useTranslation();
  if (outcome === null) return <span className="badge neutral">{t("risk.notAssessedBadge")}</span>;
  return <span className={`badge ${RECOMMENDATION_TONE[outcome]}`}>{t(`risk.${kind}.${outcome}`)}</span>;
}

/** A score or a weight: up to 4 decimals (they are stored with 4). */
export function formatScore(value: number | null, lang: Language): string {
  return formatNumber(value, lang, 4);
}

export function RiskSection({
  verification,
  profile,
  onDecided,
}: {
  verification: VerificationSummary;
  profile: StaffProfile;
  /** Called after a decision is recorded: the case is reloaded. */
  onDecided: () => void;
}) {
  const { t } = useTranslation();
  const services = useServices();
  const decisions = useAsync(() => services.decisions(verification.id), `decisions:${verification.id}:${verification.status}`);
  const reasons = useAsync(() => services.reasonCodes(), "reason-codes");
  const latest = decisions.data?.[0] ?? null;

  return (
    <section className="card" aria-labelledby="risk-title">
      <div className="dash-section-head">
        <h2 id="risk-title">{t("risk.title")}</h2>
        <span className="dash-row-badges">
          <RecommendationBadge outcome={verification.risk.recommendation} />
        </span>
      </div>
      <p className="muted">{t("risk.intro")}</p>
      <RiskSummary risk={verification.risk} status={verification.status} />

      <div className="dash-subsection">
        <h3 className="dash-risk-h3">{t("decision.title")}</h3>
        {decisions.error !== null && decisions.error !== undefined && <ErrorText error={decisions.error} />}
        {latest && <DecisionView decision={latest} profile={profile} reasonCodes={reasons.data ?? []} />}
        {!latest && decisions.data && verification.status === "submitted" && (
          canDecide(profile.role)
            ? (
              <DecisionForm
                risk={verification.risk}
                reasonCodes={reasons.data ?? null}
                onSubmit={async (request) => {
                  await services.decide({ ...request, verificationId: verification.id });
                  decisions.reload();
                  onDecided();
                }}
              />
            )
            : <p className="dash-alert info">{t("decision.adminNoDecision")}</p>
        )}
        {!latest && decisions.data && verification.status !== "submitted" && (
          <p className="muted">{t(verification.status === "approved" || verification.status === "rejected" ? "decision.noRecord" : "decision.notSubmitted")}</p>
        )}
      </div>
    </section>
  );
}

/** The stored assessment, explained. */
export function RiskSummary({ risk, status }: { risk: CaseRisk; status: VerificationSummary["status"] }) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const a = risk.assessment;
  if (!a) {
    if (status === "created" || status === "in_progress") return <p className="muted">{t("risk.notYet")}</p>;
    return <p className="dash-alert info">{t(risk.assessedAt ? "risk.unknownShape" : "risk.notAssessed")}</p>;
  }
  return (
    <div className="dash-risk">
      <dl className="dash-facts compact">
        <div>
          <dt>{t("risk.score")}</dt>
          <dd>{formatScore(a.score, lang)}</dd>
        </div>
        <div>
          <dt>{t("risk.firmScore")}</dt>
          <dd>{formatScore(a.firmScore, lang)}</dd>
        </div>
        <div>
          <dt>{t("risk.band")}</dt>
          <dd>
            <RecommendationBadge outcome={a.band} />
          </dd>
        </div>
        <div>
          <dt>{t("risk.version")}</dt>
          <dd>{risk.thresholdVersion === null ? "—" : t("risk.versionNumber", { version: risk.thresholdVersion })}</dd>
        </div>
        <div>
          <dt>{t("risk.assessedAt")}</dt>
          <dd>{formatDateTime(risk.assessedAt, lang)}</dd>
        </div>
      </dl>
      <ScoreBar assessment={a} lang={lang} />

      <ul className="dash-reasons">
        {a.reasons.map((reason) => (
          <li key={reason} className={reason === "hard_flag" || reason === "firm_score_high" ? "hard" : undefined}>
            <strong>{t(`risk.reasons.label.${reason}`)}</strong>
            <span>
              {t(`risk.reasons.body.${reason}`, {
                approveMax: formatScore(a.approveMax, lang),
                rejectMin: formatScore(a.rejectMin, lang),
              })}
            </span>
          </li>
        ))}
      </ul>
      {a.rejectReasonCode && <p>{t("risk.rejectReason", { code: a.rejectReasonCode })}</p>}

      <h4 className="dash-risk-h4">{t("risk.signalsTitle")}</h4>
      {a.contributions.length === 0 && a.unknownSignals.length === 0
        ? <p className="muted">{t("risk.noSignals")}</p>
        : (
          <table className="dash-table">
            <thead>
              <tr>
                <th scope="col">{t("risk.signal")}</th>
                <th scope="col">{t("risk.weight")}</th>
                <th scope="col">{t("risk.kind")}</th>
              </tr>
            </thead>
            <tbody>
              {a.contributions.map((c) => (
                <tr key={c.signal} className={c.hard ? "hard" : undefined}>
                  <th scope="row">
                    {t(`risk.signals.${c.signal}`)} <code className="mono muted">{c.signal}</code>
                  </th>
                  <td className={c.counted ? undefined : "muted"}>
                    {c.counted ? `+${formatScore(c.weight, lang)}` : t("risk.notCounted")}
                  </td>
                  <td>
                    <span className="dash-row-badges">
                      <span className={`badge ${c.firm ? "info" : "neutral"}`}>{t(c.firm ? "risk.firm" : "risk.provisional")}</span>
                      {c.hard && <span className="badge bad">{t("serverChecks.hardFlag")}</span>}
                    </span>
                  </td>
                </tr>
              ))}
              {a.unknownSignals.map((code) => (
                <tr key={code} className="hard">
                  <th scope="row">
                    {t("risk.unknownSignal")} <code className="mono muted">{code}</code>
                  </th>
                  <td>—</td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        )}

      {a.reviewOnly.length > 0 && (
        <>
          <h4 className="dash-risk-h4">{t("risk.reviewOnlyTitle")}</h4>
          <ul className="dash-reasons">
            {a.reviewOnly.map((check) => (
              <li key={check}>
                <strong>{t(`risk.reviewOnly.${check}`, { defaultValue: check })}</strong>
                <code className="mono muted">{check}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {a.missing.length > 0 && (
        <>
          <h4 className="dash-risk-h4">{t("risk.missingTitle")}</h4>
          <ul className="dash-reasons">
            {a.missing.map((check) => (
              <li key={check}>
                <strong>{t(`risk.missing.${check}`, { defaultValue: check })}</strong>
                <code className="mono muted">{check}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The score on a 0–1 line, with the two cut-offs. Decorative: the numbers are written above. */
function ScoreBar({ assessment: a, lang }: { assessment: RiskAssessment; lang: Language }) {
  const { t } = useTranslation();
  const pct = (value: number) => `${Math.min(100, Math.max(0, value * 100))}%`;
  return (
    <div className="dash-score" aria-hidden="true">
      <div className="dash-score-track">
        <span className="dash-score-zone approve" style={{ width: pct(a.approveMax) }} />
        <span className="dash-score-zone reject" style={{ left: pct(a.rejectMin), width: pct(1 - a.rejectMin) }} />
        <span className={`dash-score-mark ${a.band}`} style={{ left: pct(a.score) }} />
      </div>
      <div className="dash-score-legend muted dash-small">
        <span>{t("risk.approveUpTo", { value: formatScore(a.approveMax, lang) })}</span>
        <span>{t("risk.rejectFrom", { value: formatScore(a.rejectMin, lang) })}</span>
      </div>
    </div>
  );
}

/** A recorded decision. */
export function DecisionView({
  decision: d,
  profile,
  reasonCodes,
}: {
  decision: DecisionRecord;
  profile: StaffProfile;
  reasonCodes: readonly ReasonCodeRecord[];
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const by = d.actorType === "system"
    ? t("decision.bySystem")
    : d.actorId === profile.userId
    ? t("decision.byYou")
    : t("decision.byStaff", { id: d.actorId ? shortId(d.actorId) : "—" });
  const reason = d.reasonCode ? reasonCodes.find((r) => r.code === d.reasonCode) : undefined;
  const agreementKey = d.agreesWithRecommendation === null ? "none" : d.agreesWithRecommendation ? "agrees" : "disagrees";

  return (
    <article className="dash-capture" aria-label={t("decision.title")}>
      <header className="dash-capture-head">
        <h4 className="dash-risk-h4">{t(`decision.outcome.${d.outcome}`)}</h4>
        <span className="dash-row-badges">
          <RecommendationBadge outcome={d.outcome} kind="decision" />
          {d.actorType === "system" && <span className="badge info">{t("decision.automatic")}</span>}
        </span>
      </header>
      <dl className="dash-facts compact">
        <div>
          <dt>{t("decision.by")}</dt>
          <dd>{by}</dd>
        </div>
        <div>
          <dt>{t("decision.at")}</dt>
          <dd>{formatDateTime(d.createdAt, lang)}</dd>
        </div>
        <div>
          <dt>{t("decision.recommendationShown")}</dt>
          <dd>
            <RecommendationBadge outcome={d.recommendation} />
          </dd>
        </div>
        <div>
          <dt>{t("risk.version")}</dt>
          <dd>{d.thresholdVersion === null ? "—" : t("risk.versionNumber", { version: d.thresholdVersion })}</dd>
        </div>
        <div>
          <dt>{t("risk.score")}</dt>
          <dd>{formatScore(d.riskScore, lang)}</dd>
        </div>
      </dl>
      <p className={d.agreesWithRecommendation === false ? "dash-alert info" : "muted"}>{t(`decision.agreement.${agreementKey}`)}</p>
      {d.reasonCode && (
        <p>
          <strong>{t("decision.riderReason")}</strong> <code className="mono">{d.reasonCode}</code>
          {reason && <> — {lang === "fr" ? reason.riderFr : reason.riderEn}</>}
        </p>
      )}
      {d.note && (
        <p className="dash-note">
          <strong>{t("decision.note")}</strong> {d.note}
        </p>
      )}
    </article>
  );
}

/** Approve or reject, with the rider reason of a reject and a note when one is required. */
export function DecisionForm({
  risk,
  reasonCodes,
  onSubmit,
  initial,
}: {
  risk: CaseRisk;
  /** Null while loading. */
  reasonCodes: readonly ReasonCodeRecord[] | null;
  onSubmit: (request: Omit<DecisionRequest, "verificationId">) => Promise<void>;
  /** Dev preview and tests. */
  initial?: { outcome?: StaffDecision; note?: string };
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const [outcome, setOutcome] = useState<StaffDecision | null>(initial?.outcome ?? null);
  const [reasonCode, setReasonCode] = useState(risk.assessment?.rejectReasonCode ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const needsNote = outcome !== null && noteRequired(risk, outcome);
  const agrees = outcome === null ? null : agreement(risk.recommendation, outcome);
  const missingNote = needsNote && note.trim() === "";
  const missingReason = outcome === "reject" && reasonCode === "";
  const tooLong = [...note.trim()].length > DECISION_NOTE_MAX_LENGTH;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (outcome === null || missingNote || missingReason || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ outcome, reasonCode: outcome === "reject" ? reasonCode : null, note: note.trim() || null });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form className="dash-form" onSubmit={(e) => void submit(e)}>
      <fieldset className="dash-fieldset">
        <legend>{t("decision.choose")}</legend>
        {(["approve", "reject"] as const).map((value) => (
          <label key={value} className="dash-check">
            <input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} />
            {t(`decision.outcome.${value}`)}
          </label>
        ))}
      </fieldset>
      {outcome === "reject" && (
        <label className="field">
          <span>{t("decision.riderReason")}</span>
          <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} required>
            <option value="">{t(reasonCodes === null ? "loading" : "decision.chooseReason")}</option>
            {(reasonCodes ?? []).map((r) => (
              <option key={r.code} value={r.code}>
                {r.code} — {lang === "fr" ? r.riderFr : r.riderEn}
              </option>
            ))}
          </select>
          <span className="hint">{t("decision.riderReasonHint")}</span>
        </label>
      )}
      {outcome !== null && (
        <p className={agrees === false ? "dash-alert info" : "muted"}>
          {t(`decision.preview.${agrees === null ? "none" : agrees ? "agrees" : "disagrees"}`)}
        </p>
      )}
      <label className="field">
        <span>{t(needsNote ? "decision.noteRequired" : "decision.noteOptional")}</span>
        <textarea value={note} rows={3} maxLength={DECISION_NOTE_MAX_LENGTH} onChange={(e) => setNote(e.target.value)} />
        <span className="hint">{t("decision.noteHint")}</span>
      </label>
      {error !== null && <ErrorText error={error} context="decision" />}
      <button type="submit" className="primary dash-inline" disabled={busy || outcome === null || missingNote || missingReason || tooLong}>
        {busy ? t("decision.saving") : t("decision.submit")}
      </button>
    </form>
  );
}

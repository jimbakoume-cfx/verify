// Thresholds page (M8, admins only): the active version, a form to create the next one (checked with the
// server's own rules, with the changes listed before saving), and every earlier version with what it
// changed. A new version is active at once, with no redeploy, and every case waiting for a decision is
// assessed again with it.
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ConfigChange,
  DECLARED_DOCUMENTS,
  diffThresholdConfig,
  faceMatchCounts,
  FIRM_SIGNALS,
  type Language,
  MANDATORY_HARD_FLAGS,
  MANDATORY_REVIEW_DOCUMENTS,
  RISK_SIGNALS,
  THRESHOLD_NOTE_MAX_LENGTH,
  THRESHOLD_NOTE_MIN_LENGTH,
  type ThresholdConfig,
  type ThresholdVersionResponse,
} from "@verify/shared";
import { useServices } from "../api/services";
import { ErrorText } from "../components/Feedback";
import { Link } from "../components/Link";
import { useAsync } from "../hooks";
import { formatDateTime, shortId, toLanguage } from "../lib/format";
import type { StaffProfile } from "../lib/records";
import { activeVersion, type ThresholdVersionRecord } from "../lib/risk";
import { canEditThresholds } from "../lib/roles";
import { checkForm, errorsFor, formFromConfig, type ThresholdForm } from "../lib/thresholdForm";
import { formatScore } from "./CaseRisk";

export function ThresholdsPage({ profile }: { profile: StaffProfile }) {
  const { t } = useTranslation();
  const services = useServices();
  const versions = useAsync(() => services.thresholdVersions(), "threshold-versions");
  const names = useAsync(() => services.staffNames(), "staff-names");
  const [saved, setSaved] = useState<ThresholdVersionResponse | null>(null);
  const active = versions.data ? activeVersion(versions.data) : null;

  return (
    <>
      <nav>
        <Link href="/" className="dash-back">
          ← {t("case.back")}
        </Link>
      </nav>
      <section className="card" aria-labelledby="thresholds-title" aria-busy={versions.loading || undefined}>
        <div className="dash-section-head">
          <h1 id="thresholds-title">{t("thresholds.title")}</h1>
          {active && <span className="badge info">{t("risk.versionNumber", { version: active.version })}</span>}
        </div>
        <p className="muted">{t("thresholds.intro")}</p>
        {!canEditThresholds(profile.role) && <p className="dash-alert info">{t("errors.thresholdsRole")}</p>}
        {versions.error !== null && versions.error !== undefined && <ErrorText error={versions.error} />}
        {saved && (
          <p className="dash-alert ok" role="status">
            {t("thresholds.saved", { version: saved.version, count: saved.rescored })}
          </p>
        )}
        {active && <VersionFacts version={active} names={names.data} />}
      </section>

      {canEditThresholds(profile.role) && active?.config && (
        <ThresholdEditor
          key={active.version}
          active={active}
          onSave={async (request) => {
            const result = await services.createThresholdVersion(request);
            setSaved(result);
            versions.reload();
          }}
        />
      )}
      {canEditThresholds(profile.role) && active && !active.config && <p className="dash-alert error">{t("thresholds.activeUnknown")}</p>}

      {versions.data && <HistoryList versions={versions.data} names={names.data} />}
    </>
  );
}

function byName(
  version: ThresholdVersionRecord,
  names: ReadonlyMap<string, string> | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const id = version.createdBy;
  if (!id) return version.createdByMigration ? t("thresholds.byMigration", { name: version.createdByMigration }) : t("thresholds.bySystem");
  return names?.get(id) ?? t("decision.byStaff", { id: shortId(id) });
}

/** Who, when, why, and the main settings of a version. */
export function VersionFacts({ version: v, names }: { version: ThresholdVersionRecord; names: ReadonlyMap<string, string> | undefined }) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  return (
    <dl className="dash-facts compact">
      <div>
        <dt>{t("thresholds.createdAt")}</dt>
        <dd>{formatDateTime(v.createdAt, lang)}</dd>
      </div>
      <div>
        <dt>{t("thresholds.createdBy")}</dt>
        <dd>{byName(v, names, t)}</dd>
      </div>
      {v.config && (
        <>
          <div>
            <dt>{t("thresholds.approveMax")}</dt>
            <dd>{formatScore(v.config.approveMax, lang)}</dd>
          </div>
          <div>
            <dt>{t("thresholds.rejectMin")}</dt>
            <dd>{formatScore(v.config.rejectMin, lang)}</dd>
          </div>
          <div>
            <dt>{t("thresholds.autoDecide")}</dt>
            <dd>{t(v.config.autoDecide ? "thresholds.on" : "thresholds.off")}</dd>
          </div>
          <div>
            <dt>{t("thresholds.faceMatchCounts")}</dt>
            <dd>{t(faceMatchCounts(v.config) ? "thresholds.yes" : "thresholds.no")}</dd>
          </div>
        </>
      )}
      <div className="dash-facts-wide">
        <dt>{t("thresholds.note")}</dt>
        <dd>{v.note ?? "—"}</dd>
      </div>
    </dl>
  );
}

/** The form for the next version. */
export function ThresholdEditor({
  active,
  onSave,
  initialForm,
}: {
  active: ThresholdVersionRecord;
  onSave: (request: { baseVersion: number; config: Record<string, unknown>; note: string }) => Promise<void>;
  /** Dev preview and tests. */
  initialForm?: ThresholdForm;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const base = active.config as ThresholdConfig;
  const [form, setForm] = useState<ThresholdForm>(() => initialForm ?? formFromConfig(base));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const check = useMemo(() => checkForm(form, base), [form, base]);
  const errors = check.ok ? [] : check.errors;
  const canSave = check.ok && check.changes.length > 0 && check.noteError === null && !busy;

  const update = (patch: Partial<ThresholdForm>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = <T extends string>(list: readonly T[], item: T, on: boolean): T[] =>
    on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!check.ok || !canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ baseVersion: active.version, config: { ...check.config }, note: form.note.trim() });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const fieldErrors = (path: string) =>
    errorsFor(errors, path).map((code) => (
      <span key={code} className="dash-field-error">
        {t(`thresholds.errors.${code}`, { defaultValue: code })}
      </span>
    ));

  return (
    <section className="card" aria-labelledby="threshold-edit-title">
      <div className="dash-section-head">
        <h2 id="threshold-edit-title">{t("thresholds.editTitle", { version: active.version + 1 })}</h2>
      </div>
      <p className="muted">{t("thresholds.editIntro")}</p>
      <form className="dash-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="dash-threshold-cutoffs">
          <label className="field">
            <span>{t("thresholds.approveMax")}</span>
            <input inputMode="decimal" value={form.approveMax} onChange={(e) => update({ approveMax: e.target.value })} />
            <span className="hint">{t("thresholds.approveMaxHint")}</span>
            {fieldErrors("approveMax")}
          </label>
          <label className="field">
            <span>{t("thresholds.rejectMin")}</span>
            <input inputMode="decimal" value={form.rejectMin} onChange={(e) => update({ rejectMin: e.target.value })} />
            <span className="hint">{t("thresholds.rejectMinHint")}</span>
            {fieldErrors("rejectMin")}
          </label>
        </div>

        <table className="dash-table">
          <caption className="dash-table-caption">{t("thresholds.signalsCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("risk.signal")}</th>
              <th scope="col">{t("risk.weight")}</th>
              <th scope="col">{t("thresholds.counted")}</th>
              <th scope="col">{t("serverChecks.hardFlag")}</th>
            </tr>
          </thead>
          <tbody>
            {RISK_SIGNALS.map((code) => {
              const mandatory = MANDATORY_HARD_FLAGS.includes(code);
              const label = t(`risk.signals.${code}`);
              return (
                <tr key={code}>
                  <th scope="row">
                    {label} <code className="mono muted">{code}</code>{" "}
                    <span className={`badge ${FIRM_SIGNALS.includes(code) ? "info" : "neutral"}`}>
                      {t(FIRM_SIGNALS.includes(code) ? "risk.firm" : "risk.provisional")}
                    </span>
                  </th>
                  <td>
                    <input
                      className="dash-weight"
                      inputMode="decimal"
                      aria-label={t("thresholds.weightOf", { signal: label })}
                      value={form.weights[code]}
                      onChange={(e) => update({ weights: { ...form.weights, [code]: e.target.value } })}
                    />
                    {fieldErrors(`signals.${code}.weight`)}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t("thresholds.countedOf", { signal: label })}
                      checked={form.enabled[code]}
                      onChange={(e) => update({ enabled: { ...form.enabled, [code]: e.target.checked } })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t("thresholds.hardOf", { signal: label })}
                      checked={form.hardFlags.includes(code)}
                      disabled={mandatory}
                      title={mandatory ? t("thresholds.mandatoryHard") : undefined}
                      onChange={(e) => update({ hardFlags: toggle(form.hardFlags, code, e.target.checked) })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {fieldErrors("hardFlags")}

        <fieldset className="dash-fieldset">
          <legend>{t("thresholds.alwaysReview")}</legend>
          {DECLARED_DOCUMENTS.map((doc) => {
            const mandatory = MANDATORY_REVIEW_DOCUMENTS.includes(doc);
            return (
              <label key={doc} className="dash-check">
                <input
                  type="checkbox"
                  checked={form.alwaysReviewDocuments.includes(doc)}
                  disabled={mandatory}
                  onChange={(e) => update({ alwaysReviewDocuments: toggle(form.alwaysReviewDocuments, doc, e.target.checked) })}
                />
                {t(`documents.${doc}`)}
                {mandatory && <span className="muted dash-small">{t("thresholds.mandatoryDocument")}</span>}
              </label>
            );
          })}
          {fieldErrors("alwaysReviewDocuments")}
        </fieldset>

        <fieldset className="dash-fieldset">
          <legend>{t("thresholds.autoDecide")}</legend>
          <label className="dash-check">
            <input type="checkbox" checked={form.autoDecide} onChange={(e) => update({ autoDecide: e.target.checked })} />
            {t("thresholds.autoDecideLabel")}
          </label>
          <p className="muted dash-small">{t("thresholds.autoDecideHint")}</p>
          <label className="dash-check">
            <input type="checkbox" checked={form.faceMatchCounts} onChange={(e) => update({ faceMatchCounts: e.target.checked })} />
            {t("thresholds.faceMatchCountsLabel")}
          </label>
          <p className="dash-alert warn dash-small">{t("thresholds.faceMatchCountsHint")}</p>
        </fieldset>

        <label className="field">
          <span>{t("thresholds.reason")}</span>
          <textarea
            rows={2}
            value={form.note}
            maxLength={THRESHOLD_NOTE_MAX_LENGTH}
            onChange={(e) => update({ note: e.target.value })}
          />
          <span className="hint">{t("thresholds.reasonHint", { min: THRESHOLD_NOTE_MIN_LENGTH, max: THRESHOLD_NOTE_MAX_LENGTH })}</span>
          {check.noteError && check.noteError !== "missing" && (
            <span className="dash-field-error">{t(`thresholds.noteError.${check.noteError}`, { min: THRESHOLD_NOTE_MIN_LENGTH, max: THRESHOLD_NOTE_MAX_LENGTH })}</span>
          )}
        </label>

        <div className="dash-subsection">
          <h3 className="dash-risk-h3">{t("thresholds.changesTitle", { version: active.version })}</h3>
          {!check.ok && <p className="dash-alert error">{t("thresholds.fixErrors", { count: errors.length })}</p>}
          {check.ok && check.changes.length === 0 && <p className="muted">{t("thresholds.noChanges")}</p>}
          {check.ok && check.changes.length > 0 && <ChangesList changes={check.changes} lang={lang} />}
        </div>

        {error !== null && <ErrorText error={error} context="thresholds" />}
        <button type="submit" className="primary dash-inline" disabled={!canSave}>
          {busy ? t("thresholds.saving") : t("thresholds.save", { version: active.version + 1 })}
        </button>
      </form>
    </section>
  );
}

/** What a version changes, one line each. */
export function ChangesList({ changes, lang }: { changes: readonly ConfigChange[]; lang: Language }) {
  const { t } = useTranslation();
  const score = (value: number) => formatScore(value, lang);
  const onOff = (value: boolean) => t(value ? "thresholds.on" : "thresholds.off");
  const yesNo = (value: boolean) => t(value ? "thresholds.yes" : "thresholds.no");
  return (
    <ul className="dash-changes">
      {changes.map((c) => {
        let text: string;
        switch (c.kind) {
          case "approveMax":
          case "rejectMin":
            text = t(`thresholds.change.${c.kind}`, { from: score(c.from), to: score(c.to) });
            break;
          case "autoDecide":
            text = t("thresholds.change.autoDecide", { from: onOff(c.from), to: onOff(c.to) });
            break;
          case "faceMatchCountsForApproval":
            text = t("thresholds.change.faceMatchCountsForApproval", { from: yesNo(c.from), to: yesNo(c.to) });
            break;
          case "weight":
            text = t("thresholds.change.weight", { signal: t(`risk.signals.${c.signal}`), from: score(c.from), to: score(c.to) });
            break;
          case "enabled":
            text = t(c.to ? "thresholds.change.counted" : "thresholds.change.notCounted", { signal: t(`risk.signals.${c.signal}`) });
            break;
          case "hardFlag":
            text = t(c.to ? "thresholds.change.hard" : "thresholds.change.notHard", { signal: t(`risk.signals.${c.signal}`) });
            break;
          case "alwaysReview":
            text = t(c.to ? "thresholds.change.alwaysReview" : "thresholds.change.notAlwaysReview", { document: t(`documents.${c.document}`) });
            break;
        }
        return (
          <li key={`${c.kind}:${"signal" in c ? c.signal : "document" in c ? c.document : ""}`} className={(c.kind === "autoDecide" || c.kind === "faceMatchCountsForApproval") && c.to ? "hard" : undefined}>
            {text}
          </li>
        );
      })}
    </ul>
  );
}

/** Every version, newest first, with what it changed from the one before. */
export function HistoryList({ versions, names }: { versions: readonly ThresholdVersionRecord[]; names: ReadonlyMap<string, string> | undefined }) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  return (
    <section className="card" aria-labelledby="history-title">
      <h2 id="history-title">{t("thresholds.historyTitle")}</h2>
      <ul className="dash-captures">
        {sorted.map((v, i) => {
          const previous = sorted[i + 1];
          return (
            <li key={v.version}>
              <article className="dash-capture" aria-label={t("risk.versionNumber", { version: v.version })}>
                <header className="dash-capture-head">
                  <h3>{t("risk.versionNumber", { version: v.version })}</h3>
                  {i === 0 && <span className="badge ok">{t("thresholds.active")}</span>}
                </header>
                <VersionFacts version={v} names={names} />
                {!v.config && <p className="muted">{t("thresholds.earlierFormat")}</p>}
                {v.config && previous?.config && <ChangesList changes={diffThresholdConfig(previous.config, v.config)} lang={lang} />}
                {v.config && previous && !previous.config && <p className="muted">{t("thresholds.firstOfFormat")}</p>}
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

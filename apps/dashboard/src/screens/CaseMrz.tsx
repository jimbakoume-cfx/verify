// "Code lines (MRZ)" section of the case page: the server's verdict on what the rider's phone read,
// per photo. The server's own reading of the photo is in the "Server checks" section, and the lines
// themselves behind "Show data read" (CaseData.tsx).
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type Language, MRZ_EXPECTATION } from "@verify/shared";
import { CheckLines, OutcomeBadge } from "../components/Checks";
import { ErrorText } from "../components/Feedback";
import { formatDateTime, formatNumber, toLanguage } from "../lib/format";
import { formatMrzFormat, type MrzEntry, mrzCheckLines, mrzOverview } from "../lib/mrz";
import type { CaptureRecord, MrzCheckRecord, VerificationSummary } from "../lib/records";

export function MrzSection({
  verification,
  captures,
  checks,
  error,
  loading,
  onReload,
}: {
  verification: VerificationSummary;
  captures: CaptureRecord[];
  /** Undefined until the first load ends. */
  checks: MrzCheckRecord[] | undefined;
  error: unknown;
  loading: boolean;
  onReload: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const overview = useMemo(
    () => (checks ? mrzOverview(verification.declaredDocument, captures, checks) : null),
    [verification.declaredDocument, captures, checks],
  );

  const declared = verification.declaredDocument;
  const expectation = declared ? MRZ_EXPECTATION[declared] : null;
  let expectationText = t("mrz.none");
  if (!declared) expectationText = t("recent.noDocument");
  else if (expectation) {
    expectationText = t(`mrz.expectedOn.${expectation.side}`, { format: formatMrzFormat(expectation.format) });
    if (!expectation.required) expectationText += ` ${t("mrz.optional")}`;
  }

  return (
    <section className="card" aria-labelledby="mrz-title" aria-busy={loading || undefined}>
      <div className="dash-section-head">
        <h2 id="mrz-title">{t("mrz.title")}</h2>
        <button type="button" className="small" onClick={onReload} disabled={loading}>
          {loading ? t("loading") : t("recent.refresh")}
        </button>
      </div>
      <p className="muted">{expectationText}</p>
      {error !== null && error !== undefined && (
        <>
          <ErrorText error={error} />
          <button type="button" className="small" onClick={onReload} disabled={loading}>
            {t("retry")}
          </button>
        </>
      )}
      {!overview && loading && <p className="muted">{t("loading")}</p>}

      {overview && overview.entries.length > 0 && (
        <>
          {overview.entries.some((e) => e.type === "check") && <p className="muted dash-small">{t("mrz.intro")}</p>}
          <ul className="dash-captures">
            {overview.entries.map((entry) => (
              <li key={entry.type === "check" ? entry.check.id : `missing.${entry.side}`}>
                <MrzEntryItem entry={entry} lang={lang} />
              </li>
            ))}
          </ul>
        </>
      )}

    </section>
  );
}

function MrzEntryItem({ entry, lang }: { entry: MrzEntry; lang: Language }) {
  const { t } = useTranslation();

  if (entry.type === "missing") {
    const side = t(`kinds.${entry.side}`);
    return (
      <article className="dash-capture" aria-label={side}>
        <header className="dash-capture-head">
          <h3>{side}</h3>
          <span className="dash-row-badges">
            <span className={`badge ${entry.captureId ? "warn" : "neutral"}`}>{t("mrz.notReceived")}</span>
          </span>
        </header>
        {entry.capturedAt && (
          <p className="muted dash-small">{t("mrz.photoOf", { time: formatDateTime(entry.capturedAt, lang) })}</p>
        )}
        <p>{entry.captureId ? t("mrz.notReceivedBody") : t("mrz.noPhotoYet")}</p>
      </article>
    );
  }

  const { check } = entry;
  const d = check.details;
  const side = entry.kind ? t(`kinds.${entry.kind}`, { defaultValue: entry.kind }) : t("mrz.unknownSide");
  const read = d?.result === "read";
  const facts: [string, string][] = [];
  if (d) {
    if (read) facts.push([t("mrz.format"), formatMrzFormat(d.format)]);
    facts.push([t("mrz.expectedFormat"), formatMrzFormat(d.expectedFormat)], [t("mrz.tries"), formatNumber(d.attempts, lang)]);
    if (read) {
      facts.push(
        [t("mrz.corrections"), formatNumber(d.corrections, lang)],
        [t("mrz.readingTime"), d.ms === null ? "—" : t("capture.seconds", { value: formatNumber(d.ms / 1000, lang, 1) })],
      );
    }
    facts.push([t("mrz.engine"), d.engine || "—"]);
  }
  facts.push([t("mrz.parserVersion"), check.checkVersion || "—"]);

  return (
    <article className="dash-capture" aria-label={side}>
      <header className="dash-capture-head">
        <h3>{side}</h3>
        <span className="dash-row-badges">
          <OutcomeBadge outcome={check.outcome} />
          {entry.superseded && <span className="badge neutral">{t("mrz.earlierPhoto")}</span>}
        </span>
      </header>
      <p className="muted dash-small">
        {entry.capturedAt
          ? t("mrz.photoOf", { time: formatDateTime(entry.capturedAt, lang) })
          : t("mrz.receivedAt", { time: formatDateTime(check.createdAt, lang) })}
      </p>
      {!d && <p className="dash-alert info">{t("mrz.detailsUnknown")}</p>}
      {d?.result === "unreadable" && (
        <p className="dash-alert info">{t(d.reason ? `mrz.unreadable.${d.reason}` : "mrz.unreadable.unknown")}</p>
      )}
      {d && read && <CheckLines lines={mrzCheckLines(d)} />}
      <dl className="dash-facts compact">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

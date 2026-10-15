// "Server checks" section of the case page (M3): what the server found on the photos themselves. Per
// case, the document recognised and the reasons a person must decide; per side (the newest photo
// only), the photo check, the code lines read from the photo and the names of the printed fields
// read. Outcomes, generic codes and metrics only: the values are behind "Show data read".
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClassificationDetails, Language, PolicyReason } from "@verify/shared";
import { CheckLines, OutcomeBadge, ProvisionalBadge } from "../components/Checks";
import { ErrorText } from "../components/Feedback";
import { formatDateTime, formatNumber, formatPercent, toLanguage } from "../lib/format";
import { formatMrzFormat, serverMrzCheckLines } from "../lib/mrz";
import type { CaptureRecord, CheckRecord, ServerChecks, VerificationSummary } from "../lib/records";
import {
  declaredMatch,
  type ServerOverview,
  type ServerSide,
  SERVER_FOCUS_LABEL,
  serverOverview,
  VERDICT_TONE,
} from "../lib/serverChecks";

export function ServerChecksSection({
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
  checks: ServerChecks | undefined;
  error: unknown;
  loading: boolean;
  onReload: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const overview = useMemo(
    () => (checks ? serverOverview(verification.declaredDocument, captures, checks) : null),
    [verification.declaredDocument, captures, checks],
  );

  return (
    <section className="card" aria-labelledby="server-title" aria-busy={loading || undefined}>
      <div className="dash-section-head">
        <h2 id="server-title">{t("serverChecks.title")}</h2>
        <button type="button" className="small" onClick={onReload} disabled={loading}>
          {loading ? t("loading") : t("recent.refresh")}
        </button>
      </div>
      <p className="muted">{t("serverChecks.intro")}</p>
      {error !== null && error !== undefined && (
        <>
          <ErrorText error={error} />
          <button type="button" className="small" onClick={onReload} disabled={loading}>
            {t("retry")}
          </button>
        </>
      )}
      {!overview && loading && <p className="muted">{t("loading")}</p>}

      {overview && overview.sides.length === 0 && !overview.started && <p className="muted">{t("case.noPhotos")}</p>}
      {overview && (overview.sides.length > 0 || overview.started) && (
        <ul className="dash-captures">
          <li>
            <DocumentItem verification={verification} classification={overview.classification} />
          </li>
          <li>
            <ReasonsItem overview={overview} />
          </li>
          {overview.sides.map((side) => (
            <li key={side.side}>
              <SideItem side={side} lang={lang} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The document the server recognised, against the one the rider declared. */
function DocumentItem({
  verification,
  classification,
}: {
  verification: VerificationSummary;
  classification: CheckRecord<ClassificationDetails> | null;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const title = t("serverChecks.document.title");
  const d = classification?.details ?? null;
  const declared = verification.declaredDocument
    ? t(`documents.${verification.declaredDocument}`)
    : t("recent.noDocument");

  return (
    <article className="dash-capture" aria-label={title}>
      <header className="dash-capture-head">
        <h3>{title}</h3>
        {classification && (
          <span className="dash-row-badges">
            <OutcomeBadge outcome={classification.outcome} />
            {d?.provisional && <ProvisionalBadge />}
          </span>
        )}
      </header>
      {!classification && <p className="muted">{t("serverChecks.document.pending")}</p>}
      {classification && !d && <p className="dash-alert info">{t("mrz.detailsUnknown")}</p>}
      {d && (
        <>
          <CheckLines
            lines={[
              {
                key: `serverChecks.document.match.${declaredMatch(d)}`,
                ok: d.matchesDeclared,
              },
            ]}
          />
          <dl className="dash-facts compact">
            <div>
              <dt>{t("serverChecks.document.detected")}</dt>
              <dd>{d.detected === "unknown" ? t("serverChecks.document.unknown") : t(`documents.${d.detected}`)}</dd>
            </div>
            <div>
              <dt>{t("serverChecks.document.declared")}</dt>
              <dd>{declared}</dd>
            </div>
            <div>
              <dt>{t("serverChecks.document.basisLabel")}</dt>
              <dd>{t(`serverChecks.document.basis.${d.basis}`)}</dd>
            </div>
            <div>
              <dt>{t("serverChecks.document.confidence")}</dt>
              <dd>{formatPercent(d.confidence, lang)}</dd>
            </div>
            <div>
              <dt>{t("serverChecks.document.qr")}</dt>
              <dd>{d.qrPresent === null ? "—" : t(d.qrPresent ? "serverChecks.yes" : "serverChecks.no")}</dd>
            </div>
            <div>
              <dt>{t("mrz.parserVersion")}</dt>
              <dd>{classification?.checkVersion || "—"}</dd>
            </div>
          </dl>
        </>
      )}
    </article>
  );
}

/** The generic reasons a person must decide, each with its explanation. */
function ReasonsItem({ overview }: { overview: ServerOverview }) {
  const { t } = useTranslation();
  const { policy, reasons } = overview;
  const title = t("serverChecks.reasons.title");

  return (
    <article className="dash-capture" aria-label={title}>
      <header className="dash-capture-head">
        <h3>{title}</h3>
        {policy && <OutcomeBadge outcome={policy.outcome} />}
      </header>
      {!policy && <p className="muted">{t("serverChecks.reasons.pending")}</p>}
      {policy && !policy.details && <p className="dash-alert info">{t("mrz.detailsUnknown")}</p>}
      {policy?.details && reasons.length === 0 && (
        <p>{t(overview.unknownFlag ? "serverChecks.reasons.unknownOnly" : "serverChecks.reasons.none")}</p>
      )}
      {reasons.length > 0 && (
        <ul className="dash-reasons">
          {reasons.map((reason: PolicyReason) => (
            <li key={reason}>
              <strong>{t(`serverChecks.reasons.label.${reason}`)}</strong>
              <span>{t(`serverChecks.reasons.body.${reason}`)}</span>
              <code className="mono muted">{reason}</code>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** One side: its newest photo's check, the code lines read from it and the printed fields found. */
function SideItem({ side, lang }: { side: ServerSide; lang: Language }) {
  const { t } = useTranslation();
  const label = t(`kinds.${side.side}`);
  const q = side.quality?.details ?? null;

  return (
    <article className="dash-capture" aria-label={label}>
      <header className="dash-capture-head">
        <h3>{label}</h3>
        <span className="dash-row-badges">
          {side.state === "pending" && <span className="badge neutral">{t("serverChecks.side.pendingBadge")}</span>}
          {(side.state === "unchecked" || side.state === "not_sent") && (
            <span className="badge warn">{t("serverChecks.side.uncheckedBadge")}</span>
          )}
          {q && (
            <span className={`badge ${VERDICT_TONE[q.verdict]}`}>{t(`serverChecks.verdict.${q.verdict}`)}</span>
          )}
          {side.quality && !q && <OutcomeBadge outcome={side.quality.outcome} />}
          {side.quality && <ProvisionalBadge />}
        </span>
      </header>
      {side.capture && (
        <p className="muted dash-small">{t("mrz.photoOf", { time: formatDateTime(side.capture.createdAt, lang) })}</p>
      )}
      {side.state === "no_photo" && <p>{t("mrz.noPhotoYet")}</p>}
      {side.state === "pending" && <p className="dash-alert info">{t("serverChecks.side.pending")}</p>}
      {side.state === "unchecked" && <p className="dash-alert info">{t("serverChecks.side.unchecked")}</p>}
      {side.state === "not_sent" && <p className="dash-alert info">{t("serverChecks.side.notSent")}</p>}
      {side.state === "checked" && (
        <>
          <QualityFacts side={side} lang={lang} />
          {(side.mrz || side.mrzFormat) && <ServerMrz side={side} lang={lang} />}
          <FieldsFound side={side} />
        </>
      )}
    </article>
  );
}

function QualityFacts({ side, lang }: { side: ServerSide; lang: Language }) {
  const { t } = useTranslation();
  if (!side.quality) return null;
  const d = side.quality.details;
  if (!d) return <p className="dash-alert info">{t("mrz.detailsUnknown")}</p>;
  const q = d.quality;
  const seconds = t("capture.seconds", { value: formatNumber(d.timing.ms / 1000, lang, 1) });
  const facts: [string, string][] = [
    [t("serverChecks.quality.textLines"), formatNumber(q.textLines, lang)],
    [
      t("serverChecks.quality.document"),
      q.documentFound
        ? t("serverChecks.quality.documentYes", { confidence: formatPercent(q.documentConfidence, lang) })
        : t("serverChecks.no"),
    ],
    [t(SERVER_FOCUS_LABEL), formatNumber(q.sharpness, lang, 1)],
    [t("capture.glare"), formatPercent(q.glareRatio, lang, 1)],
    [t("capture.brightness"), `${formatNumber(q.meanLuma, lang)} / 255`],
    [t("serverChecks.quality.longSide"), `${formatNumber(q.longSide, lang)} px`],
    [t("serverChecks.quality.time"), d.timing.cold ? t("serverChecks.quality.coldStart", { time: seconds }) : seconds],
    [t("mrz.engine"), d.engine || "—"],
    [t("mrz.parserVersion"), side.quality.checkVersion || "—"],
  ];

  return (
    <>
      {d.verdict !== "ok" && <p className="dash-alert info">{t(`serverChecks.verdictBody.${d.verdict}`)}</p>}
      <dl className="dash-facts compact">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** The code lines the server read from the photo, on the side that carries them. */
function ServerMrz({ side, lang }: { side: ServerSide; lang: Language }) {
  const { t } = useTranslation();
  const check = side.mrz;
  const d = check?.details ?? null;

  return (
    <div className="dash-subsection">
      <div className="dash-capture-head">
        <h4>{t("serverChecks.mrz.title")}</h4>
        {check && <OutcomeBadge outcome={check.outcome} />}
      </div>
      {!check && <p className="muted">{t("serverChecks.mrz.none")}</p>}
      {check && !d && <p className="dash-alert info">{t("mrz.detailsUnknown")}</p>}
      {check && d && (
        <>
          <CheckLines lines={serverMrzCheckLines(d, side.mrzFormat)} />
          <dl className="dash-facts compact">
            <div>
              <dt>{t("mrz.format")}</dt>
              <dd>{formatMrzFormat(d.format)}</dd>
            </div>
            <div>
              <dt>{t("mrz.expectedFormat")}</dt>
              <dd>{formatMrzFormat(side.mrzFormat)}</dd>
            </div>
            <div>
              <dt>{t("mrz.corrections")}</dt>
              <dd>{formatNumber(d.corrections, lang)}</dd>
            </div>
            <div>
              <dt>{t("mrz.parserVersion")}</dt>
              <dd>{check.checkVersion || d.parserVersion || "—"}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}

/** Names of the printed fields read (never their values). */
function FieldsFound({ side }: { side: ServerSide }) {
  const { t } = useTranslation();
  const check = side.fields;
  if (!check) return null;
  const d = check.details;

  return (
    <div className="dash-subsection">
      <div className="dash-capture-head">
        <h4>{t("serverChecks.fields.title")}</h4>
        {d?.provisional && <ProvisionalBadge />}
      </div>
      {!d && <p className="dash-alert info">{t("mrz.detailsUnknown")}</p>}
      {d && d.found.length === 0 && <p>{t("serverChecks.fields.none")}</p>}
      {d && d.found.length > 0 && (
        <p>{t("serverChecks.fields.found", { fields: d.found.map((name) => t(`data.fields.${name}`)).join(", ") })}</p>
      )}
    </div>
  );
}

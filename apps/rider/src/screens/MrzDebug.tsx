// ?debug=1 only: everything the phone read from the MRZ, to calibrate the reader on real documents.
// The rider never sees this (they only get "Code lines read ✓"); nothing here is logged or sent.
// translate="no" (and Google's "notranslate" class) keeps the browser's page translation, which
// sends the page text to an online service, away from it, like the dashboard's data viewer.
import { useTranslation } from "react-i18next";
import { type MrzChecks, type MrzDate, documentCodeFits } from "@verify/shared";
import type { MrzReadResult } from "../mrz/types";

const CHECKS: readonly (keyof MrzChecks)[] = ["documentNumber", "birthDate", "expiryDate", "personalNumber", "composite"];

const mark = (ok: boolean) => (ok ? "✅" : "❌");

function date(value: MrzDate): string {
  return value.iso ? `${value.iso} (${value.raw})` : `${value.raw} ❌`;
}

export function MrzDebug({ read, attempt }: { read: MrzReadResult; attempt: number | undefined }) {
  const { t } = useTranslation();
  const { parsed } = read;
  const rows: [string, string][] = [
    [t("debug.mrz.model"), read.engine],
    [t("debug.mrz.status"), read.status],
    [t("debug.mrz.format"), read.format],
    [t("debug.mrz.charHeight"), read.charHeight === null ? "—" : `${read.charHeight.toFixed(1)} px`],
    [t("debug.mrz.time"), `${Math.round(read.ms)} ms`],
    [t("debug.mrz.corrections"), String(read.corrections)],
    [t("debug.mrz.rotated"), read.rotated ? t("debug.mrz.yes") : t("debug.mrz.no")],
    [t("debug.mrz.attempt"), String(attempt ?? 1)],
  ];
  const fields: [string, string][] = parsed
    ? [
        [
          t("debug.mrz.field.documentCode"),
          `${parsed.documentCode} ${mark(documentCodeFits(parsed.format, parsed.documentCode))}`,
        ],
        [t("debug.mrz.field.issuingState"), parsed.issuingState],
        [t("debug.mrz.field.documentNumber"), parsed.documentNumber],
        [t("debug.mrz.field.surname"), parsed.surname],
        [t("debug.mrz.field.givenNames"), parsed.givenNames || "—"],
        [t("debug.mrz.field.nationality"), parsed.nationality],
        [t("debug.mrz.field.birthDate"), date(parsed.birthDate)],
        [t("debug.mrz.field.sex"), parsed.sex ?? "—"],
        [t("debug.mrz.field.expiryDate"), date(parsed.expiryDate)],
        [t("debug.mrz.field.optionalData"), parsed.optionalData || "—"],
      ]
    : [];

  return (
    <section className="mrz-debug notranslate" translate="no" aria-label={t("debug.mrz.title")}>
      <h2>{t("debug.mrz.title")}</h2>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      {parsed && (
        <>
          <h3>{t("debug.mrz.checks")}</h3>
          <ul className="mrz-checks">
            {CHECKS.map((key) => {
              const ok = parsed.checks[key];
              if (ok === undefined) return null;
              return (
                <li key={key}>
                  {mark(ok)} {t(`debug.mrz.check.${key}`)}
                </li>
              );
            })}
          </ul>
          <h3>{t("debug.mrz.fields")}</h3>
          <dl>
            {fields.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}

      <h3>{t("debug.mrz.lines")}</h3>
      <pre className="mrz-lines">{read.lines?.join("\n") || "—"}</pre>
      <h3>{t("debug.mrz.raw")}</h3>
      <pre className="mrz-lines">{read.rawText || "—"}</pre>
    </section>
  );
}

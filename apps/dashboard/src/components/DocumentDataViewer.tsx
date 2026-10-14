import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { type DocumentDataItem, parseMrz } from "@verify/shared";
import { formatCalendarDate, formatDateTime, toLanguage } from "../lib/format";
import { formatMrzFormat, type MrzFieldValue, mrzFields } from "../lib/mrz";
import { Countdown } from "./Countdown";

export interface OpenDocumentData {
  /** From POST /admin/document-data. Held in React state only: never in Web Storage, never logged. */
  items: DocumentDataItem[];
  /** When the page must stop showing it (client clock). */
  deadlineMs: number;
}

/**
 * Shows the data read from the document (the MRZ lines and the fields parsed from them) and removes
 * it when its time is up, like PhotoViewer: the data lives only in the parent's state and in this
 * component, and leaves the page when the time is up, on Hide, and when the case page goes away
 * (another page, or sign-out). translate="no" keeps the browser's page translation, which sends the
 * text to an online service, away from it.
 */
export function DocumentDataViewer({
  data,
  sideLabel,
  onExpire,
  onClose,
}: {
  data: OpenDocumentData;
  /** Name of the side a capture shows ("Back"), or null when that photo is not on the page. */
  sideLabel: (captureId: string) => string | null;
  onExpire: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  // Parsed here, from the lines the server returned: the same parser as on the phone and the server.
  const items = useMemo(() => data.items.map((item) => ({ item, parsed: parseMrz(item.lines) })), [data]);
  // Only new data restarts the timer, not a re-render with a fresh onExpire closure.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const id = window.setTimeout(() => onExpireRef.current(), Math.max(0, data.deadlineMs - Date.now()));
    return () => window.clearTimeout(id);
  }, [data]);

  function fieldText(value: MrzFieldValue): string {
    switch (value.type) {
      case "text":
        return value.text || "—";
      case "sex":
        return value.sex ? t(`mrz.sex.${value.sex}`) : "—";
      case "date":
        if (value.date.iso) return formatCalendarDate(value.date.iso, lang);
        return value.date.raw ? t("mrz.invalidDate", { raw: value.date.raw }) : "—";
    }
  }

  return (
    <div className="dash-mrz-data" translate="no">
      {items.length === 0 ? (
        <p className="muted">{t("mrz.noData")}</p>
      ) : (
        <ul className="dash-captures">
          {items.map(({ item, parsed }) => {
            const side = sideLabel(item.captureId) ?? t("mrz.unknownSide");
            return (
              <li key={`${item.captureId}.${item.source}`}>
                <article className="dash-capture" aria-label={t("mrz.dataOf", { side })}>
                  <header className="dash-capture-head">
                    <h3>{t("mrz.dataOf", { side })}</h3>
                    <span className="badge neutral">{formatMrzFormat(item.format)}</span>
                  </header>
                  <p className="muted dash-small">{t("mrz.recordedAt", { time: formatDateTime(item.recordedAt, lang) })}</p>
                  {parsed ? (
                    <dl className="dash-facts compact">
                      {mrzFields(parsed).map(({ key, value }) => (
                        <div key={key}>
                          <dt>{t(`mrz.fields.${key}`)}</dt>
                          <dd>{fieldText(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="dash-alert info">{t("mrz.unparsable")}</p>
                  )}
                  <figure className="dash-mrz-raw">
                    <figcaption className="muted dash-small">{t("mrz.rawLines")}</figcaption>
                    <pre className="mono dash-mrz-lines">{item.lines.join("\n")}</pre>
                  </figure>
                </article>
              </li>
            );
          })}
        </ul>
      )}
      <div className="dash-mrz-data-foot">
        <Countdown deadlineMs={data.deadlineMs} runningKey="mrz.dataExpiresIn" expiredKey="mrz.dataExpired" />
        <button type="button" className="small" onClick={onClose}>
          {t("mrz.hideData")}
        </button>
      </div>
    </div>
  );
}

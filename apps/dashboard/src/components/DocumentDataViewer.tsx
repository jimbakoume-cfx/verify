import { Fragment, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  type DocumentDataFieldsItem,
  type DocumentDataItem,
  type DocumentDataLinesItem,
  type Language,
  parseMrz,
} from "@verify/shared";
import { counterpartLines, lineDifferences, orderDataItems, type PrintedValue, printedFields } from "../lib/documentData";
import { formatCalendarDate, formatDateTime, toLanguage } from "../lib/format";
import { formatMrzFormat, type MrzFieldValue, mrzFields } from "../lib/mrz";
import { ProvisionalBadge } from "./Checks";
import { Countdown } from "./Countdown";

export interface OpenDocumentData {
  /** From POST /admin/document-data. Held in React state only: never in Web Storage, never logged. */
  items: DocumentDataItem[];
  /** When the page must stop showing it (client clock). */
  deadlineMs: number;
}

/**
 * Shows the data read from the document and removes it when its time is up, like PhotoViewer: the
 * code lines read on the phone and by the server (with the fields parsed from them), and the printed
 * text read by the server, the card's sub-type included. The data lives only in the parent's state
 * and in this component, and leaves the page when the time is up, on Hide, and when the case page
 * goes away (another page, or sign-out). translate="no" (and Google's "notranslate" class) keeps the
 * browser's page translation, which sends the text to an online service, away from it.
 */
export function DocumentDataViewer({
  data,
  kindOf,
  onExpire,
  onClose,
}: {
  data: OpenDocumentData;
  /** Capture kind of a photo ("document_back"), or null when that photo is not on the page. */
  kindOf: (captureId: string) => string | null;
  onExpire: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = toLanguage(i18n.language);
  const items = useMemo(() => orderDataItems(data.items, kindOf), [data, kindOf]);
  // Only new data restarts the timer, not a re-render with a fresh onExpire closure.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const id = window.setTimeout(() => onExpireRef.current(), Math.max(0, data.deadlineMs - Date.now()));
    return () => window.clearTimeout(id);
  }, [data]);

  const sideOf = (captureId: string) => {
    const kind = kindOf(captureId);
    return kind ? t(`kinds.${kind}`, { defaultValue: kind }) : t("mrz.unknownSide");
  };

  return (
    <div className="dash-mrz-data notranslate" translate="no">
      {items.length === 0 ? (
        <p className="muted">{t("data.none")}</p>
      ) : (
        <ul className="dash-captures">
          {items.map((item) => (
            <li key={`${item.captureId}.${item.source}`}>
              {item.source === "ocr_server" ? (
                <PrintedItem item={item} side={sideOf(item.captureId)} lang={lang} />
              ) : (
                <LinesItem
                  item={item}
                  counterpart={counterpartLines(item, data.items)}
                  side={sideOf(item.captureId)}
                  lang={lang}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="dash-mrz-data-foot">
        <Countdown deadlineMs={data.deadlineMs} runningKey="data.expiresIn" expiredKey="data.expired" />
        <button type="button" className="small" onClick={onClose}>
          {t("data.hide")}
        </button>
      </div>
    </div>
  );
}

/** Code lines, read on the phone or by the server, with the fields parsed from them. */
function LinesItem({
  item,
  counterpart,
  side,
  lang,
}: {
  item: DocumentDataLinesItem;
  /** The other reading of the same photo's lines: characters that differ from it are highlighted. */
  counterpart: DocumentDataLinesItem | null;
  side: string;
  lang: Language;
}) {
  const { t } = useTranslation();
  // Parsed here, from the lines the server returned: the same parser as on the phone and the server.
  const parsed = useMemo(() => parseMrz(item.lines), [item]);
  const differences = useMemo(() => lineDifferences(item.lines, counterpart?.lines ?? null), [item, counterpart]);
  const differs = differences.some((row) => row.some(Boolean));
  const title = t(`data.linesOf.${item.source}`, { side });

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
    <article className="dash-capture" aria-label={title}>
      <header className="dash-capture-head">
        <h3>{title}</h3>
        <span className="dash-row-badges">
          <span className="badge neutral">{formatMrzFormat(item.format)}</span>
          {counterpart && (
            <span className={`badge ${differs ? "bad" : "ok"}`}>
              {t(differs ? `data.differs.${item.source}` : `data.same.${item.source}`)}
            </span>
          )}
        </span>
      </header>
      <p className="muted dash-small">{t("data.recordedAt", { time: formatDateTime(item.recordedAt, lang) })}</p>
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
        <figcaption className="muted dash-small">
          {t(`data.rawLines.${item.source}`)}
          {differs && ` ${t("data.differencesMarked")}`}
        </figcaption>
        <pre className="mono dash-mrz-lines">
          {item.lines.map((line, row) => (
            <Fragment key={row}>
              {row > 0 && "\n"}
              {differs ? <MarkedLine line={line} marks={differences[row]} /> : line}
            </Fragment>
          ))}
        </pre>
      </figure>
    </article>
  );
}

/** A line with the characters that differ from the other reading wrapped in <mark>. */
function MarkedLine({ line, marks }: { line: string; marks: boolean[] }) {
  // Runs of equal marking, so a long run of matching characters stays one text node.
  const runs: { text: string; marked: boolean }[] = [];
  [...line].forEach((char, i) => {
    const last = runs[runs.length - 1];
    if (last && last.marked === marks[i]) last.text += char;
    else runs.push({ text: char, marked: marks[i] });
  });
  return (
    <>
      {runs.map((run, i) => (run.marked ? <mark key={i}>{run.text}</mark> : <Fragment key={i}>{run.text}</Fragment>))}
    </>
  );
}

/** Printed text read by the server: provisional until tuned on real documents. */
function PrintedItem({ item, side, lang }: { item: DocumentDataFieldsItem; side: string; lang: Language }) {
  const { t } = useTranslation();
  const fields = useMemo(() => printedFields(item.fields), [item]);
  const title = t("data.printedOf", { side });

  function valueText(value: PrintedValue): string {
    switch (value.type) {
      case "text":
        return value.text || "—";
      case "date":
        return formatCalendarDate(value.iso, lang);
      case "partialDate":
        return value.raw ? t("data.partialDate", { raw: value.raw }) : "—";
      case "subtype":
        return value.subtype ? t(`data.subtypes.${value.subtype}`) : value.raw || "—";
    }
  }

  return (
    <article className="dash-capture" aria-label={title}>
      <header className="dash-capture-head">
        <h3>{title}</h3>
        <ProvisionalBadge />
      </header>
      <p className="muted dash-small">{t("data.recordedAt", { time: formatDateTime(item.recordedAt, lang) })}</p>
      <p className="muted dash-small">{t("data.printedNote")}</p>
      {fields.length === 0 ? (
        <p className="dash-alert info">{t("data.printedNone")}</p>
      ) : (
        <dl className="dash-facts compact">
          {fields.map(({ key, value }) => (
            <div key={key}>
              <dt>{t(`data.fields.${key}`)}</dt>
              <dd>{valueText(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

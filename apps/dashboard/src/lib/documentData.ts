// How "Show data read" lays out what POST /admin/document-data returns: code lines read on the phone
// and by the server, and the printed fields read by the server. Pure functions over data that lives
// in memory only (see DocumentDataViewer): nothing here stores or logs it.
import {
  CAPTURE_SIDES,
  CARD_SUBTYPES,
  type CardSubtype,
  type DocumentDataItem,
  type DocumentDataLinesItem,
  type WorkerFields,
} from "@verify/shared";
import { PRINTED_FIELDS } from "./records";

const SOURCE_ORDER: Record<DocumentDataItem["source"], number> = { mrz_phone: 0, mrz_server: 1, ocr_server: 2 };

/**
 * Grouped by photo side (front, back, then photos not on the page), then phone lines, server lines and
 * printed text, so the two readings of the same code lines sit together; newest first within that.
 */
export function orderDataItems(
  items: readonly DocumentDataItem[],
  kindOf: (captureId: string) => string | null,
): DocumentDataItem[] {
  const sideRank = (item: DocumentDataItem) => {
    const i = (CAPTURE_SIDES as readonly (string | null)[]).indexOf(kindOf(item.captureId));
    return i < 0 ? CAPTURE_SIDES.length : i;
  };
  return [...items].sort(
    (a, b) =>
      sideRank(a) - sideRank(b) ||
      a.captureId.localeCompare(b.captureId) ||
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      b.recordedAt.localeCompare(a.recordedAt),
  );
}

/** The other reading of the same photo's code lines (the server's for the phone's, and back), if any. */
export function counterpartLines(
  item: DocumentDataLinesItem,
  items: readonly DocumentDataItem[],
): DocumentDataLinesItem | null {
  const other = item.source === "mrz_phone" ? "mrz_server" : "mrz_phone";
  const found = items.find((i) => i.captureId === item.captureId && i.source === other);
  return found && found.source !== "ocr_server" ? found : null;
}

/**
 * For each character of `lines`, whether it differs from the character at the same place in `other`
 * (a missing character counts as different). All false without anything to compare with.
 */
export function lineDifferences(lines: readonly string[], other: readonly string[] | null): boolean[][] {
  return lines.map((line, row) => [...line].map((char, col) => other !== null && other[row]?.[col] !== char));
}

/**
 * Card families the worker reads from a residence card's printed title (CARD_SUBTYPES in contract.ts).
 * Sensitive: shown only here, never in check_result or the audit log.
 */
export const KNOWN_SUBTYPES = CARD_SUBTYPES;
export type KnownSubtype = CardSubtype;

export type PrintedValue =
  | { type: "text"; text: string }
  | { type: "date"; iso: string }
  /** A date the worker could not complete (e.g. month and year only), as printed. */
  | { type: "partialDate"; raw: string }
  /** `subtype` is null for a value this dashboard cannot name; `raw` is then shown as it is. */
  | { type: "subtype"; subtype: KnownSubtype | null; raw: string };

const DATE_FIELDS: readonly (keyof WorkerFields)[] = ["birthDate", "expiryDate", "issueDate"];

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** The printed fields read, in the order staff compare them with the photo; fields not read are left out. */
export function printedFields(fields: WorkerFields): { key: keyof WorkerFields; value: PrintedValue }[] {
  return PRINTED_FIELDS.flatMap((key) => {
    const raw = fields[key];
    if (raw === undefined) return [];
    let value: PrintedValue = { type: "text", text: raw };
    if (key === "subtype") {
      const known = (KNOWN_SUBTYPES as readonly string[]).includes(raw) ? (raw as KnownSubtype) : null;
      value = { type: "subtype", subtype: known, raw };
    } else if (DATE_FIELDS.includes(key)) {
      value = isCalendarDate(raw) ? { type: "date", iso: raw } : { type: "partialDate", raw };
    }
    return [{ key, value }];
  });
}

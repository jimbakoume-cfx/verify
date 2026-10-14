// What the case page shows about the MRZ ("code lines"): one entry per check result, plus "not
// received" when the phone sent nothing for the photo that should carry the MRZ. Pure functions, so
// the rules are tested without rendering.
import {
  type CaptureSide,
  type DeclaredDocument,
  MRZ_EXPECTATION,
  MRZ_LAYOUT,
  type MrzCheckDetails,
  type MrzDate,
  type MrzExpectation,
  type MrzFormat,
  type ParsedMrz,
} from "@verify/shared";
import type { CaptureRecord, MrzCheckRecord } from "./records";

export type MrzEntry =
  | {
      type: "check";
      check: MrzCheckRecord;
      /** Capture kind of the photo the check ran on; null when that photo is not in the list. */
      kind: string | null;
      capturedAt: string | null;
      /** A newer photo of the same side replaced this one. */
      superseded: boolean;
    }
  | {
      type: "missing";
      side: CaptureSide;
      /** Latest photo of the side, which has no result; null when there is no photo of it yet. */
      captureId: string | null;
      capturedAt: string | null;
    };

export interface MrzOverview {
  /** Where the MRZ should be for the declared document; null when it has none or none is chosen. */
  expectation: MrzExpectation | null;
  entries: MrzEntry[];
  /** Some result holds lines that "Show data read" can reveal (an unreadable MRZ stores none). */
  hasData: boolean;
}

/** Latest photo still holding an image, per capture kind. */
function latestLiveCaptures(captures: readonly CaptureRecord[]): Map<string, CaptureRecord> {
  const latest = new Map<string, CaptureRecord>();
  for (const capture of captures) {
    if (capture.deleted) continue;
    const current = latest.get(capture.kind);
    if (!current || capture.createdAt > current.createdAt) latest.set(capture.kind, capture);
  }
  return latest;
}

/**
 * Entries of the "Code lines (MRZ)" section, `checks` latest first. "Not received" comes first when
 * the document has an MRZ and the latest photo of its side (or the side, when it has no photo yet)
 * has no result: the phone reports every reading, failed ones included, so a gap means the report
 * was lost or the rider has not uploaded that side yet.
 */
export function mrzOverview(
  declared: DeclaredDocument | null,
  captures: readonly CaptureRecord[],
  checks: readonly MrzCheckRecord[],
): MrzOverview {
  const expectation = declared ? MRZ_EXPECTATION[declared] : null;
  const byId = new Map(captures.map((c) => [c.id, c]));
  const latest = latestLiveCaptures(captures);

  const entries: MrzEntry[] = checks.map((check) => {
    const capture = check.captureId ? byId.get(check.captureId) : undefined;
    const newest = capture ? latest.get(capture.kind) : undefined;
    return {
      type: "check",
      check,
      kind: capture?.kind ?? null,
      capturedAt: capture?.createdAt ?? null,
      superseded: newest !== undefined && newest.id !== capture?.id,
    };
  });

  if (expectation) {
    const current = latest.get(expectation.side);
    const received = current
      ? checks.some((c) => c.captureId === current.id)
      : entries.some((e) => e.type === "check" && e.kind === expectation.side);
    if (!received) {
      entries.unshift({
        type: "missing",
        side: expectation.side,
        captureId: current?.id ?? null,
        capturedAt: current?.createdAt ?? null,
      });
    }
  }

  return { expectation, entries, hasData: checks.some((c) => c.details?.result !== "unreadable") };
}

/** One ✅/❌ line; `ok` is null when the result does not say (shown as "—"). */
export interface MrzCheckLine {
  /** i18n key of the label. */
  key: string;
  ok: boolean | null;
}

/**
 * The ✅/❌ lines of a result whose lines were read: the format, each check digit as recomputed by
 * the server, the document code and the dates. The personal number has a check digit on passports
 * (TD3) only. Nothing for an unreadable MRZ: there was nothing to check.
 */
export function mrzCheckLines(details: MrzCheckDetails): MrzCheckLine[] {
  if (details.result !== "read") return [];
  const c = details.checks;
  const lines: MrzCheckLine[] = [
    { key: "mrz.checks.format", ok: details.format === null ? null : details.format === details.expectedFormat },
    { key: "mrz.checks.documentNumber", ok: c?.documentNumber ?? null },
    { key: "mrz.checks.birthDate", ok: c?.birthDate ?? null },
    { key: "mrz.checks.expiryDate", ok: c?.expiryDate ?? null },
  ];
  if (details.format === "TD3" || c?.personalNumber !== undefined) {
    lines.push({ key: "mrz.checks.personalNumber", ok: c?.personalNumber ?? null });
  }
  lines.push(
    { key: "mrz.checks.composite", ok: c?.composite ?? null },
    { key: "mrz.checks.documentCode", ok: details.documentCodeFits },
    { key: "mrz.checks.dates", ok: details.datesValid },
  );
  return lines;
}

/** "TD1 (3 × 30)": the format and its shape, for staff who do not know the ICAO names. */
export function formatMrzFormat(format: MrzFormat | null): string {
  if (!format) return "—";
  const { lines, length } = MRZ_LAYOUT[format];
  return `${format} (${lines} × ${length})`;
}

export type MrzFieldKey =
  | "surname"
  | "givenNames"
  | "documentNumber"
  | "nationality"
  | "birthDate"
  | "sex"
  | "expiryDate"
  | "issuingState"
  | "documentCode"
  | "optionalData";

export type MrzFieldValue =
  | { type: "text"; text: string }
  | { type: "date"; date: MrzDate }
  | { type: "sex"; sex: ParsedMrz["sex"] };

/** Fields parsed from the lines, in the order staff compare them with the photo. */
export function mrzFields(parsed: ParsedMrz): { key: MrzFieldKey; value: MrzFieldValue }[] {
  const text = (value: string): MrzFieldValue => ({ type: "text", text: value });
  return [
    { key: "surname", value: text(parsed.surname) },
    { key: "givenNames", value: text(parsed.givenNames) },
    { key: "documentNumber", value: text(parsed.documentNumber) },
    { key: "nationality", value: text(parsed.nationality) },
    { key: "birthDate", value: { type: "date", date: parsed.birthDate } },
    { key: "sex", value: { type: "sex", sex: parsed.sex } },
    { key: "expiryDate", value: { type: "date", date: parsed.expiryDate } },
    { key: "issuingState", value: text(parsed.issuingState) },
    { key: "documentCode", value: text(parsed.documentCode) },
    { key: "optionalData", value: text(parsed.optionalData) },
  ];
}

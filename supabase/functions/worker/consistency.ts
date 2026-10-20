// Consistency checks (M4): the document compared with itself and with today's date. Pure: no I/O, so
// each rule is tested with tables (consistency.test.ts). Decided by the worker Edge Function with the
// other case-level checks, from the newest live photo of each side the declared document needs.
//
// Firm vs provisional, as in M3. Code lines are firm only when every check digit is right and both
// dates are real; then they are the source of the birth and expiry dates and of the number. Printed
// text (the AI worker's OCR, on layouts not yet seen on real cards) is provisional: what depends on it
// goes into `provisional`, never into `flags`, with two exceptions decided by the PM (2026-10-15):
// a printed birth date under 18 is a flag, and a printed number or date that disagrees with firm code
// lines is a flag (the code lines are the firm side of that comparison). A printed NAME that disagrees
// is provisional only (fixes after the PM's first real test, 2026-10-20: OCR on real cards is not tuned).
//
// Privacy: the inputs are values read from the document (decrypted by the database for this decision
// only); the result holds generic codes only. Never a value, never which value disagreed.
import {
  type CaptureSide,
  CONSISTENCY_TIME_ZONE,
  type ConsistencyDetails,
  type ConsistencyFlag,
  CONSISTENCY_FLAGS,
  type DeclaredDocument,
  MISMATCH_KINDS,
  type MismatchKind,
  MRZ_EXPECTATION,
  type WorkerFields,
} from "../_shared/contract.ts";
import { type ParsedMrz, parseMrz } from "../_shared/mrz.ts";
import { compareDate, compareNames, compareNumber, printedDate } from "./compare.ts";

/** Age below which the holder is flagged (under_18). */
export const ADULT_AGE = 18;

/**
 * The longest validity accepted between issue and expiry (date_logic). Cameroonian CNIs and passports
 * are valid 10 and 5 years; 15 leaves room for other states' passports and for misread years.
 */
export const MAX_VALIDITY_YEARS = 15;

/**
 * The format of the document number, per declared document. Guesses until real cards are seen (Q7):
 * `confirmed: false` keeps a mismatch provisional (never a flag). Passports and the new cards' numbers
 * are checked by their code lines' check digits already; driving licences and voter cards have no
 * known format.
 */
export const NUMBER_FORMATS: Partial<Record<DeclaredDocument, { pattern: RegExp; confirmed: boolean }>> = {
  // The 2017 card: 9 digits on our specimens and in public samples.
  cni_legacy: { pattern: /^[0-9]{9}$/, confirmed: false },
  // The 2025 card: 9 letters or digits fit its code lines' number field without the long-number form.
  cni_biometric: { pattern: /^[A-Z0-9]{9}$/, confirmed: false },
  // Residence permits and refugee cards, old and new: letters and digits, 6 to 12.
  residence_permit: { pattern: /^[A-Z0-9]{6,12}$/, confirmed: false },
};

/** What the database returns for one photo (worker_case_snapshot.documentData), decrypted. */
export interface SideDocumentData {
  kind: CaptureSide;
  captureId: string;
  /** The server's code lines (mrz_server), only on the side that carries them; null when not read. */
  mrzLines: string[] | null;
  /** The printed fields (ocr_server), never the card sub-type; null when none were read. */
  fields: WorkerFields | null;
}

export interface ConsistencyDecision {
  /** flag: some flag. skipped: nothing to compare. pass: no flag (provisional codes may be shown). */
  outcome: "pass" | "flag" | "skipped";
  details: ConsistencyDetails;
}

/** The date in Douala (YYYY-MM-DD) at `now`: "today" for expiry and age. */
export function doualaDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CONSISTENCY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** `iso` plus `years` (29 February becomes 1 March in other years). */
export function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

/** The code lines' name field is full to its last character, so the names may be cut short. */
export function nameFieldFull(lines: readonly string[]): boolean {
  const field = lines.length === 2 ? lines[0].slice(5) : lines[2] ?? "";
  return field.length > 0 && !field.endsWith("<");
}

interface Dated {
  iso: string;
  firm: boolean;
}

/** The printed fields of the sides, front first: the back only adds what the front lacks. */
function mergeFields(sides: readonly SideDocumentData[]): WorkerFields {
  const merged: WorkerFields = {};
  const ordered = [...sides].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "document_front" ? -1 : 1));
  for (const side of ordered) {
    for (const [key, value] of Object.entries(side.fields ?? {}) as [keyof WorkerFields, string][]) {
      if (key !== "subtype" && typeof value === "string" && value !== "" && merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

/**
 * The consistency of a case from its photos' data. `sides`: the newest live photo of each side the
 * declared document needs. The code lines count only on the side the declared document carries them.
 */
export function decideConsistency(
  declared: DeclaredDocument | null,
  sides: readonly SideDocumentData[],
  now: Date,
): ConsistencyDecision {
  const today = doualaDate(now);
  const expectation = declared ? MRZ_EXPECTATION[declared] : null;
  const lines = expectation ? sides.find((s) => s.kind === expectation.side)?.mrzLines ?? null : null;
  const parsed: ParsedMrz | null = lines ? parseMrz(lines, now) : null;
  const firm = parsed !== null && parsed.valid && parsed.datesValid ? parsed : null;
  const fields = mergeFields(sides);

  const flags = new Set<ConsistencyFlag>();
  const provisional = new Set<ConsistencyFlag>();
  const mismatches = new Set<MismatchKind>();
  const flag = (code: ConsistencyFlag, isFirm: boolean) => (isFirm ? flags : provisional).add(code);

  const fromPrint = (value: string | undefined, kind: "birth" | "expiry" | "issue"): Dated | null => {
    const iso = printedDate(value, kind, today);
    return iso ? { iso, firm: false } : null;
  };
  const birth: Dated | null = firm ? { iso: firm.birthDate.iso!, firm: true } : fromPrint(fields.birthDate, "birth");
  const expiry: Dated | null = firm ? { iso: firm.expiryDate.iso!, firm: true } : fromPrint(fields.expiryDate, "expiry");
  // The code lines carry no issue date: it is always printed.
  const issue = fromPrint(fields.issueDate, "issue");

  // Expired: firm from the code lines (the rider is told), provisional from print (staff only).
  if (expiry && expiry.iso < today) flag("document_expired", expiry.firm);

  // Under 18: a flag whatever its source (PM decision); `basis` tells staff where it came from.
  if (birth && addYears(birth.iso, ADULT_AGE) > today) flags.add("under_18");

  // Printed fields against firm code lines.
  if (firm && lines) {
    if (compareNames(fields, firm, nameFieldFull(lines)) === "disagree") mismatches.add("name");
    if (compareNumber(fields.documentNumber, firm.documentNumber) === "disagree") mismatches.add("number");
    if (compareDate(fields.birthDate, firm.birthDate.iso, "birth", today) === "disagree") mismatches.add("birth_date");
    if (compareDate(fields.expiryDate, firm.expiryDate.iso, "expiry", today) === "disagree") mismatches.add("expiry_date");
    // Fixes after the PM's first real test (2026-10-20): printed text is read by OCR, so a name that
    // differs is a provisional note for staff; a number or a date that differs stays a firm flag.
    if ([...mismatches].some((kind) => kind !== "name")) flags.add("mrz_print_mismatch");
    else if (mismatches.size > 0) provisional.add("mrz_print_mismatch");
  }

  // Date logic: firm only when every date a rule uses is firm (only birth against expiry can be).
  const todayDated: Dated = { iso: today, firm: true };
  const rules: [Dated | null, Dated | null, (a: string, b: string) => boolean][] = [
    [birth, expiry, (a, b) => a < b],
    [birth, issue, (a, b) => a < b],
    [issue, expiry, (a, b) => a < b],
    [issue, todayDated, (a, b) => a <= b],
    [birth, todayDated, (a, b) => a <= b],
    [expiry, issue, (a, b) => a <= addYears(b, MAX_VALIDITY_YEARS)],
  ];
  for (const [a, b, holds] of rules) {
    if (a && b && !holds(a.iso, b.iso)) flag("date_logic", a.firm && b.firm);
  }

  // Number format, where one is known for the declared document.
  const format = declared ? NUMBER_FORMATS[declared] : undefined;
  const number = firm ? firm.documentNumber.replace(/\s+/g, "") : fields.documentNumber?.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (format && number && !format.pattern.test(number)) flag("number_format", format.confirmed && firm !== null);

  const basis: ConsistencyDetails["basis"] = firm ? "mrz" : Object.keys(fields).length > 0 ? "printed" : "none";
  // A flag already raised firmly is not repeated as provisional.
  for (const code of flags) provisional.delete(code);
  const details: ConsistencyDetails = {
    // In the contract's order, so the stored details do not depend on the order of the rules.
    flags: CONSISTENCY_FLAGS.filter((code) => flags.has(code)),
    provisional: CONSISTENCY_FLAGS.filter((code) => provisional.has(code)),
    basis,
    mismatches: MISMATCH_KINDS.filter((kind) => mismatches.has(kind)),
  };
  return { outcome: details.flags.length > 0 ? "flag" : basis === "none" ? "skipped" : "pass", details };
}

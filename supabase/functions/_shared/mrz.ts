// ICAO 9303 machine-readable zone (MRZ): check digits and parsing of TD1 (ID-1 cards, 3 x 30) and
// TD3 (passports, 2 x 44). Written by us (the popular parsers are GPL or add dependencies).
// The same file runs on the rider's phone (instant feedback, via @verify/shared) and in the Edge
// Functions (the authoritative check), so both always agree. Dependency-free: no imports.
// References: ICAO Doc 9303 Part 3 (check digits, dates), Part 4 (TD3), Part 5 (TD1).

/** Bump when the parsing or check rules change: stored with every check result. */
export const MRZ_PARSER_VERSION = "mrz-v1";

export type MrzFormatName = "TD1" | "TD3";

const LAYOUT: Record<MrzFormatName, { lines: number; length: number }> = {
  TD1: { lines: 3, length: 30 },
  TD3: { lines: 2, length: 44 },
};

const LINE_RE = /^[A-Z0-9<]+$/;

/** Value of one MRZ character: digits 0-9, A-Z 10-35, filler '<' 0. NaN for anything else. */
export function mrzCharValue(char: string): number {
  const code = char.charCodeAt(0);
  if (char.length !== 1) return Number.NaN;
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 55;
  if (char === "<") return 0;
  return Number.NaN;
}

/** ICAO 9303 check digit: weights 7, 3, 1 repeating, sum modulo 10. NaN on an invalid character. */
export function checkDigit(field: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    sum += mrzCharValue(field[i]) * weights[i % 3];
  }
  return sum % 10;
}

/** True when `digit` is the check digit of `field`. Only a digit 0-9 is accepted. */
export function checkDigitMatches(field: string, digit: string): boolean {
  return /^[0-9]$/.test(digit) && checkDigit(field) === Number(digit);
}

/** Format of a set of lines, or null when they are not exactly a TD1 or TD3 MRZ. */
export function detectMrzFormat(lines: readonly string[]): MrzFormatName | null {
  for (const format of ["TD1", "TD3"] as const) {
    const { lines: count, length } = LAYOUT[format];
    if (lines.length === count && lines.every((line) => line.length === length && LINE_RE.test(line))) {
      return format;
    }
  }
  return null;
}

export interface MrzDate {
  /** YYMMDD as printed; may contain '<' for an unknown part. */
  raw: string;
  /** YYYY-MM-DD when the date is complete and real, otherwise null. */
  iso: string | null;
}

export interface MrzChecks {
  documentNumber: boolean;
  birthDate: boolean;
  expiryDate: boolean;
  /** TD3 only: the personal number has its own check digit. TD1 optional data has none. */
  personalNumber?: boolean;
  composite: boolean;
}

export interface ParsedMrz {
  format: MrzFormatName;
  /** "P", "PM", "I", "ID", "AC"... (fillers removed). */
  documentCode: string;
  issuingState: string;
  documentNumber: string;
  nationality: string;
  birthDate: MrzDate;
  sex: "M" | "F" | "X" | null;
  expiryDate: MrzDate;
  /** TD3: personal number. TD1: optional data of lines 1 and 2 (after any long document number). */
  optionalData: string;
  surname: string;
  givenNames: string;
  checks: MrzChecks;
  /** Every check digit is correct. */
  valid: boolean;
  /** Birth and expiry dates are complete, real calendar dates. */
  datesValid: boolean;
}

/**
 * Parses a TD1 or TD3 MRZ. Returns null when the lines are not exactly one of those formats
 * (count, length, characters). Never corrects anything: correction is the phone's job, and the
 * server must judge exactly what it was sent.
 * `today` decides the century of the birth date (never in the future) and of the expiry date.
 */
export function parseMrz(lines: readonly string[], today: Date = new Date()): ParsedMrz | null {
  const format = detectMrzFormat(lines);
  if (format === "TD3") return parseTd3(lines, today);
  if (format === "TD1") return parseTd1(lines, today);
  return null;
}

/** Document codes that fit each format: passports start with P; TD1 cards with I, A or C. */
export function documentCodeFits(format: MrzFormatName, documentCode: string): boolean {
  return format === "TD3" ? /^P/.test(documentCode) : /^[IAC]/.test(documentCode);
}

function parseTd3(lines: readonly string[], today: Date): ParsedMrz {
  const [l1, l2] = lines;
  const documentNumberField = l2.slice(0, 9);
  const birthField = l2.slice(13, 19);
  const expiryField = l2.slice(21, 27);
  const personalField = l2.slice(28, 42);
  const personalDigit = l2[42];
  const checks: MrzChecks = {
    documentNumber: checkDigitMatches(documentNumberField, l2[9]),
    birthDate: checkDigitMatches(birthField, l2[19]),
    expiryDate: checkDigitMatches(expiryField, l2[27]),
    // An empty personal number may carry '<' as its check digit (Part 4, 4.2.2.2).
    personalNumber: isFiller(personalField) && personalDigit === "<"
      ? true
      : checkDigitMatches(personalField, personalDigit),
    composite: checkDigitMatches(l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43), l2[43]),
  };
  const { surname, givenNames } = parseName(l1.slice(5, 44));
  return finish({
    format: "TD3",
    documentCode: stripFillers(l1.slice(0, 2)),
    issuingState: stripFillers(l1.slice(2, 5)),
    documentNumber: stripFillers(documentNumberField),
    nationality: stripFillers(l2.slice(10, 13)),
    birthDate: parseDate(birthField, "birth", today),
    sex: parseSex(l2[20]),
    expiryDate: parseDate(expiryField, "expiry", today),
    optionalData: stripFillers(personalField),
    surname,
    givenNames,
    checks,
  });
}

function parseTd1(lines: readonly string[], today: Date): ParsedMrz {
  const [l1, l2, l3] = lines;
  const optional1 = l1.slice(15, 30);
  let documentNumber = l1.slice(5, 14);
  let documentNumberDigit = l1[14];
  let optionalData = optional1;
  // Long document numbers (Part 5, 4.2.4): the first 9 characters, a filler instead of the check
  // digit, then the rest at the start of the optional data, ended by the check digit of the whole
  // number and a filler.
  if (documentNumberDigit === "<" && !isFiller(optional1)) {
    const end = optional1.indexOf("<");
    const tail = end === -1 ? optional1 : optional1.slice(0, end);
    if (tail.length >= 2) {
      documentNumber += tail.slice(0, -1);
      documentNumberDigit = tail[tail.length - 1];
      optionalData = end === -1 ? "" : optional1.slice(end);
    }
  }
  const birthField = l2.slice(0, 6);
  const expiryField = l2.slice(8, 14);
  const checks: MrzChecks = {
    documentNumber: checkDigitMatches(documentNumber, documentNumberDigit),
    birthDate: checkDigitMatches(birthField, l2[6]),
    expiryDate: checkDigitMatches(expiryField, l2[14]),
    composite: checkDigitMatches(l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29), l2[29]),
  };
  const { surname, givenNames } = parseName(l3);
  return finish({
    format: "TD1",
    documentCode: stripFillers(l1.slice(0, 2)),
    issuingState: stripFillers(l1.slice(2, 5)),
    documentNumber: stripFillers(documentNumber),
    nationality: stripFillers(l2.slice(15, 18)),
    birthDate: parseDate(birthField, "birth", today),
    sex: parseSex(l2[7]),
    expiryDate: parseDate(expiryField, "expiry", today),
    optionalData: [stripFillers(optionalData), stripFillers(l2.slice(18, 29))].filter(Boolean).join(" "),
    surname,
    givenNames,
    checks,
  });
}

function finish(parsed: Omit<ParsedMrz, "valid" | "datesValid">): ParsedMrz {
  return {
    ...parsed,
    valid: Object.values(parsed.checks).every(Boolean),
    datesValid: parsed.birthDate.iso !== null && parsed.expiryDate.iso !== null,
  };
}

function isFiller(field: string): boolean {
  return /^<*$/.test(field);
}

function stripFillers(field: string): string {
  return field.replace(/<+$/, "").replace(/</g, " ").trim();
}

function parseName(field: string): { surname: string; givenNames: string } {
  const trimmed = field.replace(/<+$/, "");
  const split = trimmed.indexOf("<<");
  const clean = (part: string) => part.replace(/</g, " ").replace(/\s+/g, " ").trim();
  if (split === -1) return { surname: clean(trimmed), givenNames: "" };
  return { surname: clean(trimmed.slice(0, split)), givenNames: clean(trimmed.slice(split + 2)) };
}

function parseSex(char: string): ParsedMrz["sex"] {
  return char === "M" || char === "F" || char === "X" ? char : null;
}

/**
 * YYMMDD to an ISO date. Birth dates take the latest century that is not in the future; expiry
 * dates are taken in this century unless that is more than 50 years ahead.
 */
function parseDate(raw: string, kind: "birth" | "expiry", today: Date): MrzDate {
  if (!/^[0-9]{6}$/.test(raw)) return { raw, iso: null };
  const yy = Number(raw.slice(0, 2));
  const month = Number(raw.slice(2, 4));
  const day = Number(raw.slice(4, 6));
  const thisYear = today.getUTCFullYear();
  let year = 2000 + yy;
  if (kind === "birth") {
    const candidate = Date.UTC(year, month - 1, day);
    if (candidate > today.getTime()) year -= 100;
  } else if (year > thisYear + 50) {
    year -= 100;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { raw, iso: null };
  }
  return { raw, iso: date.toISOString().slice(0, 10) };
}

// Tolerant comparison of a printed value with the code lines (M4), and the reading of printed dates.
// Pure and dependency-free, tested with many cases (compare.test.ts). Printed text comes from the AI
// worker's OCR and from documents whose layouts we have not seen yet, so the rules forgive what is
// not a real disagreement: accents, case, spaces and punctuation, the code lines' truncated names,
// OCR look-alikes in numbers, and the many ways of writing a date. A value that cannot be read is
// never a disagreement ("unknown"): only two readable values that differ are.

/** agree / disagree, or unknown when either side is missing or cannot be read. */
export type Agreement = "agree" | "disagree" | "unknown";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
/** Digits OCR reads for letters in a name (names have no digits). */
const NAME_LOOK_ALIKES: Record<string, string> = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z" };

/** ICAO 9303 transliterates these with two letters; a plain accent strip gives one. */
const TWO_LETTER: Record<string, string> = { "Ä": "AE", "Ö": "OE", "Ü": "UE", "Å": "AA" };

/** Letters that never decompose into a base letter plus an accent. */
const SPECIAL: Record<string, string> = { "Œ": "OE", "Æ": "AE", "ß": "SS", "Ø": "O", "Đ": "D", "Ł": "L", "Þ": "TH" };

/**
 * Upper case, accents dropped (or, with `icao`, Ä/Ö/Ü/Å spelt with two letters as ICAO does), then
 * only letters kept: spaces, hyphens, apostrophes, dots and the code lines' filler '<' disappear.
 */
export function normalizeName(value: string, icao = false): string {
  let text = value.toUpperCase();
  if (icao) text = text.replace(/[ÄÖÜÅ]/g, (ch) => TWO_LETTER[ch]);
  text = text.replace(/[ŒÆßØĐŁÞ]/g, (ch) => SPECIAL[ch]);
  text = text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  text = text.replace(/[0-9]/g, (ch) => NAME_LOOK_ALIKES[ch] ?? ch);
  return text.replace(/[^A-Z]/g, "");
}

/**
 * Words a printed layout writes beside the names ("NOM / SURNAME", "PRÉNOMS / GIVEN NAMES"...), which the
 * OCR may take into the value. Compared after normalizeName (accents dropped, upper case).
 */
const NAME_LABELS = new Set([
  "NOM", "NOMS", "SURNAME", "SURNAMES", "PRENOM", "PRENOMS", "GIVEN", "NAME", "NAMES", "GIVENNAMES",
  "FORENAME", "FORENAMES", "FIRSTNAME", "FIRSTNAMES", "LASTNAME", "NOMDEFAMILLE",
]);

/** The words of a name: split on spaces, hyphens, commas, slashes, fillers; apostrophes joined; labels dropped. */
export function nameTokens(value: string | null | undefined, icao = false): string[] {
  if (!value) return [];
  return value
    .replace(/['’`´]/g, "")
    .split(/[\s\-,;:/<.()]+/)
    .map((word) => normalizeName(word, icao))
    .filter((word) => word.length > 0 && !NAME_LABELS.has(word));
}

/** Levenshtein distance, stopping early above `limit`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/** One OCR misread letter is forgiven in a word of this many letters or more. */
export const NAME_OCR_TOLERANCE_MIN_LENGTH = 5;

/**
 * Two words (or runs of words joined) are the same name: equal, one OCR letter apart (two single long words only),
 * or, when `truncated` (the code lines' last word, cut short by a full name field), a prefix of it.
 */
function sameWord(word: string, other: string, truncated: boolean, fuzzy: boolean): boolean {
  if (word === other) return true;
  if (truncated && word.length > 0 && other.startsWith(word)) return true;
  return fuzzy && Math.min(word.length, other.length) >= NAME_OCR_TOLERANCE_MIN_LENGTH && editDistance(word, other, 1) <= 1;
}

/**
 * Whether every word of `part` is found in `whole`, each against a word of `whole` or several adjacent
 * words joined (OCR splits and merges words), in any order, each word of `whole` used once. A word of
 * `part` may also be several adjacent words of `part` joined. `truncatedLast`: the last word of `part` is
 * the code lines' last word, possibly cut short.
 */
function coveredBy(part: readonly string[], whole: readonly string[], truncatedLast = false): boolean {
  const used = new Array(whole.length).fill(false);
  const match = (i: number): boolean => {
    if (i >= part.length) return true;
    // A run of `part` words (1 to 3) against a run of `whole` words (1 to 3).
    for (let pLen = 1; pLen <= 3 && i + pLen <= part.length; pLen++) {
      const word = part.slice(i, i + pLen).join("");
      const truncated = truncatedLast && i + pLen === part.length;
      for (let start = 0; start < whole.length; start++) {
        for (let wLen = 1; wLen <= 3 && start + wLen <= whole.length; wLen++) {
          if (used.slice(start, start + wLen).some(Boolean)) break;
          if (!sameWord(word, whole.slice(start, start + wLen).join(""), truncated, pLen === 1 && wLen === 1)) continue;
          for (let k = start; k < start + wLen; k++) used[k] = true;
          if (match(i + pLen)) return true;
          for (let k = start; k < start + wLen; k++) used[k] = false;
        }
      }
    }
    return false;
  };
  return match(0);
}

/**
 * A printed name against the same name in the code lines, word by word (nameTokens). They agree when
 * every word of one is found in the other (in any order, OCR splits and merges and one misread letter
 * forgiven): a middle name printed but not in the code lines, or the other way round, still agrees.
 * `mrzFull`: the code lines' name field is full, so their last word may be cut short (ICAO truncation).
 */
export function compareName(printed: string | null | undefined, mrz: string | null | undefined, mrzFull: boolean): Agreement {
  const m = nameTokens(mrz);
  if (m.length === 0) return "unknown";
  for (const icao of [false, true]) {
    const p = nameTokens(printed, icao);
    if (p.length === 0) return "unknown";
    if (p.join("") === m.join("")) return "agree";
    if (coveredBy(m, p, mrzFull) || coveredBy(p, m)) return "agree";
    if (mrzFull && (p.join("").startsWith(m.join("")) || m.join("").startsWith(p.join("")))) return "agree";
  }
  return "disagree";
}

export interface NameParts {
  surname?: string | null;
  givenNames?: string | null;
}

/**
 * The printed names against the code lines' names. Printed text comes from OCR on layouts not yet seen
 * on real cards, so the fields may be swapped, split or merged differently, carry a label, miss a middle
 * name or misread a letter: the names agree when the surname is found among all the other side's names
 * and one side's names are all found in the other's (compareName's rules). Parts that are missing are
 * not compared; given names the code lines lost entirely to truncation (or a holder with none) neither.
 */
export function compareNames(printed: NameParts, mrz: { surname: string; givenNames: string }, mrzFull: boolean): Agreement {
  const surname = compareName(printed.surname, mrz.surname, mrzFull);
  const given = compareName(printed.givenNames, mrz.givenNames, mrzFull);
  if (surname !== "disagree" && given !== "disagree") return surname === "unknown" && given === "unknown" ? "unknown" : "agree";
  const all = (a?: string | null, b?: string | null) => [a ?? "", b ?? ""].join(" ");
  for (const icao of [false, true]) {
    const p = nameTokens(all(printed.surname, printed.givenNames), icao);
    const m = nameTokens(all(mrz.surname, mrz.givenNames));
    if (p.length === 0 || m.length === 0) continue;
    const mrzSurname = nameTokens(mrz.surname);
    const printedSurname = nameTokens(printed.surname, icao);
    // The surname is found among the other side's names (fields may be swapped or split differently).
    const surnameFound = (mrzSurname.length > 0 && coveredBy(mrzSurname, p, mrzFull && nameTokens(mrz.givenNames).length === 0)) ||
      (printedSurname.length > 0 && coveredBy(printedSurname, m));
    if (!surnameFound && printedSurname.length > 0) continue;
    if (p.join("") === m.join("") || coveredBy(m, p, mrzFull) || coveredBy(p, m)) return "agree";
  }
  return "disagree";
}

// ---------------------------------------------------------------------------
// Document numbers
// ---------------------------------------------------------------------------
/** OCR look-alikes in numbers, folded to one form on both sides: 0/O, 1/I, 5/S, 8/B, 2/Z. */
const NUMBER_FOLD: Record<string, string> = { O: "0", I: "1", S: "5", B: "8", Z: "2" };

/** Upper case without spaces, hyphens, dots, slashes or fillers, look-alikes folded. */
export function normalizeNumber(value: string): string {
  return value
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[OISBZ]/g, (ch) => NUMBER_FOLD[ch]);
}

export function compareNumber(printed: string | null | undefined, mrz: string | null | undefined): Agreement {
  if (!printed || !mrz) return "unknown";
  const p = normalizeNumber(printed);
  const m = normalizeNumber(mrz);
  if (p.length === 0 || m.length === 0) return "unknown";
  return p === m ? "agree" : "disagree";
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
export type DateKind = "birth" | "expiry" | "issue";

/** French and English month names and abbreviations, accents dropped. */
const MONTHS: Record<string, number> = {};
for (const [index, names] of [
  ["JAN", "JANV", "JANVIER", "JANUARY"],
  ["FEB", "FEV", "FEVR", "FEVRIER", "FEBRUARY"],
  ["MAR", "MARS", "MARCH"],
  ["APR", "AVR", "AVRIL", "APRIL"],
  ["MAY", "MAI"],
  ["JUN", "JUIN", "JUNE"],
  ["JUL", "JUIL", "JUILLET", "JULY"],
  ["AUG", "AOU", "AOUT", "AUGUST"],
  ["SEP", "SEPT", "SEPTEMBRE", "SEPTEMBER"],
  ["OCT", "OCTOBRE", "OCTOBER"],
  ["NOV", "NOVEMBRE", "NOVEMBER"],
  ["DEC", "DECEMBRE", "DECEMBER"],
].entries()) {
  for (const name of names) MONTHS[name] = index + 1;
}

/** YYYY-MM-DD of a real calendar date, or null. */
function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2099) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * A two-digit year: a birth year is never in the future (the latest century that fits, as the code
 * lines' parser does); any other year is in this century.
 */
function fullYear(yy: number, kind: DateKind, today: string): number {
  const year = 2000 + yy;
  return kind === "birth" && year > Number(today.slice(0, 4)) ? year - 100 : year;
}

/**
 * Every date a printed value may mean, as ISO dates: one, or two for a numeric date that reads both
 * day-first (as on Cameroonian documents) and month-first. Empty when nothing can be read, or a part
 * is unknown ("XX.03.1991"). `today` (YYYY-MM-DD) decides the century of two-digit years.
 */
export function readPrintedDate(value: string | null | undefined, kind: DateKind, today: string): string[] {
  if (!value) return [];
  const text = value
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9./\- ]+/g, " ")
    // A dot after a letter ends an abbreviation ("FEVR."), never a part of a date.
    .replace(/([A-Z])\./g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
  const year = (raw: string) => (raw.length === 4 ? Number(raw) : fullYear(Number(raw), kind, today));
  const unique = (dates: (string | null)[]) => [...new Set(dates.filter((d): d is string => d !== null))];

  // 1991-03-05 (as the worker sends complete dates), or 1991/03/05.
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (m) return unique([isoDate(Number(m[1]), Number(m[2]), Number(m[3]))]);
  // 19910305
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (m) return unique([isoDate(Number(m[1]), Number(m[2]), Number(m[3]))]);
  // 05.03.1991, 05/03/91, 05-03-1991, 05 03 1991: day first, or month first when that also makes a date.
  m = /^(\d{1,2})\s?[./\- ]\s?(\d{1,2})\s?[./\- ]\s?(\d{4}|\d{2})$/.exec(text);
  if (m) {
    const y = year(m[3]);
    return unique([isoDate(y, Number(m[2]), Number(m[1])), isoDate(y, Number(m[1]), Number(m[2]))]);
  }
  // 05 MAR 1991, 5 MARS/MAR 91, 05MAR1991, 05 JUIL/JUL 1985.
  m = /^(\d{1,2})\s?([A-Z]+)(?:\s?\/\s?[A-Z]+)?\s?(\d{4}|\d{2})$/.exec(text);
  if (m && MONTHS[m[2]] !== undefined) return unique([isoDate(year(m[3]), MONTHS[m[2]], Number(m[1]))]);
  // MAR 05 1991, MARCH 5, 1991.
  m = /^([A-Z]+)\s?(\d{1,2})\s?(\d{4})$/.exec(text);
  if (m && MONTHS[m[1]] !== undefined) return unique([isoDate(Number(m[3]), MONTHS[m[1]], Number(m[2]))]);
  return [];
}

/** A printed date against the code lines' date (ISO), compared as dates. */
export function compareDate(printed: string | null | undefined, mrzIso: string | null | undefined, kind: DateKind, today: string): Agreement {
  if (!mrzIso) return "unknown";
  const readings = readPrintedDate(printed, kind, today);
  if (readings.length === 0) return "unknown";
  return readings.includes(mrzIso) ? "agree" : "disagree";
}

/**
 * The printed date as judged on its own (expiry, age, date logic): day first when a numeric date
 * reads both ways, as every document we accept prints it; null when it cannot be read or is partial.
 */
export function printedDate(value: string | null | undefined, kind: DateKind, today: string): string | null {
  return readPrintedDate(value, kind, today)[0] ?? null;
}

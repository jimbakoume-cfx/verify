// Turns the OCR engine's raw text into MRZ lines. In order:
//   1. clean each line (spaces out, upper case, '«' to '<') and keep the lines whose length is
//      within 2 of the format's (30 for TD1, 44 for TD3);
//   2. turn K or X back into '<' inside long runs of fillers (OCR's usual misreading of '<'), but
//      never one that may be a name ("DOE<<K", "ANNA<X");
//   3. snap lines that are 1-2 characters off by adding or removing a filler in their longest run
//      of fillers;
//   4. swap look-alike characters where the field decides between a letter and a digit: dates and
//      check digits are digits, names and country codes are letters (O/0, I/1, B/8, S/5, Z/2,
//      G/6, D/0, Q/0);
//   5. when the document number's check digit fails and another OCR pass of the same band read a
//      look-alike at some position of the number (O where this one read 0...), try those swaps one
//      at a time, and keep a swap only if it is the single one that makes both the number's own
//      check digit and the composite check digit right.
// Every window of consecutive candidate lines is tried, and the best-checking one is kept.
//
// The correction stays narrow on purpose: it must never make wrong data look valid. Steps 2-4
// only fix characters whose field type leaves a single sensible reading. Step 5 needs evidence
// beyond the check digit, because the check digit alone is weak: one digit modulo 10 lets about 1
// wrong candidate in 10 through, and the composite adds nothing here (it starts with the document
// number, so the number's characters weigh the same in both sums and a swap that fixes one fixes
// the other). A blind search over look-alikes would turn about a quarter of the numbers misread
// in some other way (3 for 8...) into wrong numbers that pass. So a swap must also have been read
// by the other pass; without that, the check stays failed and the rider retakes the photo. The
// server re-parses the lines and trusts nothing the phone concludes.
import { MRZ_LAYOUT, MRZ_REPORT_LIMITS, type MrzFormat, type ParsedMrz, documentCodeFits, parseMrz } from "@verify/shared";

export interface CorrectedMrz {
  /** The lines, exactly MRZ_LAYOUT[format] in size and characters; null when none were found. */
  lines: string[] | null;
  /** Characters changed (look-alikes swapped, fillers restored, added or removed). */
  corrections: number;
}

/**
 * Field types by position. A: letters or fillers (document code, countries, names). N: digits
 * (dates, check digits). X: letters or digits, undecidable from the field (document number,
 * optional data). S: sex (M, F, X or '<'). Check digits may also be '<' where ICAO allows it.
 */
export const FIELD_TYPES: Record<MrzFormat, string[]> = {
  TD1: [
    "AA" + "AAA" + "X".repeat(9) + "N" + "X".repeat(15),
    "N".repeat(6) + "N" + "S" + "N".repeat(6) + "N" + "AAA" + "X".repeat(11) + "N",
    "A".repeat(30),
  ],
  TD3: [
    "A".repeat(44),
    "X".repeat(9) + "N" + "AAA" + "N".repeat(6) + "N" + "S" + "N".repeat(6) + "N" + "X".repeat(14) + "N" + "N",
  ],
};

/** Letters that OCR confuses with a digit, and back. */
const TO_DIGIT: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", B: "8", S: "5", Z: "2", G: "6" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "8": "B", "5": "S", "2": "Z", "6": "G" };

/**
 * Look-alikes the document-number repair may swap. G/6 is left out: G is 16 and 6 is 6, so the
 * swap never changes a check digit (16 - 6 = 10) and the check digit cannot tell them apart.
 */
const LOOK_ALIKES: Record<string, string[]> = {
  O: ["0"],
  D: ["0"],
  Q: ["0"],
  "0": ["O", "D", "Q"],
  I: ["1"],
  "1": ["I"],
  B: ["8"],
  "8": ["B"],
  S: ["5"],
  "5": ["S"],
  Z: ["2"],
  "2": ["Z"],
};

/** The document-number repair gives up rather than try more single swaps than this. */
export const MAX_NUMBER_CANDIDATES = 8;

/** Upper case, '«' and similar to '<', everything but A-Z, 0-9 and '<' removed (spaces too). */
export function cleanLine(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[«‹〈⟨]/g, "<")
    .replace(/[^A-Z0-9<]/g, "");
}

/**
 * K, X and '«' read inside a run of fillers become '<' again: a K or X with at least two filler
 * characters on each side (or two before it at the end of the line), in a run where '<' is the
 * majority. A K or X that may be a name is left alone: one that follows a word of letters directly
 * or after one or two '<', such as an initial between names ("ANNA<K<<<") or a one-letter given
 * name after the surname ("DOE<<K<<<"). A K or X kept this way counts as such a word for the next
 * one ("DOE<<K<X<<<"). No check digit covers the names, so turning a real letter there into '<'
 * would change the data unseen. After a word with digits (a number, the dates), the run is
 * optional data, which check digits cover.
 */
export function restoreFillers(line: string): { line: string; changed: number } {
  const chars = line.split("");
  let changed = 0;
  const fillerLike = (c: string) => c === "<" || c === "K" || c === "X";
  let i = 0;
  while (i < chars.length) {
    if (!fillerLike(chars[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end < chars.length && fillerLike(chars[end])) end++;
    const run = chars.slice(i, end);
    const fillers = run.filter((c) => c === "<").length;
    if (fillers * 2 > run.length) {
      // '<' since the last word that may be a name; null when the run does not follow one.
      let sinceName: number | null = followsName(chars, i) ? 0 : null;
      for (let k = 0; k < run.length; k++) {
        if (run[k] !== "<" && sinceName !== null && sinceName <= 2) {
          sinceName = 0;
          continue;
        }
        const before = k;
        const after = run.length - 1 - k;
        if (run[k] !== "<" && before >= 2 && (after >= 2 || end === chars.length)) {
          chars[i + k] = "<";
          changed++;
        }
        if (chars[i + k] === "<" && sinceName !== null) sinceName++;
      }
    }
    i = end;
  }
  return { line: chars.join(""), changed };
}

/** True when the characters before `index`, back to the previous '<', are letters only. */
function followsName(chars: readonly string[], index: number): boolean {
  let start = index;
  while (start > 0 && chars[start - 1] !== "<") start--;
  return start < index && chars.slice(start, index).every((c) => c >= "A" && c <= "Z");
}

/**
 * Fits a line to `length` when it is 1 or 2 characters off, by removing fillers from (or adding
 * them to) its longest run of fillers, the last one on a tie: OCR most often miscounts long runs
 * of '<'. Removal only shortens runs of 3 or more, so the "<<" between surname and given names
 * survives. Null when the line cannot be fitted that way.
 */
export function snapLength(line: string, length: number): { line: string; changed: number } | null {
  const diff = line.length - length;
  if (diff === 0) return { line, changed: 0 };
  if (Math.abs(diff) > 2) return null;
  let out = line;
  for (let n = 0; n < Math.abs(diff); n++) {
    const run = longestFillerRun(out);
    if (!run || (diff > 0 && run.length < 3)) return null;
    out = diff > 0 ? out.slice(0, run.start) + out.slice(run.start + 1) : out.slice(0, run.start) + "<" + out.slice(run.start);
  }
  return { line: out, changed: Math.abs(diff) };
}

function longestFillerRun(line: string): { start: number; length: number } | null {
  let best: { start: number; length: number } | null = null;
  const re = /<+/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (!best || m[0].length >= best.length) best = { start: m.index, length: m[0].length };
  }
  return best;
}

/** Swaps look-alikes where the field type decides between a letter and a digit. */
export function swapByFieldType(lines: string[], format: MrzFormat): { lines: string[]; changed: number } {
  let changed = 0;
  const out = lines.map((line, l) => {
    const types = FIELD_TYPES[format][l];
    let fixed = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const swap = types[i] === "N" ? TO_DIGIT[c] : types[i] === "A" ? TO_LETTER[c] : undefined;
      if (swap) changed++;
      fixed += swap ?? c;
    }
    return fixed;
  });
  return { lines: out, changed };
}

/** Positions [line, index] of the document number's characters (TD1 long numbers included). */
function documentNumberPositions(lines: string[], format: MrzFormat): [number, number][] {
  if (format === "TD3") return range(0, 9).map((i) => [1, i]);
  const positions: [number, number][] = range(5, 14).map((i) => [0, i]);
  // Long number (ICAO 9303 Part 5): '<' instead of the check digit, the rest of the number at the
  // start of the optional data, then its check digit.
  if (lines[0][14] === "<") {
    const tail = /^[A-Z0-9]+/.exec(lines[0].slice(15))?.[0] ?? "";
    for (let i = 0; i < tail.length - 1; i++) positions.push([0, 15 + i]);
  }
  return positions;
}

/**
 * When the document number's check digit fails, tries single look-alike swaps in the number, each
 * only where another reading of the same lines (`evidence`, from another OCR pass) has that very
 * character, and keeps the swap only if it is the one candidate whose own check digit and
 * composite check digit are both right. Otherwise, and always without evidence, the lines are
 * returned unchanged.
 */
export function repairDocumentNumber(
  lines: string[],
  format: MrzFormat,
  evidence: readonly string[][] = [],
): { lines: string[]; changed: number } {
  const parsed = parseMrz(lines);
  if (!parsed || parsed.checks.documentNumber || evidence.length === 0) return { lines, changed: 0 };
  const candidates: string[][] = [];
  for (const [l, i] of documentNumberPositions(lines, format)) {
    for (const alt of LOOK_ALIKES[lines[l][i]] ?? []) {
      if (!evidence.some((other) => other[l]?.[i] === alt)) continue;
      const next = [...lines];
      next[l] = next[l].slice(0, i) + alt + next[l].slice(i + 1);
      candidates.push(next);
    }
  }
  if (candidates.length > MAX_NUMBER_CANDIDATES) return { lines, changed: 0 };
  const fits = candidates.filter((c) => {
    const p = parseMrz(c);
    return p !== null && p.checks.documentNumber && p.checks.composite;
  });
  return fits.length === 1 ? { lines: fits[0], changed: 1 } : { lines, changed: 0 };
}

interface Candidate {
  lines: string[];
  corrections: number;
  parsed: ParsedMrz;
  /** Position of the window in the OCR output (later = lower on the document). */
  index: number;
}

/**
 * Corrects raw OCR text into the lines of a `format` MRZ; see the file comment. `otherReadings`
 * are raw texts of other OCR passes over the same band: they only serve as evidence for the
 * document-number repair (step 5).
 */
export function correctMrz(rawText: string, format: MrzFormat, otherReadings: readonly string[] = []): CorrectedMrz {
  const evidence = otherReadings
    .map((text) => assemble(text, format, []).lines)
    .filter((lines): lines is string[] => lines !== null);
  const best = assemble(rawText, format, evidence);
  return { lines: best.lines, corrections: Math.min(best.corrections, MRZ_REPORT_LIMITS.maxCorrections) };
}

function assemble(rawText: string, format: MrzFormat, evidence: readonly string[][]): CorrectedMrz {
  const { lines: count, length } = MRZ_LAYOUT[format];
  const prepared: { line: string; changed: number }[] = [];
  for (const raw of rawText.split(/\r?\n/)) {
    const cleaned = cleanLine(raw);
    if (Math.abs(cleaned.length - length) > 2) continue;
    const restored = restoreFillers(cleaned);
    const snapped = snapLength(restored.line, length);
    if (snapped) prepared.push({ line: snapped.line, changed: restored.changed + snapped.changed });
  }

  let best: Candidate | null = null;
  for (let i = 0; i + count <= prepared.length; i++) {
    const window = prepared.slice(i, i + count);
    const swapped = swapByFieldType(
      window.map((w) => w.line),
      format,
    );
    const repaired = repairDocumentNumber(swapped.lines, format, evidence);
    const parsed = parseMrz(repaired.lines);
    if (!parsed) continue;
    const corrections = window.reduce((s, w) => s + w.changed, 0) + swapped.changed + repaired.changed;
    const candidate = { lines: repaired.lines, corrections, parsed, index: i };
    if (!plausible(candidate, format)) continue;
    if (!best || better(candidate, best, format)) best = candidate;
  }
  return best ? { lines: best.lines, corrections: best.corrections } : { lines: null, corrections: 0 };
}

function passedChecks(parsed: ParsedMrz): number {
  return Object.values(parsed.checks).filter(Boolean).length;
}

/**
 * Lines that look like the MRZ at all: the document code fits the format, or at least two check
 * digits are right. Anything else (a line of printed text that happens to be 30 characters long)
 * is not reported as an MRZ.
 */
function plausible(c: Candidate, format: MrzFormat): boolean {
  return documentCodeFits(format, c.parsed.documentCode) || passedChecks(c.parsed) >= 2;
}

/** Valid first, then more check digits right, a fitting document code, fewer corrections, lower. */
function better(a: Candidate, b: Candidate, format: MrzFormat): boolean {
  const key = (c: Candidate) => [
    c.parsed.valid ? 1 : 0,
    passedChecks(c.parsed),
    documentCodeFits(format, c.parsed.documentCode) ? 1 : 0,
    -c.corrections,
    c.index,
  ];
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
  return false;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

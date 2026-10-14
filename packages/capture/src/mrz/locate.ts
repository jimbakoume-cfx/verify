// Finds the MRZ ("code lines") on the full-resolution still of a card back or passport page.
//
// The still is the capture guide plus 4%, so the document nearly fills it, upright (the reader
// retries on the image turned 180 degrees). The code lines are the lowest block of text: TD1 has
// 3 lines in roughly the bottom third of the card, TD3 2 lines in roughly the bottom quarter of
// the page. Every code line runs across almost the whole document width (fillers '<' included),
// which sets them apart from printed fields, a portrait or a QR code.
//
// Steps: mark ink with a local threshold over the lower part of the still (one global threshold,
// such as Otsu's, fails under a shadow or uneven light) and keep only strokes, short runs of ink
// with paper on both sides (this drops the card's edge against the table and shadow borders);
// find the tilt that makes the rows of strokes sharpest (the card may be turned a few degrees);
// project the strokes onto rows at that tilt; keep rows with strokes across most of the width;
// group them into text lines; pick the lowest run of 3 (TD1) or 2 (TD3) lines of similar height,
// even spacing and the same start and end. When nothing fits, fall back to a fixed crop of the
// bottom, which OCR may still read.
import { STILL_CROP_EXPANSION } from "../geometry";
import { assertGray, type Bounds } from "../pixels";
import type { GrayImage, Rect } from "../types";
import { localInkMask } from "./threshold";

export type MrzLayoutName = "TD1" | "TD3";

/** ICAO 9303 MRZ print: 10 characters per inch; OCR-B size 1 capitals about 2.4 mm tall. */
export const MRZ_PRINT = { charPitchMm: 2.54, capHeightMm: 2.4 } as const;

interface Layout {
  lines: number;
  /** Characters per line. */
  chars: number;
  documentWidthMm: number;
  /** Lines are searched from this far down the still (share of its height) to the bottom. */
  searchFrom: number;
  /** The fallback crop runs from this far down the still to the bottom. */
  fallbackFrom: number;
}

const LAYOUTS: Record<MrzLayoutName, Layout> = {
  // ID-1 card, 85.6 mm wide: the 3 lines take the bottom 27-33% of the card.
  TD1: { lines: 3, chars: 30, documentWidthMm: 85.6, searchFrom: 0.42, fallbackFrom: 0.58 },
  // Passport page, 125 mm wide: the 2 lines take the bottom 20-26% of the page.
  TD3: { lines: 2, chars: 44, documentWidthMm: 125, searchFrom: 0.5, fallbackFrom: 0.66 },
};

/** Tilts tried, degrees either way: the capture accepts cards turned up to 4 degrees. */
const MAX_SKEW_DEG = 6;
const SKEW_STEP_DEG = 0.5;
/** Columns a row is split into to measure how far its ink spreads across the still. */
const SPREAD_BINS = 32;
/** A row belongs to a code line when it has ink in at least this share of the columns... */
const MIN_ROW_SPREAD = 0.45;
/**
 * ...and at least this many separate strokes per character of the line (short runs of ink, as
 * letters give). The card's edge against the table, or a shadow's border, can spread across the
 * whole width too, but as one long run.
 */
const MIN_STROKES_PER_CHAR = 0.5;

export interface MrzBand {
  /**
   * The code lines plus a margin, in still pixels, before the tilt: the band is this rectangle
   * turned by `angle` around its centre.
   */
  rect: Rect;
  /** Clockwise tilt of the lines, degrees. */
  angle: number;
  /** Lines found: 3 (TD1) or 2 (TD3), or 0 for the fallback crop. */
  lines: number;
  /** Character height in pixels: measured, or expected from the still's size for the fallback. */
  charHeight: number;
  /** 0..1: how evenly sized and spaced the lines are, and how far they spread; 0 for the fallback. */
  confidence: number;
  /** True when no fitting lines were found and `rect` is a fixed crop of the bottom. */
  fallback: boolean;
}

/**
 * Character height to expect when the document fills the guide: the still is the guide plus
 * STILL_CROP_EXPANSION, and the document spans the guide's width.
 */
export function expectedMrzCharHeight(stillWidth: number, format: MrzLayoutName): number {
  const pxPerMm = stillWidth / (1 + STILL_CROP_EXPANSION) / LAYOUTS[format].documentWidthMm;
  return pxPerMm * MRZ_PRINT.capHeightMm;
}

/** The fixed bottom crop used when no code lines are found. */
export function fallbackMrzBand(image: GrayImage, format: MrzLayoutName): MrzBand {
  const top = Math.floor(image.height * LAYOUTS[format].fallbackFrom);
  return {
    rect: { x: 0, y: top, width: image.width, height: image.height - top },
    angle: 0,
    lines: 0,
    charHeight: expectedMrzCharHeight(image.width, format),
    confidence: 0,
    fallback: true,
  };
}

interface TextLine {
  /** First and last+1 sheared row. */
  top: number;
  bottom: number;
  /** Mean share of columns with ink over the line's rows. */
  spread: number;
}

/** Finds the code lines of a `format` document in a still; see the file comment. */
export function locateMrzBand(image: GrayImage, format: MrzLayoutName): MrzBand {
  assertGray(image);
  const layout = LAYOUTS[format];
  const expected = expectedMrzCharHeight(image.width, format);
  const margin = Math.round(image.width * 0.01);
  const region: Bounds = {
    x0: margin,
    y0: Math.floor(image.height * layout.searchFrom),
    x1: image.width - margin,
    y1: image.height,
  };
  const w = region.x1 - region.x0;
  const h = region.y1 - region.y0;
  if (w < 32 || h < 16 || expected < 4) return fallbackMrzBand(image, format);

  // Printed code lines are far darker than the paper (100+ levels in good light, 40+ in dim
  // light); faint texture such as a table's grain stays under the 20-level floor.
  const mask = localInkMask(image, region, { radius: expected, darker: 0.2, minContrast: 20 });
  // A stroke is a run of ink no longer than about two characters are tall, with paper on both
  // sides.
  const ink = strokePixels(image, region, mask, 2 * expected);
  const tilt = estimateTilt(ink, w, h);
  const t = Math.tan((tilt * Math.PI) / 180);
  const profile = shearedProfile(ink, w, h, t);
  const lines = findTextLines(profile, expected, MIN_STROKES_PER_CHAR * layout.chars);
  const extentOf = (line: TextLine) =>
    textColumns(ink, w, t, profile.offset, line.top, line.bottom, line.bottom - line.top);
  const group = pickLineGroup(lines, layout.lines, expected, extentOf);
  if (!group) return fallbackMrzBand(image, format);

  // The band in sheared coordinates, with a margin of most of a character all round.
  const charHeight = median(group.lines.map((l) => l.bottom - l.top));
  const pad = 0.8 * charHeight;
  const left = Math.max(0, group.start - pad);
  const right = Math.min(w, group.end + pad);
  const top = group.lines[0].top - pad;
  const bottom = group.lines[group.lines.length - 1].bottom + pad;
  // Sheared row r at column x is image row r - offset + (x - w / 2) * t (region coordinates).
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2 - profile.offset + (centerX - w / 2) * t;
  const width = right - left;
  const height = bottom - top;
  return {
    rect: {
      x: region.x0 + centerX - width / 2,
      y: region.y0 + centerY - height / 2,
      width,
      height,
    },
    angle: tilt,
    lines: layout.lines,
    charHeight,
    confidence: group.score,
    fallback: false,
  };
}

/** Pixels of strokes (region coordinates), and which of them start a stroke. */
interface Ink {
  xs: Int32Array;
  ys: Int32Array;
  /** 1 where the pixel is the first of its stroke. */
  strokeStart: Uint8Array;
  count: number;
}

/** How much lighter the paper just beside a stroke must be than the stroke itself, in levels. */
const STROKE_EDGE_CONTRAST = 15;

/**
 * Keeps the horizontal runs of ink that look like pen strokes: at most `maxStroke` long, and
 * clearly lighter just beyond both ends. The card's edge against a dark table, or a shadow's
 * border, also gives "ink" next to a lighter area, but on one side only: beyond the run lies
 * more of the same dark table or shadow.
 */
function strokePixels(image: GrayImage, region: Bounds, mask: Uint8Array, maxStroke: number): Ink {
  const w = region.x1 - region.x0;
  const h = region.y1 - region.y0;
  const { width: W, data } = image;
  const xs: number[] = [];
  const ys: number[] = [];
  const starts: number[] = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const src = (region.y0 + y) * W + region.x0;
    let x = 0;
    while (x < w) {
      if (!mask[row + x]) {
        x++;
        continue;
      }
      let end = x;
      let sum = 0;
      while (end < w && mask[row + end]) sum += data[src + end++];
      const level = sum / (end - x) + STROKE_EDGE_CONTRAST;
      // Two pixels beyond each end, inside the region (the still's edge counts as paper).
      const before = x >= 2 ? data[src + x - 2] : 255;
      const after = end + 1 < w ? data[src + end + 1] : 255;
      if (end - x <= maxStroke && before >= level && after >= level) {
        for (let k = x; k < end; k++) {
          xs.push(k);
          ys.push(y);
          starts.push(k === x ? 1 : 0);
        }
      }
      x = end;
    }
  }
  return { xs: Int32Array.from(xs), ys: Int32Array.from(ys), strokeStart: Uint8Array.from(starts), count: xs.length };
}

/**
 * The tilt (degrees, clockwise) at which the ink falls into the sharpest rows: the projection of
 * the ink along lines of that slope has the largest sum of squares. Ties keep the smaller tilt.
 */
function estimateTilt(ink: Ink, w: number, h: number): number {
  const { xs, ys, count: n } = ink;
  if (n === 0) return 0;
  const energy = (deg: number): number => {
    const t = Math.tan((deg * Math.PI) / 180);
    const offset = Math.ceil(Math.abs(t) * w / 2) + 1;
    const rows = new Float64Array(h + 2 * offset);
    const cx = w / 2;
    for (let i = 0; i < n; i++) rows[Math.round(ys[i] - (xs[i] - cx) * t) + offset]++;
    let sum = 0;
    for (let r = 0; r < rows.length; r++) sum += rows[r] * rows[r];
    return sum;
  };
  let best = 0;
  let bestEnergy = energy(0);
  for (let step = 1; step * SKEW_STEP_DEG <= MAX_SKEW_DEG + 1e-9; step++) {
    for (const deg of [step * SKEW_STEP_DEG, -step * SKEW_STEP_DEG]) {
      const e = energy(deg);
      if (e > bestEnergy * 1.0001) {
        best = deg;
        bestEnergy = e;
      }
    }
  }
  // Refine to a quarter step either side.
  for (const deg of [best - SKEW_STEP_DEG / 2, best + SKEW_STEP_DEG / 2]) {
    const e = energy(deg);
    if (e > bestEnergy * 1.0001) {
      best = deg;
      bestEnergy = e;
    }
  }
  return best;
}

interface Profile {
  /** Ink pixels per sheared row. */
  ink: Float64Array;
  /** Strokes (short runs of ink) starting in each sheared row. */
  strokes: Float64Array;
  /** Share of SPREAD_BINS columns with ink, per sheared row. */
  spread: Float64Array;
  /** Sheared row r = image row + (x - w / 2) * -t + offset. */
  offset: number;
}

function shearedProfile(ink: Ink, w: number, h: number, t: number): Profile {
  const offset = Math.ceil(Math.abs(t) * w / 2) + 1;
  const rows = h + 2 * offset;
  const counts = new Float64Array(rows);
  const strokes = new Float64Array(rows);
  const bins = new Uint8Array(rows * SPREAD_BINS);
  const cx = w / 2;
  for (let i = 0; i < ink.count; i++) {
    const x = ink.xs[i];
    const r = Math.round(ink.ys[i] - (x - cx) * t) + offset;
    counts[r]++;
    strokes[r] += ink.strokeStart[i];
    bins[r * SPREAD_BINS + Math.min(SPREAD_BINS - 1, Math.floor((x * SPREAD_BINS) / w))] = 1;
  }
  const spread = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    let filled = 0;
    for (let b = 0; b < SPREAD_BINS; b++) filled += bins[r * SPREAD_BINS + b];
    spread[r] = filled / SPREAD_BINS;
  }
  return { ink: counts, strokes, spread, offset };
}

/**
 * Runs of rows with strokes across most of the width (at least `minStrokes` per row), grown to the
 * full height of their letters.
 */
function findTextLines(profile: Profile, expected: number, minStrokes: number): TextLine[] {
  const { ink, spread, strokes } = profile;
  const rows = ink.length;
  const isText = (r: number) => spread[r] >= MIN_ROW_SPREAD && strokes[r] >= minStrokes;
  const maxGap = Math.max(1, Math.round(0.1 * expected));
  const lines: TextLine[] = [];
  let r = 0;
  while (r < rows) {
    if (!isText(r)) {
      r++;
      continue;
    }
    // A core run: wide rows, allowing gaps of a row or two.
    let end = r + 1;
    let gap = 0;
    for (let k = r + 1; k < rows; k++) {
      if (isText(k)) {
        end = k + 1;
        gap = 0;
      } else if (++gap > maxGap) {
        break;
      }
    }
    let peak = 0;
    let spreadSum = 0;
    for (let k = r; k < end; k++) {
      peak = Math.max(peak, ink[k]);
      spreadSum += spread[k];
    }
    // Grow over the tops and bottoms of the letters (fillers '<' do not reach them).
    let top = r;
    let bottom = end;
    while (top > 0 && ink[top - 1] >= 0.2 * peak && spread[top - 1] >= 0.1) top--;
    while (bottom < rows && ink[bottom] >= 0.2 * peak && spread[bottom] >= 0.1) bottom++;
    lines.push({ top, bottom, spread: spreadSum / (end - r) });
    r = bottom;
  }
  return lines;
}

interface LineGroup {
  lines: TextLine[];
  score: number;
  /** Columns spanned by the lines (sheared region coordinates). */
  start: number;
  end: number;
}

type Extent = { start: number; end: number };

/**
 * The lowest run of `count` consecutive lines that look like code lines: plausible and similar
 * heights, even spacing of about 1.2-3 line heights, and the same start and end (every code line
 * has the same number of characters at the same pitch; texture under or around the document does
 * not line up like that). Code lines are the lowest text on the page.
 */
function pickLineGroup(
  lines: TextLine[],
  count: number,
  expected: number,
  extentOf: (line: TextLine) => Extent | null,
): LineGroup | null {
  for (let i = lines.length - count; i >= 0; i--) {
    const group = lines.slice(i, i + count);
    const heights = group.map((l) => l.bottom - l.top);
    const minH = Math.min(...heights);
    const maxH = Math.max(...heights);
    if (minH < 0.4 * expected || maxH > 2.2 * expected || maxH > 1.8 * minH) continue;
    const height = median(heights);
    const pitches: number[] = [];
    for (let k = 1; k < count; k++) {
      pitches.push((group[k].top + group[k].bottom - group[k - 1].top - group[k - 1].bottom) / 2);
    }
    if (pitches.some((p) => p < 1.2 * height || p > 3 * height)) continue;
    const evenness = Math.min(...pitches) / Math.max(...pitches);
    if (evenness < 0.75) continue;
    const extents = group.map(extentOf);
    if (extents.some((e) => e === null)) continue;
    const starts = (extents as Extent[]).map((e) => e.start);
    const ends = (extents as Extent[]).map((e) => e.end);
    const misfit = Math.max(Math.max(...starts) - Math.min(...starts), Math.max(...ends) - Math.min(...ends));
    if (misfit > 1.5 * height) continue;
    const spread = group.reduce((s, l) => s + l.spread, 0) / count;
    const alignment = 1 - misfit / (3 * height);
    const score = Math.max(0, Math.min(1, spread * evenness * (minH / maxH) * alignment));
    return { lines: group, score, start: Math.min(...starts), end: Math.max(...ends) };
  }
  return null;
}

/**
 * Horizontal extent of the text between sheared rows `top` and `bottom`: the stretch of columns
 * with the most ink in which no gap is wider than `charHeight` (the gaps between code characters
 * are narrower; the card's edge or a portrait beside the lines is further away).
 */
function textColumns(
  ink: Ink,
  w: number,
  t: number,
  offset: number,
  top: number,
  bottom: number,
  charHeight: number,
): { start: number; end: number } | null {
  const columns = new Float64Array(w);
  const cx = w / 2;
  for (let i = 0; i < ink.count; i++) {
    const x = ink.xs[i];
    const r = Math.round(ink.ys[i] - (x - cx) * t) + offset;
    if (r >= top && r < bottom) columns[x]++;
  }
  const maxGap = Math.max(2, Math.round(charHeight));
  let best: { start: number; end: number; ink: number } | null = null;
  let start = -1;
  let end = -1;
  let sum = 0;
  let gap = 0;
  const close = () => {
    if (start >= 0 && (!best || sum > best.ink)) best = { start, end, ink: sum };
    start = -1;
    sum = 0;
  };
  for (let x = 0; x < w; x++) {
    if (columns[x] > 0) {
      if (start < 0) start = x;
      end = x + 1;
      sum += columns[x];
      gap = 0;
    } else if (start >= 0 && ++gap > maxGap) {
      close();
    }
  }
  close();
  const found = best as { start: number; end: number; ink: number } | null;
  return found ? { start: found.start, end: found.end } : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 1 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Finds the card as the best rectangle of four straight edges around the guide.
//
// Sobel gradients: Gx (left-right change) and Gy (up-down change). A card edge is a long straight
// line. Summed along the line, its gradient adds up, while text and pattern inside the card have
// both signs and largely cancel. The edge's sign can flip along its length (a light card is darker
// than a white object beside it and lighter than the table elsewhere; a finger crosses it), so each
// edge is summed in pieces (bands of rows for a vertical edge, of columns for a horizontal one) and
// the pieces' absolute values are combined. Running sums make every such measure cost O(1) per piece.
//
// 1. Candidates for each side: the strongest few column (row) responses over the search area,
//    plus the outermost few, because text lines inside a card on a similar-coloured table can
//    outrank its border.
// 2. Every combination of four candidates is ranked by the strength of each edge along the box's
//    own extent, quarter by quarter: a card border runs the card's full length, a portrait edge or
//    a text line does not. Every clear edge counts the same, so the larger box (the card rather
//    than a rectangle printed on it) wins, then the box closest to the guide's aspect ratio.
// 3. Each chosen edge is fitted as a straight line that may slant (a card held a few degrees
//    askew): each quarter of the edge is located on its own, near the candidate, to a fraction of
//    a pixel, a line is fitted through the quarters (ignoring one that disagrees, e.g. under a
//    finger), and the edge's strength is measured along that line. The lines give the tilt and
//    the four corners, hence the card's true extent; a confidence is computed.
//
// Known limit: background objects with long straight edges parallel to and touching the card can
// be taken as part of it (see README.md, "Document detection").
import type { DocumentDetection, GrayImage, Rect } from "./types";
import { expandRect } from "./geometry";
import { assertGray, medianInPlace, pixelBounds, scratchFloat64, scratchInt32 } from "./pixels";

/** The search area is the guide grown by this fraction (spec: 15%), clamped to the image. */
export const DETECTION_SEARCH_EXPANSION = 0.15;

/** Smallest box considered, as a share of the guide's width and height. */
const MIN_BOX_FRACTION = 0.4;
/** Bands the search area is cut into when looking for candidate edges. */
const SEARCH_BANDS = 8;
/** Strongest candidate positions kept per side (left, right, top, bottom). */
const STRONGEST_PER_SIDE = 6;
/** Outermost candidate positions kept per side, among those above {@link MIN_CANDIDATE_LEVEL}. */
const OUTERMOST_PER_SIDE = 3;
/**
 * Smallest search-area response worth considering as an outermost candidate: luma levels times
 * the share of the search area the edge spans (a 12-level edge across half of it gives 6).
 */
const MIN_CANDIDATE_LEVEL = 2;
/** Steepest edge slope fitted: tan(12 degrees). A card tilted further is not measured reliably. */
const MAX_EDGE_SLOPE = Math.tan((12 * Math.PI) / 180);
/** Share of the box ignored at each end when measuring an edge along it (keeps rounded corners out). */
const EDGE_INSET = 0.1;
/** Pieces an edge is measured in, along its length. */
const EDGE_SEGMENTS = 4;
/**
 * A Sobel step of contrast C summed across the edge gives 8 C (4 C from the 1-2-1 weights, over
 * the two columns either side of the step), whatever the blur. Dividing by 8 yields luma levels.
 */
const SOBEL_STEP_GAIN = 8;
/**
 * When ranking boxes, an edge counts for at most this contrast (luma levels): every clearly
 * visible edge counts the same, so the size and shape of the box decide between the card and a
 * rectangle printed on it, and one very strong background line cannot carry weak sides. Higher
 * values let the printed rectangle win on cards only 10 levels away from the table's brightness.
 */
const RANK_CONTRAST_CAP = 10;
/** When ranking boxes, the score is multiplied by (box area / guide area) to this power. */
const RANK_SIZE_POWER = 1;
/** When ranking boxes, the score is multiplied by exp(-(ln(aspect / guide aspect) / this)^2). */
const RANK_ASPECT_SIGMA = 0.2;

// Confidence ramps: each score is 0 at or below `lo` and 1 at or above `hi`.
/**
 * Weakest edge contrast, in luma levels (see {@link edgeStrength}). Synthetic tests: pure noise
 * (even 40 levels) stays below 1, random clutter below 8; a light card on a table 15 levels
 * darker measures 12, on a dark table 120.
 */
const EDGE_CONTRAST_RAMP = { lo: 4, hi: 12 } as const;
/**
 * Weakest edge vs the texture inside the box (see {@link interiorLevel}). Synthetic tests: a
 * printed card on a table 15 levels darker or lighter measures 3.3; boxes found in noise below 1.
 */
const EDGE_TO_INTERIOR_RAMP = { lo: 1.5, hi: 3 } as const;
/** |ln(box aspect / guide aspect)|: full score up to ~28% off, zero beyond ~65% off. */
const ASPECT_RAMP = { lo: 0.25, hi: 0.5 } as const;
/**
 * Disagreement between the edges' tilts, degrees (see {@link detectDocumentBox}), as a penalty.
 * Synthetic cards tilted up to 9 degrees with perspective up to a 15% wider near edge: at most
 * 2.2; cards found on cluttered tables: at most 1.5; boxes stitched from clutter without a card
 * that otherwise look confident: 3.5 and more.
 */
const TILT_DISAGREEMENT_RAMP = { lo: 2.5, hi: 3.4 } as const;
/**
 * How far one edge's tilt may differ from the card's when its strength is measured (degrees):
 * perspective of a phone pitched ~15 degrees over the card turns its sides by about 3.
 */
const PERSPECTIVE_DEG = 3;
/** Slopes tried when fitting an edge, in this many degrees' steps; the fit refines the result. */
const SLOPE_STEP_DEG = 2;

const NONE: DocumentDetection = { box: null, confidence: 0, polarity: null, angle: 0, extent: null };

/**
 * Gradient sums of the search area. `col` holds running sums of Gx down each column,
 * `row` running sums of Gy along each row.
 */
interface Sums {
  col: Int32Array;
  row: Int32Array;
  w: number;
  h: number;
}

/**
 * Looks for a document inside the guide grown by 15% (clamped to the image), by its four
 * straight edges. Works for a card lighter or darker than its background, and on a background
 * that is lighter in places and darker in others.
 *
 * Always returns the best candidate it found, with a confidence: compare the confidence with
 * `QualityThresholds.minDocumentConfidence` (as {@link analyzeFrame} does) before trusting the box.
 * A plain or noisy background with no card gives a low confidence. A card must lie entirely
 * inside the search area and be at least 40% of the guide's width and height to be found.
 *
 * @param img Grayscale analysis image.
 * @param guide The on-screen guide, in `img` pixels.
 */
export function detectDocumentBox(img: GrayImage, guide: Rect): DocumentDetection {
  assertGray(img);
  if (!(guide.width > 0) || !(guide.height > 0)) return NONE;
  const b = pixelBounds(img, expandRect(guide, DETECTION_SEARCH_EXPANSION), 1);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  // Half-width of the window gathering an edge's response: about 1% of the search width (4-5 px
  // at the 480 px analysis size), enough for slight blur or a tilt of a degree or two.
  const k = Math.max(2, Math.round(w / 100));
  if (w < 6 * k || h < 6 * k) return NONE;
  const minW = Math.max(2 * k + 1, Math.round(guide.width * MIN_BOX_FRACTION));
  const minH = Math.max(2 * k + 1, Math.round(guide.height * MIN_BOX_FRACTION));
  const guideAspect = guide.width / guide.height;
  const guideArea = guide.width * guide.height;

  const sums: Sums = {
    col: scratchInt32("detect.col", (h + 1) * w),
    row: scratchInt32("detect.row", h * (w + 1)),
    w,
    h,
  };
  sobelSums(img, b.x0, b.y0, sums);

  // 1. Candidates, each side only where a box of the minimum size still fits.
  const ax = scratchFloat64("detect.ax", w);
  const ay = scratchFloat64("detect.ay", h);
  bandedProfile(sums, true, k, ax);
  bandedProfile(sums, false, k, ay);
  const lefts = candidates(ax, k, k, w - k - minW, false);
  const rights = candidates(ax, k, k + minW, w - k, true);
  const tops = candidates(ay, k, k, h - k - minH, false);
  const bottoms = candidates(ay, k, k + minH, h - k, true);

  // 2. Rank every combination. A vertical edge's value depends only on its column and on the
  // rows it spans (the top/bottom pair), so values are computed once per (edge, pair) and reused.
  const pairsX = validPairs(lefts, rights, minW);
  const pairsY = validPairs(tops, bottoms, minH);
  const vertical = scratchFloat64("detect.vertical", pairsY.length * 2 * pairsX.length);
  for (let py = 0; py < pairsY.length; py++) {
    const [r0, r1] = innerSpan(pairsY[py][0], pairsY[py][1], h);
    for (let px = 0; px < pairsX.length; px++) {
      const o = (py * pairsX.length + px) * 2;
      vertical[o] = rankValue(sums, true, pairsX[px][0], k, r0, r1);
      vertical[o + 1] = rankValue(sums, true, pairsX[px][1], k, r0, r1);
    }
  }
  let bestScore = 0;
  let L = -1;
  let R = -1;
  let T = -1;
  let B = -1;
  for (let px = 0; px < pairsX.length; px++) {
    const [l, r] = pairsX[px];
    const [c0, c1] = innerSpan(l, r, w);
    for (let py = 0; py < pairsY.length; py++) {
      const [t, bt] = pairsY[py];
      const o = (py * pairsX.length + px) * 2;
      const aspectError = Math.log((r - l) / (bt - t) / guideAspect) / RANK_ASPECT_SIGMA;
      const shape = Math.exp(-aspectError * aspectError) * (((r - l) * (bt - t)) / guideArea) ** RANK_SIZE_POWER;
      // Skip the horizontal edges when even perfect ones could not beat the best so far.
      if ((vertical[o] + vertical[o + 1] + 2 * RANK_CONTRAST_CAP) * shape <= bestScore) continue;
      const score =
        (vertical[o] + vertical[o + 1] + rankValue(sums, false, t, k, c0, c1) + rankValue(sums, false, bt, k, c0, c1)) *
        shape;
      if (score > bestScore) {
        bestScore = score;
        L = l;
        R = r;
        T = t;
        B = bt;
      }
    }
  }
  if (L < 0) return NONE;

  // 3. Each edge as a straight, possibly slanted line, measured along the box's own extent.
  const [r0, r1] = innerSpan(T, B, h);
  const [c0, c1] = innerSpan(L, R, w);
  const left = fitEdge(sums, true, L, k, r0, r1, true);
  const right = fitEdge(sums, true, R, k, r0, r1, false);
  const top = fitEdge(sums, false, T, k, c0, c1, true);
  const bottom = fitEdge(sums, false, B, k, c0, c1, false);
  if (right.mid - left.mid < 1 || bottom.mid - top.mid < 1) return NONE;

  // Tilt (clockwise): a horizontal edge's row grows to the right, a vertical edge's column shrinks
  // downwards. A card is rigid: its edges share one tilt (the median of the four ignores an edge
  // that was poorly fitted), and their strength is measured at that tilt, so a box stitched from
  // unrelated slanted lines in clutter gains nothing from the slope search. Perspective (the phone
  // not parallel to the card) makes one pair of opposite edges converge but leaves the other pair
  // parallel and both pairs' average tilts equal; anything else is not one card.
  const deg = (v: number) => (Math.atan(v) * 180) / Math.PI;
  const tilts = [deg(top.slope), deg(bottom.slope), -deg(left.slope), -deg(right.slope)];
  const [aT, aB, aL, aR] = tilts;
  const angle = median4(tilts);
  const inconsistency = Math.max(
    Math.min(Math.abs(aT - aB), Math.abs(aL - aR)),
    Math.abs((aT + aB) / 2 - (aL + aR) / 2),
  );
  // Each edge is measured at its own tilt, kept within PERSPECTIVE_DEG of the shared one.
  const near = (tilt: number) =>
    Math.tan((Math.max(angle - PERSPECTIVE_DEG, Math.min(angle + PERSPECTIVE_DEG, tilt)) * Math.PI) / 180);
  const leftAt = lineStrength(sums, true, left, -near(aL), k, r0, r1);
  const rightAt = lineStrength(sums, true, right, -near(aR), k, r0, r1);
  const topAt = lineStrength(sums, false, top, near(aT), k, c0, c1);
  const bottomAt = lineStrength(sums, false, bottom, near(aB), k, c0, c1);

  // Confidence: the weakest edge must have real contrast, stand out from the texture inside the
  // box, the box must be roughly card-shaped, and its edges must agree on the tilt.
  const contrast = Math.min(leftAt.strength, rightAt.strength, topAt.strength, bottomAt.strength);
  const interior = interiorLevel(
    sums,
    Math.round(left.mid - 0.5),
    Math.round(right.mid - 0.5),
    Math.round(top.mid - 0.5),
    Math.round(bottom.mid - 0.5),
    k,
    r0,
    r1,
    c0,
    c1,
  );
  const aspectError = Math.abs(Math.log((right.mid - left.mid) / (bottom.mid - top.mid) / guideAspect));
  const confidence = Math.min(
    ramp(contrast, EDGE_CONTRAST_RAMP.lo, EDGE_CONTRAST_RAMP.hi),
    ramp(contrast / Math.max(interior, 0.5), EDGE_TO_INTERIOR_RAMP.lo, EDGE_TO_INTERIOR_RAMP.hi),
    1 - ramp(aspectError, ASPECT_RAMP.lo, ASPECT_RAMP.hi),
    1 - ramp(inconsistency, TILT_DISAGREEMENT_RAMP.lo, TILT_DISAGREEMENT_RAMP.hi),
  );

  // Lighter inside than outside overall: Gx > 0 at the left edge, < 0 at the right, same for Gy.
  const inward = leftAt.signed - rightAt.signed + topAt.signed - bottomAt.signed;

  // The corners, where the lines meet, bound every card pixel (a tilted card's corners stick out
  // of the box between the edges' midpoints).
  let ex0 = Infinity;
  let ey0 = Infinity;
  let ex1 = -Infinity;
  let ey1 = -Infinity;
  for (const vertical of [left, right]) {
    for (const horizontal of [top, bottom]) {
      const [x, y] = corner(vertical, horizontal);
      ex0 = Math.min(ex0, x);
      ex1 = Math.max(ex1, x);
      ey0 = Math.min(ey0, y);
      ey1 = Math.max(ey1, y);
    }
  }

  return {
    box: { x: b.x0 + left.mid, y: b.y0 + top.mid, width: right.mid - left.mid, height: bottom.mid - top.mid },
    confidence,
    polarity: inward >= 0 ? "light" : "dark",
    angle,
    extent: { x: b.x0 + ex0, y: b.y0 + ey0, width: ex1 - ex0, height: ey1 - ey0 },
  };
}

function sobelSums(img: GrayImage, x0: number, y0: number, sums: Sums): void {
  const { width: W, data: d } = img;
  const { col, row, w, h } = sums;
  for (let y = 0; y < h; y++) {
    let p = (y0 + y) * W + x0;
    const cum = (y + 1) * w;
    const prev = y * w;
    const rowBase = y * (w + 1);
    let acc = 0;
    for (let x = 0; x < w; x++, p++) {
      const up = p - W;
      const down = p + W;
      const tl = d[up - 1];
      const tr = d[up + 1];
      const bl = d[down - 1];
      const br = d[down + 1];
      col[cum + x] = col[prev + x] + (tr + 2 * d[p + 1] + br - tl - 2 * d[p - 1] - bl);
      acc += bl + 2 * d[down] + br - tl - 2 * d[up] - tr;
      row[rowBase + x + 1] = acc;
    }
  }
}

/**
 * Signed sum of the gradient across an edge: for a vertical edge (`vertical`) near column `pos`,
 * Gx summed over columns pos-k..pos+k and rows [a, z); for a horizontal one near row `pos`, Gy
 * summed over rows pos-k..pos+k and columns [a, z).
 */
function windowSum(sums: Sums, vertical: boolean, pos: number, k: number, a: number, z: number): number {
  const { col, row, w, h } = sums;
  let s = 0;
  if (vertical) {
    const j1 = Math.min(w - 1, pos + k);
    for (let j = Math.max(0, pos - k); j <= j1; j++) s += col[z * w + j] - col[a * w + j];
  } else {
    const j1 = Math.min(h - 1, pos + k);
    for (let j = Math.max(0, pos - k); j <= j1; j++) s += row[j * (w + 1) + z] - row[j * (w + 1) + a];
  }
  return s;
}

/**
 * Contrast (luma levels) of each of {@link EDGE_SEGMENTS} pieces of an edge spanning [a, z),
 * polarity ignored, written into `out` (length EDGE_SEGMENTS).
 */
function segmentContrasts(
  sums: Sums,
  vertical: boolean,
  pos: number,
  k: number,
  a: number,
  z: number,
  out: Float64Array,
): void {
  for (let seg = 0; seg < EDGE_SEGMENTS; seg++) {
    const s0 = a + Math.floor((seg * (z - a)) / EDGE_SEGMENTS);
    const s1 = a + Math.floor(((seg + 1) * (z - a)) / EDGE_SEGMENTS);
    out[seg] = s1 > s0 ? Math.abs(windowSum(sums, vertical, pos, k, s0, s1)) / (s1 - s0) / SOBEL_STEP_GAIN : 0;
  }
}

const segmentScratch = new Float64Array(EDGE_SEGMENTS);

/**
 * Contrast of an edge in its second-weakest piece, polarity ignored: the edge must be visible
 * along at least three quarters of its length (one piece may be hidden by a finger or a reflection).
 */
function edgeStrength(sums: Sums, vertical: boolean, pos: number, k: number, a: number, z: number): number {
  segmentContrasts(sums, vertical, pos, k, a, z, segmentScratch);
  let lowest = Infinity;
  let second = Infinity;
  for (let i = 0; i < EDGE_SEGMENTS; i++) {
    const v = segmentScratch[i];
    if (v < lowest) {
      second = lowest;
      lowest = v;
    } else if (v < second) {
      second = v;
    }
  }
  return second;
}

/** Ranking value of an edge: {@link edgeStrength} capped at {@link RANK_CONTRAST_CAP}. */
function rankValue(sums: Sums, vertical: boolean, pos: number, k: number, a: number, z: number): number {
  return Math.min(RANK_CONTRAST_CAP, edgeStrength(sums, vertical, pos, k, a, z));
}

/** Index pairs (low, high) from the two candidate lists that are at least `minGap` apart. */
function validPairs(lows: number[], highs: number[], minGap: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (const a of lows) for (const b of highs) if (b - a >= minGap) pairs.push([a, b]);
  return pairs;
}

/**
 * Candidate-finding profile: for each column (`vertical`) or row, the search area is cut into
 * {@link SEARCH_BANDS} bands across, the gradient is summed over the window in each band, and the
 * bands' absolute values are added, then divided by 8 x the band length (luma levels x share).
 */
function bandedProfile(sums: Sums, vertical: boolean, k: number, out: Float64Array): void {
  const n = vertical ? sums.w : sums.h;
  const across = vertical ? sums.h : sums.w;
  out.fill(0);
  for (let band = 0; band < SEARCH_BANDS; band++) {
    const a = Math.floor((band * across) / SEARCH_BANDS);
    const z = Math.floor(((band + 1) * across) / SEARCH_BANDS);
    if (z <= a) continue;
    for (let i = k; i < n - k; i++) out[i] += Math.abs(windowSum(sums, vertical, i, k, a, z));
  }
  for (let i = 0; i < n; i++) out[i] /= across * SOBEL_STEP_GAIN;
}

/**
 * Candidate edge indices in [from, to): local maxima of `profile` more than k apart, keeping the
 * strongest {@link STRONGEST_PER_SIDE} and the {@link OUTERMOST_PER_SIDE} nearest the search
 * border (the high end when `fromEnd`) that reach {@link MIN_CANDIDATE_LEVEL}.
 */
function candidates(profile: Float64Array, k: number, from: number, to: number, fromEnd: boolean): number[] {
  const lo = Math.max(from, 1);
  const hi = Math.min(to, profile.length - 1);
  // A sharp edge gives a flat top as wide as the window (it is inside the window at every one of
  // those positions); such a plateau counts once, at its middle, which is where the edge is.
  const peaks: number[] = [];
  for (let i = lo; i < hi; i++) {
    const v = profile[i];
    if (!(v > 0 && v > profile[i - 1])) continue;
    let j = i;
    while (j + 1 < profile.length - 1 && profile[j + 1] === v) j++;
    if (profile[j + 1] < v) peaks.push(Math.min(hi - 1, (i + j) >> 1));
    i = j;
  }
  peaks.sort((a, b) => profile[b] - profile[a]);
  const kept: number[] = [];
  for (const i of peaks) if (kept.every((j) => Math.abs(i - j) > k)) kept.push(i);

  const picked = kept.slice(0, STRONGEST_PER_SIDE);
  const outer = kept.filter((i) => profile[i] >= MIN_CANDIDATE_LEVEL).sort((a, b) => (fromEnd ? b - a : a - b));
  for (const i of outer.slice(0, OUTERMOST_PER_SIDE)) if (!picked.includes(i)) picked.push(i);
  return picked;
}

/**
 * Sub-pixel position of the edge found near index `i` in a per-column (per-row) profile. Within
 * the window, the outermost peak with at least half the strongest response is the card's border
 * (a band printed just inside the border can be stronger); the position is the centroid of that
 * peak's lobe (the run above half its height), using pixel centres (index + 0.5), so a blurred
 * edge is placed at the middle of its blur. `outsideIsLow`: the background lies towards lower
 * indices (left or top edge).
 */
function edgePosition(p: Float64Array, i: number, k: number, outsideIsLow: boolean): number {
  const n = p.length;
  const a = Math.max(1, i - k);
  const z = Math.min(n - 2, i + k);
  let strongest = 0;
  for (let j = a; j <= z; j++) strongest = Math.max(strongest, p[j]);
  if (!(strongest > 0)) return i + 0.5;
  let peak = i;
  for (let step = 0; step <= z - a; step++) {
    const j = outsideIsLow ? a + step : z - step;
    if (p[j] >= strongest / 2 && p[j] >= p[j - 1] && p[j] >= p[j + 1]) {
      peak = j;
      break;
    }
  }
  const floor = p[peak] / 2;
  let from = peak;
  let to = peak;
  while (from > Math.max(0, peak - 2 * k) && p[from - 1] >= floor) from--;
  while (to < Math.min(n - 1, peak + 2 * k) && p[to + 1] >= floor) to++;
  let sum = 0;
  let moment = 0;
  for (let j = from; j <= to; j++) {
    sum += p[j];
    moment += p[j] * (j + 0.5);
  }
  return sum > 0 ? moment / sum : peak + 0.5;
}

/**
 * An edge fitted as a straight line. Positions are across the edge (columns for a vertical edge,
 * rows for a horizontal one), in search-area pixels with pixel edges at integers.
 */
interface EdgeLine {
  /** Position at `centre`. */
  mid: number;
  /** Change of position per pixel along the edge. */
  slope: number;
  /** Middle of the measured span along the edge. */
  centre: number;
}

/**
 * Fits the edge found near index `pos` over the span [a, z) along it.
 *
 * 1. Slant: slopes up to {@link MAX_EDGE_SLOPE} are tried in {@link SLOPE_STEP_DEG} steps; along 1-pixel lines of
 *    that slope, a straight edge's gradient piles up in one or two lines, while at a wrong slope it
 *    spreads. The lines considered pass within `k` of the candidate at the span's middle, plus
 *    however far that slope can move the edge from where the candidate saw it, so an upright card
 *    is measured exactly as without the search. Ties favour the smaller slope.
 * 2. Position: as {@link edgePosition} on those lines (the outermost strong response, to a
 *    fraction of a pixel), then each of the {@link EDGE_SEGMENTS} pieces is placed the same way
 *    near it; a line through the pieces refines the slope, without the piece that disagrees most
 *    when the fit is poor (e.g. under a finger).
 */
function fitEdge(
  sums: Sums,
  vertical: boolean,
  pos: number,
  k: number,
  a: number,
  z: number,
  outsideIsLow: boolean,
): EdgeLine {
  const n = vertical ? sums.w : sums.h;
  const centre = (a + z) / 2;
  const seg0 = new Array<number>(EDGE_SEGMENTS);
  const seg1 = new Array<number>(EDGE_SEGMENTS);
  for (let seg = 0; seg < EDGE_SEGMENTS; seg++) {
    seg0[seg] = a + Math.floor((seg * (z - a)) / EDGE_SEGMENTS);
    seg1[seg] = a + Math.floor(((seg + 1) * (z - a)) / EDGE_SEGMENTS);
  }
  const lineAt = (at: number, slope: number, seg: number, window: number) =>
    lineSum(sums, vertical, at, slope, centre, seg0[seg], seg1[seg], window);
  // Gradient along the 1-pixel line through index i at the middle, pieces' absolute values added.
  const lineProfile = (i: number, slope: number) => {
    let v = 0;
    for (let seg = 0; seg < EDGE_SEGMENTS; seg++) v += Math.abs(lineAt(i + 0.5, slope, seg, 0));
    return v;
  };

  // 1. Slant.
  let slope = 0;
  let reach = k;
  let bestScore = -1;
  const steps = Math.floor((Math.atan(MAX_EDGE_SLOPE) * 180) / Math.PI / SLOPE_STEP_DEG);
  for (let step = 0; step <= 2 * steps; step++) {
    const deg = (step % 2 === 1 ? (step + 1) / 2 : -step / 2) * SLOPE_STEP_DEG;
    const s = Math.tan((deg * Math.PI) / 180);
    const r = k + Math.ceil(Math.abs(s) * (z - a) * 0.5);
    let score = 0;
    let before = lineProfile(Math.max(0, pos - r - 1), s);
    for (let i = Math.max(1, pos - r); i <= Math.min(n - 1, pos + r); i++) {
      const v = lineProfile(i, s);
      if (v + before > score) score = v + before;
      before = v;
    }
    if (score > bestScore * 1.02) {
      bestScore = score;
      slope = s;
      reach = r;
    }
  }
  if (!(bestScore > 0)) return { mid: pos + 0.5, slope: 0, centre };

  // 2. Position: the outermost line with at least half the strongest response, as edgePosition.
  // A slanted card's border can look weak to the upright ranking that picked the candidate, so a
  // parallel line further out is looked for too (a printed edge inside the card, such as the
  // portrait's, may have been picked instead); an upright edge keeps the window of +-k.
  const outward = reach > k ? k + Math.ceil(Math.abs(slope) * (z - a)) : k;
  const from = Math.max(1, outsideIsLow ? pos - outward : pos - reach);
  const to = Math.min(n - 2, outsideIsLow ? pos + reach : pos + outward);
  const lo = Math.max(0, from - 3 * k);
  const hi = Math.min(n - 1, to + 3 * k);
  const profile = scratchFloat64("detect.fitProfile", n);
  profile.fill(0);
  for (let i = lo; i <= hi; i++) profile[i] = lineProfile(i, slope);
  let start = pos;
  if (reach > k) {
    let strongest = 0;
    for (let i = from; i <= to; i++) strongest = Math.max(strongest, profile[i]);
    const step = outsideIsLow ? 1 : -1;
    start = outsideIsLow ? from : to;
    while (profile[start] < strongest / 2) start += step;
    start = Math.max(1, Math.min(n - 2, start + k * step));
  }
  const mid0 = edgePosition(profile, start, k, outsideIsLow);
  const along: number[] = [];
  const across: number[] = [];
  const near = Math.round(mid0 - 0.5);
  for (let seg = 0; seg < EDGE_SEGMENTS; seg++) {
    if (seg1[seg] <= seg0[seg]) continue;
    profile.fill(0);
    for (let i = Math.max(0, near - 3 * k); i <= Math.min(n - 1, near + 3 * k); i++) {
      profile[i] = Math.abs(lineAt(i + 0.5, slope, seg, 0));
    }
    along.push((seg0[seg] + seg1[seg]) / 2 - centre);
    across.push(edgePosition(profile, near, k, outsideIsLow));
  }
  let fit = fitLine(along, across, mid0);
  if (along.length >= 3) {
    const residual = (i: number) => Math.abs(across[i] - fit.mid - fit.slope * along[i]);
    let worst = 0;
    for (let i = 1; i < along.length; i++) if (residual(i) > residual(worst)) worst = i;
    if (residual(worst) > Math.max(1, k / 2)) {
      along.splice(worst, 1);
      across.splice(worst, 1);
      fit = fitLine(along, across, mid0);
    }
  }
  // The pieces were placed along lines of the searched slope: their fit corrects it.
  const mid = fit.mid;
  slope = Math.max(-MAX_EDGE_SLOPE, Math.min(MAX_EDGE_SLOPE, slope + fit.slope));

  return { mid, slope, centre };
}

/**
 * Strength of an edge along a line through `line.mid` at `slope` over [a, z), as
 * {@link edgeStrength} (second-weakest piece, luma levels), and the gradient summed along it.
 */
function lineStrength(
  sums: Sums,
  vertical: boolean,
  line: EdgeLine,
  slope: number,
  k: number,
  a: number,
  z: number,
): { strength: number; signed: number } {
  let lowest = Infinity;
  let second = Infinity;
  let signed = 0;
  for (let seg = 0; seg < EDGE_SEGMENTS; seg++) {
    const s0 = a + Math.floor((seg * (z - a)) / EDGE_SEGMENTS);
    const s1 = a + Math.floor(((seg + 1) * (z - a)) / EDGE_SEGMENTS);
    const sum = lineSum(sums, vertical, line.mid, slope, line.centre, s0, s1, k);
    const v = s1 > s0 ? Math.abs(sum) / (s1 - s0) / SOBEL_STEP_GAIN : 0;
    signed += sum;
    if (v < lowest) {
      second = lowest;
      lowest = v;
    } else if (v < second) {
      second = v;
    }
  }
  return { strength: second, signed };
}

/**
 * Gradient summed across the edge over a window of +-`window` around a line of `slope` that sits
 * at `at` (pixel edges at integers) where the position along the edge is `centre`, over the span
 * [s0, s1) along it. The span is cut into runs short enough for the line to drift under a pixel.
 */
function lineSum(
  sums: Sums,
  vertical: boolean,
  at: number,
  slope: number,
  centre: number,
  s0: number,
  s1: number,
  window: number,
): number {
  if (slope === 0) return windowSum(sums, vertical, Math.round(at - 0.5), window, s0, s1);
  const run = Math.max(1, Math.floor(1 / Math.abs(slope)));
  let sum = 0;
  for (let r0 = s0; r0 < s1; r0 += run) {
    const r1 = Math.min(s1, r0 + run);
    sum += windowSum(sums, vertical, Math.round(at + slope * ((r0 + r1) / 2 - centre) - 0.5), window, r0, r1);
  }
  return sum;
}

/** Least-squares line `across = mid + slope * along`, slope clamped to {@link MAX_EDGE_SLOPE}. */
function fitLine(along: number[], across: number[], fallback: number): { mid: number; slope: number } {
  const count = along.length;
  if (count === 0) return { mid: fallback, slope: 0 };
  let ta = 0;
  let xa = 0;
  for (let i = 0; i < count; i++) {
    ta += along[i] / count;
    xa += across[i] / count;
  }
  let stt = 0;
  let stx = 0;
  for (let i = 0; i < count; i++) {
    stt += (along[i] - ta) ** 2;
    stx += (along[i] - ta) * (across[i] - xa);
  }
  const slope = stt > 0 ? Math.max(-MAX_EDGE_SLOPE, Math.min(MAX_EDGE_SLOPE, stx / stt)) : 0;
  return { mid: xa - slope * ta, slope };
}

/** Where a vertical and a horizontal edge line meet, as [x, y] in search-area pixels. */
function corner(v: EdgeLine, hz: EdgeLine): [number, number] {
  // x = v.mid + v.slope * (y - v.centre);  y = hz.mid + hz.slope * (x - hz.centre)
  const x = (v.mid + v.slope * (hz.mid - hz.slope * hz.centre - v.centre)) / (1 - v.slope * hz.slope);
  return [x, hz.mid + hz.slope * (x - hz.centre)];
}

/**
 * Typical response inside the box, measured like an edge ({@link edgeStrength}) on every column
 * and row at least 2k inside the box; the median over the columns and over the rows, and the
 * quieter of the two. Rows of a printed card cross text lines, which are long horizontal edges by
 * design, so their median says more about the layout than about noise or clutter.
 */
function interiorLevel(
  sums: Sums,
  l: number,
  r: number,
  t: number,
  b: number,
  k: number,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
): number {
  const nx = Math.max(0, r - l - 4 * k);
  const ny = Math.max(0, b - t - 4 * k);
  const values = scratchFloat64("detect.interior", Math.max(nx, ny, 1));
  let cols = Infinity;
  let rows = Infinity;
  if (nx > 0) {
    for (let i = 0; i < nx; i++) values[i] = edgeStrength(sums, true, l + 2 * k + i, k, r0, r1);
    cols = medianInPlace(values.subarray(0, nx));
  }
  if (ny > 0) {
    for (let i = 0; i < ny; i++) values[i] = edgeStrength(sums, false, t + 2 * k + i, k, c0, c1);
    rows = medianInPlace(values.subarray(0, ny));
  }
  const level = Math.min(cols, rows);
  return Number.isFinite(level) ? level : 0;
}

/** Whole-pixel span [a, b) between two edges, minus EDGE_INSET of its length at each end. */
function innerSpan(from: number, to: number, limit: number): [number, number] {
  const inset = (to - from) * EDGE_INSET;
  return [Math.max(0, Math.ceil(from + inset)), Math.min(limit, Math.floor(to - inset))];
}

/** Median of four numbers (the mean of the middle two). */
function median4(v: number[]): number {
  const sorted = [...v].sort((x, y) => x - y);
  return (sorted[1] + sorted[2]) / 2;
}

function ramp(v: number, lo: number, hi: number): number {
  if (!(v > lo)) return 0;
  return v >= hi ? 1 : (v - lo) / (hi - lo);
}

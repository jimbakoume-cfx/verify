// Per-region image measurements used by analyzeFrame. Integer arithmetic on the hot paths;
// sums are kept in JS numbers, which stay exact far beyond the sizes used here (< 2^53).
import type { GlareMeasure, GrayImage, LumaStats, Rect } from "./types";
import { assertGray, pixelBounds, scratchInt32, scratchUint32 } from "./pixels";

/** Luma at or above this counts as saturated (blown-out highlight, i.e. glare). */
export const SATURATED_LUMA = 250;

/**
 * Laplacian variance per unit of noise variance: the 4-neighbour kernel
 * [0 1 0; 1 -4 1; 0 1 0] has squared weights summing to 20, so independent noise of standard
 * deviation s adds 20 * s^2 to {@link laplacianVariance}.
 */
export const LAPLACIAN_NOISE_GAIN = 20;

// For Gaussian noise, median(|x|) = 0.6745 * standard deviation.
const MAD_TO_SIGMA = 1 / 0.6745;

/**
 * Variance of the 4-neighbour Laplacian inside `roi` (whole image by default): high when the
 * region has crisp detail, low when it is blurred or flat. Pixels on the image border are skipped.
 */
export function laplacianVariance(img: GrayImage, roi?: Rect | null): number {
  assertGray(img);
  const { x0, y0, x1, y1 } = pixelBounds(img, roi, 1);
  const n = (x1 - x0) * (y1 - y0);
  if (n === 0) return 0;
  const { width: w, data: d } = img;
  let sum = 0;
  let sumSq = 0;
  for (let y = y0; y < y1; y++) {
    let p = y * w + x0;
    for (let x = x0; x < x1; x++, p++) {
      const lap = d[p - w] + d[p + w] + d[p - 1] + d[p + 1] - 4 * d[p];
      sum += lap;
      sumSq += lap * lap;
    }
  }
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

// laplacianDetail: histogram of the Laplacian in bins of 1/32 level, +-128 levels (beyond: last bin).
const DETAIL_BINS_PER_LEVEL = 32;
const DETAIL_HALF_RANGE = 128 * DETAIL_BINS_PER_LEVEL;

/**
 * Fine detail that sensor noise cannot fake (levels squared), inside `roi` (whole image by default).
 *
 * The region is smoothed with a 5 x 5 binomial filter (Gaussian-like, sigma 1 px), which removes
 * most of the camera's grain while text strokes keep a strong Laplacian response. The variance of
 * that Laplacian is then reduced by the squared robust spread of the same response
 * (1.4826 x median absolute deviation): noise of any kind gives a bell-shaped response whose
 * variance this spread matches, while crisp text gives rare, strong responses (a heavy tail) that
 * the median ignores. Measuring the noise with the very operator that measures detail is what
 * keeps this correct for the spatially correlated grain of real phone previews (demosaicing,
 * denoising and resampling smear it over neighbouring pixels); a white-noise model of the grain
 * underestimates such noise several times over, and a blurred card in dim light then looks sharp.
 *
 * Pixels within 3 of the image border are skipped.
 */
export function laplacianDetail(img: GrayImage, roi?: Rect | null): number {
  assertGray(img);
  const { x0, y0, x1, y1 } = pixelBounds(img, roi, 3);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 3 || h < 3) return 0;
  const { width: W, data: d } = img;
  // Smoothed values are needed one pixel around the region (for the Laplacian), and the 5-tap
  // filter reads two more pixels beyond that: rows y0-3..y1+2 for the horizontal pass.
  const sw = w + 2;
  const sh = h + 2;
  const tmp = scratchInt32("detail.tmp", (sh + 4) * sw);
  for (let r = 0; r < sh + 4; r++) {
    let p = (y0 - 3 + r) * W + x0 - 1;
    const o = r * sw;
    for (let c = 0; c < sw; c++, p++) {
      tmp[o + c] = d[p - 2] + 4 * d[p - 1] + 6 * d[p] + 4 * d[p + 1] + d[p + 2];
    }
  }
  // Smoothed image in 1/256 levels.
  const s = scratchInt32("detail.smooth", sh * sw);
  for (let r = 0; r < sh; r++) {
    const o = r * sw;
    for (let c = 0; c < sw; c++) {
      const q = o + c;
      s[q] = tmp[q] + 4 * tmp[q + sw] + 6 * tmp[q + 2 * sw] + 4 * tmp[q + 3 * sw] + tmp[q + 4 * sw];
    }
  }
  const hist = scratchUint32("detail.hist", 2 * DETAIL_HALF_RANGE + 1);
  let sum = 0;
  let sumSq = 0;
  for (let r = 1; r < sh - 1; r++) {
    let q = r * sw + 1;
    for (let c = 1; c < sw - 1; c++, q++) {
      const lap = s[q - sw] + s[q + sw] + s[q - 1] + s[q + 1] - 4 * s[q];
      const v = lap / 256;
      sum += v;
      sumSq += v * v;
      // 256 / 32 = 8 units per bin, rounded to the nearest bin.
      const bin = (lap + 4) >> 3;
      hist[DETAIL_HALF_RANGE + (bin < -DETAIL_HALF_RANGE ? -DETAIL_HALF_RANGE : bin > DETAIL_HALF_RANGE ? DETAIL_HALF_RANGE : bin)]++;
    }
  }
  const n = w * h;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);

  // Median bin, then the median absolute deviation around it (folding the histogram).
  let below = 0;
  let m = 0;
  while (below + hist[m] < n / 2) below += hist[m++];
  const fold = scratchUint32("detail.fold", DETAIL_HALF_RANGE * 2 + 1);
  for (let i = 0; i < hist.length; i++) if (hist[i]) fold[Math.abs(i - m)] += hist[i];
  const mad = histogramMedian(fold, n) / DETAIL_BINS_PER_LEVEL;
  const spread = MAD_TO_SIGMA * mad;
  return Math.max(0, variance - spread * spread);
}

/**
 * Median of the values counted in `hist` (bin v covers [v - 0.5, v + 0.5)), interpolated inside
 * its bin; `n` is the total count.
 */
function histogramMedian(hist: Uint32Array, n: number): number {
  const half = n / 2;
  let below = 0;
  let v = 0;
  while (below + hist[v] < half) below += hist[v++];
  const within = (half - below) / hist[v];
  return v === 0 ? 0.5 * within : v - 0.5 + within;
}

/** Mean and variance of luma inside `roi` (whole image by default). */
export function lumaStats(img: GrayImage, roi?: Rect | null): LumaStats {
  assertGray(img);
  const { x0, y0, x1, y1 } = pixelBounds(img, roi);
  const count = (x1 - x0) * (y1 - y0);
  if (count === 0) return { mean: 0, variance: 0, count: 0 };
  const { width: w, data: d } = img;
  let sum = 0;
  let sumSq = 0;
  for (let y = y0; y < y1; y++) {
    const end = y * w + x1;
    for (let p = y * w + x0; p < end; p++) {
      const v = d[p];
      sum += v;
      sumSq += v * v;
    }
  }
  const mean = sum / count;
  return { mean, variance: Math.max(0, sumSq / count - mean * mean), count };
}

/** Mean luma (0..255) inside `roi` (whole image by default); 0 for an empty region. */
export function meanLuma(img: GrayImage, roi?: Rect | null): number {
  return lumaStats(img, roi).mean;
}

/**
 * Share of saturated pixels (luma >= {@link SATURATED_LUMA}) in `roi`, overall and in the worst tile.
 *
 * The region is split into a `tiles` x `tiles` grid. Tiles overlap by half (they step by half a
 * tile), so a hotspot sitting on a tile boundary is still seen whole by one of them.
 */
export function glare(img: GrayImage, roi?: Rect | null, tiles = 4): GlareMeasure {
  assertGray(img);
  if (!Number.isInteger(tiles) || tiles < 1) throw new RangeError(`tiles must be a positive integer, got ${tiles}`);
  const { x0, y0, x1, y1 } = pixelBounds(img, roi);
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw === 0 || rh === 0) return { ratio: 0, maxTileRatio: 0 };

  // Half-tile cells; a tile is a 2 x 2 block of cells.
  const cells = tiles === 1 ? 1 : 2 * tiles;
  const colCell = scratchInt32("glare.colCell", rw);
  for (let x = 0; x < rw; x++) colCell[x] = Math.floor((x * cells) / rw);
  const counts = scratchUint32("glare.counts", cells * cells);
  const { width: w, data: d } = img;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    const rowBase = Math.floor(((y - y0) * cells) / rh) * cells;
    let p = y * w + x0;
    for (let x = 0; x < rw; x++, p++) {
      if (d[p] >= SATURATED_LUMA) {
        counts[rowBase + colCell[x]]++;
        total++;
      }
    }
  }
  const ratio = total / (rw * rh);
  if (tiles === 1 || total === 0) return { ratio, maxTileRatio: ratio };

  // Pixel size of each cell, so tile ratios use their true area even when sizes are uneven.
  const cellW = (i: number) => Math.floor(((i + 1) * rw) / cells) - Math.floor((i * rw) / cells);
  const cellH = (j: number) => Math.floor(((j + 1) * rh) / cells) - Math.floor((j * rh) / cells);
  let maxTileRatio = 0;
  for (let j = 0; j + 1 < cells; j++) {
    const h = cellH(j) + cellH(j + 1);
    for (let i = 0; i + 1 < cells; i++) {
      const area = (cellW(i) + cellW(i + 1)) * h;
      if (area === 0) continue;
      const c = j * cells + i;
      const n = counts[c] + counts[c + 1] + counts[c + cells] + counts[c + cells + 1];
      if (n / area > maxTileRatio) maxTileRatio = n / area;
    }
  }
  return { ratio, maxTileRatio };
}

// The kernel below has squared weights summing to 36, so it multiplies noise std by 6.
const NOISE_KERNEL_GAIN = 6;
const MAX_NOISE_RESPONSE = 16 * 255;

/**
 * Estimates sensor noise (standard deviation in luma levels) inside `roi`.
 *
 * Filters with [1 -2 1] x [1 -2 1] (a second difference across and down), which gives zero on
 * flat areas, smooth gradients and straight horizontal or vertical edges such as card borders, so
 * what remains is mostly noise; the median then ignores the minority of pixels on text or corners.
 * Unbiased for a noisy flat area of white (pixel-independent) noise; overestimates somewhat on
 * dense fine texture. It reads several times too low for spatially correlated noise, as phone
 * previews have, which is why the blur check uses {@link laplacianDetail} and the steadiness check
 * {@link temporalNoise} instead.
 */
export function estimateNoise(img: GrayImage, roi?: Rect | null): number {
  assertGray(img);
  const { x0, y0, x1, y1 } = pixelBounds(img, roi, 1);
  const n = (x1 - x0) * (y1 - y0);
  if (n === 0) return 0;
  const hist = scratchUint32("noise.hist", MAX_NOISE_RESPONSE + 1);
  const { width: w, data: d } = img;
  for (let y = y0; y < y1; y++) {
    let p = y * w + x0;
    for (let x = x0; x < x1; x++, p++) {
      const up = p - w;
      const down = p + w;
      const r =
        d[up - 1] + d[up + 1] + d[down - 1] + d[down + 1] -
        2 * (d[up] + d[down] + d[p - 1] + d[p + 1]) +
        4 * d[p];
      hist[r < 0 ? -r : r]++;
    }
  }
  return (histogramMedian(hist, n) * MAD_TO_SIGMA) / NOISE_KERNEL_GAIN;
}

/**
 * Mean absolute difference between two frames of the same size (0..255): about 0 when nothing
 * moved, larger when the phone or the card moved between them.
 *
 * @throws RangeError when the sizes differ.
 */
export function frameMotion(prev: GrayImage, curr: GrayImage): number {
  assertGray(prev);
  assertGray(curr);
  if (prev.width !== curr.width || prev.height !== curr.height) {
    throw new RangeError(
      `frame sizes differ: ${prev.width}x${prev.height} vs ${curr.width}x${curr.height}`,
    );
  }
  const n = curr.width * curr.height;
  if (n === 0) return 0;
  const a = prev.data;
  const b = curr.data;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const diff = a[i] - b[i];
    sum += diff < 0 ? -diff : diff;
  }
  return sum / n;
}

/**
 * Sensor noise (standard deviation, levels) as it shows between two frames of the same size,
 * whatever its spatial correlation: the spread of `curr - prev` on the quarter of pixels where the
 * picture is flattest (lowest gradient of `prev + curr`). There, movement changes little, so what
 * differs is noise. For noise alone, `prev + curr` and `curr - prev` are independent, so picking
 * pixels by the first does not bias the second. Movement can only make it read higher. Every
 * other row and column is sampled, which is plenty for a median.
 *
 * @throws RangeError when the sizes differ.
 */
export function temporalNoise(prev: GrayImage, curr: GrayImage): number {
  assertGray(prev);
  assertGray(curr);
  if (prev.width !== curr.width || prev.height !== curr.height) {
    throw new RangeError(
      `frame sizes differ: ${prev.width}x${prev.height} vs ${curr.width}x${curr.height}`,
    );
  }
  const { width: w, height: h } = curr;
  const cols = Math.max(0, Math.ceil((w - 2) / 2));
  const rows = Math.max(0, Math.ceil((h - 2) / 2));
  const n = cols * rows;
  if (n === 0) return 0;
  const a = prev.data;
  const b = curr.data;
  const grads = scratchInt32("tnoise.grads", n);
  const diffs = scratchInt32("tnoise.diffs", n);
  const gradHist = scratchUint32("tnoise.gradHist", 4 * 510 + 1);
  let i = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1, p = y * w + 1; x < w - 1; x += 2, p += 2, i++) {
      const gx = a[p + 1] + b[p + 1] - a[p - 1] - b[p - 1];
      const gy = a[p + w] + b[p + w] - a[p - w] - b[p - w];
      const g = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
      grads[i] = g;
      gradHist[g]++;
      const diff = b[p] - a[p];
      diffs[i] = diff < 0 ? -diff : diff;
    }
  }
  // Gradient level below which the flattest quarter lies, then the median |difference| there.
  let limit = 0;
  for (let count = gradHist[0]; count < n / 4; ) count += gradHist[++limit];
  const diffHist = scratchUint32("tnoise.diffHist", 256);
  let selected = 0;
  for (let j = 0; j < n; j++) {
    if (grads[j] <= limit) {
      diffHist[diffs[j]]++;
      selected++;
    }
  }
  // |difference| of two noise samples: median = 0.6745 x sqrt(2) x their standard deviation.
  return (histogramMedian(diffHist, selected) * MAD_TO_SIGMA) / Math.SQRT2;
}

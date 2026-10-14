// Dark-on-light thresholding for the MRZ pipeline: Otsu's global threshold and a local-mean
// (Bradley) mask. Both mark "ink" (darker than the paper around it).
import type { GrayImage } from "../types";
import type { Bounds } from "../pixels";

/** 256-bin histogram of `img` inside `bounds`. */
export function histogram(img: GrayImage, bounds: Bounds): Uint32Array {
  const hist = new Uint32Array(256);
  const { width: w, data } = img;
  for (let y = bounds.y0; y < bounds.y1; y++) {
    let p = y * w + bounds.x0;
    for (let x = bounds.x0; x < bounds.x1; x++, p++) hist[data[p]]++;
  }
  return hist;
}

/**
 * Otsu's threshold: the level that best splits the histogram into two classes (largest
 * between-class variance). Pixels at or below it are the dark class. 127 for an empty histogram.
 */
export function otsuThreshold(hist: ArrayLike<number>): number {
  let total = 0;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) {
    total += hist[v];
    sumAll += v * hist[v];
  }
  if (total === 0) return 127;
  let weightDark = 0;
  let sumDark = 0;
  let best = -1;
  let threshold = 127;
  for (let v = 0; v < 256; v++) {
    weightDark += hist[v];
    if (weightDark === 0) continue;
    const weightLight = total - weightDark;
    if (weightLight === 0) break;
    sumDark += v * hist[v];
    const meanDark = sumDark / weightDark;
    const meanLight = (sumAll - sumDark) / weightLight;
    const between = weightDark * weightLight * (meanDark - meanLight) ** 2;
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  return threshold;
}

/** Level below which `share` (0..1) of the histogram's pixels lie. */
export function percentile(hist: ArrayLike<number>, share: number): number {
  let total = 0;
  for (let v = 0; v < 256; v++) total += hist[v];
  const target = share * total;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen > target) return v;
  }
  return 255;
}

export interface LocalInkOptions {
  /** Half the side of the square window the local mean is taken over, in pixels. */
  radius: number;
  /** A pixel is ink when it is at least this share darker than its local mean (Bradley's t). */
  darker: number;
  /** ...and at least this many levels darker, so sensor noise on flat paper is never ink. */
  minContrast: number;
}

/**
 * Ink mask of `bounds` (1 = ink, row-major, bounds-sized): pixels clearly darker than the mean of
 * the window around them (Bradley and Roth's adaptive threshold). Unlike one global threshold, it
 * keeps working when the light falls off across the card or a shadow covers part of it.
 */
export function localInkMask(img: GrayImage, bounds: Bounds, options: LocalInkOptions): Uint8Array {
  const { x0, y0, x1, y1 } = bounds;
  const w = x1 - x0;
  const h = y1 - y0;
  const mask = new Uint8Array(w * h);
  if (w === 0 || h === 0) return mask;
  // Integral image with a zero row and column: sums stay below 255 x 1600 x 1600 < 2^31.
  const iw = w + 1;
  const integral = new Int32Array(iw * (h + 1));
  const { width: W, data } = img;
  for (let y = 0; y < h; y++) {
    let row = 0;
    let p = (y0 + y) * W + x0;
    const o = (y + 1) * iw;
    for (let x = 0; x < w; x++, p++) {
      row += data[p];
      integral[o + x + 1] = integral[o - iw + x + 1] + row;
    }
  }
  const r = Math.max(1, Math.round(options.radius));
  const keep = 1 - options.darker;
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h, y + r + 1);
    let p = (y0 + y) * W + x0;
    for (let x = 0; x < w; x++, p++) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(w, x + r + 1);
      const area = (yb - ya) * (xb - xa);
      const sum = integral[yb * iw + xb] - integral[ya * iw + xb] - integral[yb * iw + xa] + integral[ya * iw + xa];
      const v = data[p] * area;
      if (v <= sum * keep && sum - v >= options.minContrast * area) mask[y * w + x] = 1;
    }
  }
  return mask;
}

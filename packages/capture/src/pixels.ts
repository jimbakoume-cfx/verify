// Internal helpers: integer pixel bounds and reusable scratch buffers.
import type { GrayImage, Rect } from "./types";

/** Whole-pixel region [x0, x1) x [y0, y1), always inside the image (may be empty). */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Rounds `roi` to whole pixels and clamps it to the image, keeping `border` pixels away from
 * the image edge (3x3 filters need one neighbour on each side). No roi = the whole image.
 */
export function pixelBounds(img: GrayImage, roi?: Rect | null, border = 0): Bounds {
  let x0 = 0;
  let y0 = 0;
  let x1 = img.width;
  let y1 = img.height;
  if (roi) {
    x0 = Math.round(roi.x);
    y0 = Math.round(roi.y);
    x1 = Math.round(roi.x + roi.width);
    y1 = Math.round(roi.y + roi.height);
  }
  x0 = Math.max(x0, border);
  y0 = Math.max(y0, border);
  x1 = Math.min(x1, img.width - border);
  y1 = Math.min(y1, img.height - border);
  if (x1 < x0) x1 = x0;
  if (y1 < y0) y1 = y0;
  return { x0, y0, x1, y1 };
}

export function assertGray(img: GrayImage): void {
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`invalid image size ${width}x${height}`);
  }
  if (data.length < width * height) {
    throw new RangeError(`image data too short: ${data.length} < ${width * height}`);
  }
}

// The analysis runs ~8 times per second in one worker. Its functions are synchronous and
// never nest uses of the same buffer, so module-level buffers that only grow are safe and
// keep the loop free of per-frame allocations.
const int32Pool = new Map<string, Int32Array>();
const float64Pool = new Map<string, Float64Array>();

/** A zero-filled Int32Array of `length`, reused between calls with the same `key`. */
export function scratchInt32(key: string, length: number): Int32Array {
  let buf = int32Pool.get(key);
  if (!buf || buf.length < length) {
    buf = new Int32Array(Math.max(length, 1024));
    int32Pool.set(key, buf);
  }
  const view = buf.subarray(0, length);
  view.fill(0);
  return view;
}

const uint32Pool = new Map<string, Uint32Array>();

/** A zero-filled Uint32Array of `length`, reused between calls with the same `key`. */
export function scratchUint32(key: string, length: number): Uint32Array {
  let buf = uint32Pool.get(key);
  if (!buf || buf.length < length) {
    buf = new Uint32Array(Math.max(length, 256));
    uint32Pool.set(key, buf);
  }
  const view = buf.subarray(0, length);
  view.fill(0);
  return view;
}

/** A Float64Array of `length` (contents unspecified), reused between calls with the same `key`. */
export function scratchFloat64(key: string, length: number): Float64Array {
  let buf = float64Pool.get(key);
  if (!buf || buf.length < length) {
    buf = new Float64Array(Math.max(length, 256));
    float64Pool.set(key, buf);
  }
  return buf.subarray(0, length);
}

/** Median of `values` (sorted in place). 0 for an empty array. */
export function medianInPlace(values: Float64Array): number {
  const n = values.length;
  if (n === 0) return 0;
  values.sort();
  return n % 2 === 1 ? values[n >> 1] : (values[n / 2 - 1] + values[n / 2]) / 2;
}

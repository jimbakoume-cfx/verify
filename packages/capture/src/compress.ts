// Size of the uploaded image and the JPEG quality search. No DOM here: the caller supplies the
// encoder (canvas.toBlob in the rider app), so this stays testable and works with any blob type.
import { CAPTURE_LIMITS } from "../../../supabase/functions/_shared/contract";
import type { CompressionResult, OutputSize } from "./types";

/** JPEG qualities tried in order (spec). */
export const COMPRESSION_QUALITIES: readonly number[] = Object.freeze([0.88, 0.8, 0.72, 0.64, 0.56]);
/** Extra downscales tried in order, each with every quality (spec). */
export const COMPRESSION_SCALES: readonly number[] = Object.freeze([1, 0.8]);

/**
 * Pixel size to draw a crop of `cropW` x `cropH` at: shrunk so the long side is at most
 * `maxLongSide`, never enlarged, aspect kept.
 */
export function outputSize(
  cropW: number,
  cropH: number,
  maxLongSide: number = CAPTURE_LIMITS.maxLongSide,
): OutputSize {
  if (!(cropW > 0) || !(cropH > 0) || !(maxLongSide > 0)) {
    throw new RangeError(`invalid sizes: crop ${cropW}x${cropH}, maxLongSide ${maxLongSide}`);
  }
  const scale = Math.min(1, maxLongSide / Math.max(cropW, cropH));
  return {
    width: Math.max(1, Math.round(cropW * scale)),
    height: Math.max(1, Math.round(cropH * scale)),
    scale,
  };
}

/**
 * Scales for {@link compressToTarget} that keep the long side at or above the server's minimum:
 * `[1, 0.8]` normally; for a smaller image the fallback shrinks only down to `minLongSide`, and
 * an image already at or below it is not shrunk at all (`[1]`).
 */
export function compressionScales(
  longSide: number,
  minLongSide: number = CAPTURE_LIMITS.minLongSide,
): number[] {
  const fallback = COMPRESSION_SCALES[1];
  if (longSide * fallback >= minLongSide) return [...COMPRESSION_SCALES];
  if (longSide > minLongSide) return [1, minLongSide / longSide];
  return [1];
}

export interface CompressionOptions {
  /** JPEG qualities to try at each scale, best first. Default {@link COMPRESSION_QUALITIES}. */
  qualities?: readonly number[];
  /** Scales to try, largest first. Default {@link COMPRESSION_SCALES}; see {@link compressionScales}. */
  scales?: readonly number[];
}

/**
 * Finds the best-looking encoding that fits the size target: tries each quality at scale 1, then
 * the same qualities at scale 0.8, and returns the first result of at most `target` bytes. When
 * none fits, returns the smallest one produced.
 *
 * @param encode Encodes the still at a JPEG quality (0..1) and an extra scale (1 = the
 *   {@link outputSize}); e.g. draw at `outputSize * scale`, then `canvas.toBlob(cb, "image/jpeg", quality)`.
 * @param target Size limit in bytes (default `CAPTURE_LIMITS.targetBytes`).
 *
 * @example
 * const { blob, quality, scale } = await compressToTarget((q, s) => encodeJpeg(still, q, s));
 */
export async function compressToTarget<B extends { size: number }>(
  encode: (quality: number, scale: number) => Promise<B>,
  target: number = CAPTURE_LIMITS.targetBytes,
  options: CompressionOptions = {},
): Promise<CompressionResult<B>> {
  const qualities = options.qualities ?? COMPRESSION_QUALITIES;
  const scales = options.scales ?? COMPRESSION_SCALES;
  if (qualities.length === 0 || scales.length === 0) {
    throw new RangeError("compressToTarget needs at least one quality and one scale");
  }
  let smallest: CompressionResult<B> | null = null;
  let attempts = 0;
  for (const scale of scales) {
    for (const quality of qualities) {
      const blob = await encode(quality, scale);
      attempts++;
      if (blob.size <= target) return { blob, quality, scale, attempts };
      if (!smallest || blob.size < smallest.blob.size) smallest = { blob, quality, scale, attempts };
    }
  }
  // Non-null: at least one attempt ran. Report the total number of attempts made.
  return { ...smallest!, attempts };
}

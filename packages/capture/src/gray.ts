import type { GrayImage } from "./types";

/**
 * Converts RGBA pixels (e.g. `ImageData.data`) to 8-bit grayscale with Rec. 601 luma
 * (0.299 R + 0.587 G + 0.114 B), using integer weights 77/150/29 out of 256.
 *
 * @param out Optional buffer of at least `width * height` bytes to write into, so a capture loop
 *   can reuse two buffers instead of allocating one per frame. Do not pass the buffer that still
 *   holds the previous frame you are about to compare against.
 */
export function toGray(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  out?: Uint8Array,
): GrayImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`invalid image size ${width}x${height}`);
  }
  const n = width * height;
  if (rgba.length < n * 4) throw new RangeError(`RGBA data too short: ${rgba.length} < ${n * 4}`);
  if (out && out.length < n) throw new RangeError(`output buffer too short: ${out.length} < ${n}`);
  const data = out ? out.subarray(0, n) : new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // 77 + 150 + 29 = 256, so the result never exceeds 255; +128 rounds to nearest.
    data[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2] + 128) >> 8;
  }
  return { width, height, data };
}

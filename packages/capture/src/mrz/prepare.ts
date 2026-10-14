// Turns the located MRZ band into the image the OCR engine reads: cut out and straightened,
// contrast stretched, scaled so the characters are about 32 px tall (Tesseract reads best between
// 20 and 40 px; phone stills give 15-25 px), binarised, with a white border.
import { assertGray } from "../pixels";
import type { GrayImage } from "../types";
import type { MrzBand } from "./locate";
import { histogram, localInkMask, otsuThreshold, percentile } from "./threshold";

/**
 * "local" (default): a threshold from the mean around each pixel, so a shadow or uneven light
 * across the band does not swallow characters.
 * "otsu": one threshold for the whole band; the reader's second try when "local" does not read.
 * "none": keep the stretched gray levels.
 *
 * Measured with the real OCR on 32 rendered stills (tilt up to 4 degrees, shadows, blur, JPEG
 * q35, noise, dim light, faint ink, 14-47 px characters) at 24, 32 and 40 px: local read 31-32,
 * Otsu 24-27 (it loses shadowed characters), gray levels 22-25.
 */
export type MrzBinarization = "otsu" | "local" | "none";

export interface PrepareOptions {
  /** Character height to scale to, in pixels. */
  targetCharHeight?: number;
  /** The output (border excluded) is never wider than this, in pixels. */
  maxWidth?: number;
  /** White margin added on every side, in pixels. */
  border?: number;
  binarization?: MrzBinarization;
}

export const PREPARE_DEFAULTS: Required<PrepareOptions> = {
  targetCharHeight: 32,
  // 44 characters at 32 px tall take about 1500 px; room for the margin and a loose band.
  maxWidth: 2200,
  border: 16,
  binarization: "local",
};

/** Upscaling beyond this only magnifies blur; below the minimum the strokes would vanish. */
const MAX_SCALE = 4;
const MIN_SCALE = 0.4;

/**
 * Cuts `band` out of `image`, turned upright by its angle and scaled to the target character
 * height, then stretches the contrast, binarises and adds a white border. Dark text on white.
 */
export function prepareForOcr(image: GrayImage, band: MrzBand, options: PrepareOptions = {}): GrayImage {
  assertGray(image);
  const { targetCharHeight, maxWidth, border, binarization } = { ...PREPARE_DEFAULTS, ...options };
  const { rect } = band;
  let scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetCharHeight / Math.max(1, band.charHeight)));
  if (rect.width * scale > maxWidth) scale = maxWidth / rect.width;
  const outW = Math.max(1, Math.round(rect.width * scale));
  const outH = Math.max(1, Math.round(rect.height * scale));
  const crop = resample(image, band, scale, outW, outH);

  // Stretch: the darkest 1% become black, the lightest 1% white.
  const all = { x0: 0, y0: 0, x1: outW, y1: outH };
  const hist = histogram(crop, all);
  const lo = percentile(hist, 0.01);
  const hi = Math.max(lo + 1, percentile(hist, 0.99));
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / (hi - lo))));
  const data = crop.data;
  for (let i = 0; i < data.length; i++) data[i] = lut[data[i]];

  if (binarization === "otsu") {
    const t = otsuThreshold(histogram(crop, all));
    for (let i = 0; i < data.length; i++) data[i] = data[i] <= t ? 0 : 255;
  } else if (binarization === "local") {
    // 0.7 x the local mean: about midway between ink and paper next to text (a window holds
    // 10-20% ink), so strokes keep their weight and neighbouring characters stay apart.
    const ink = localInkMask(crop, all, { radius: targetCharHeight, darker: 0.3, minContrast: 24 });
    for (let i = 0; i < data.length; i++) data[i] = ink[i] ? 0 : 255;
  }
  return addBorder(crop, border);
}

/**
 * Samples the band at `scale`, turned by -angle so its lines run level. Bilinear; when shrinking,
 * several samples per output pixel are averaged so thin strokes are not skipped.
 */
function resample(image: GrayImage, band: MrzBand, scale: number, outW: number, outH: number): GrayImage {
  const { width: W, height: H, data: src } = image;
  const { rect } = band;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const a = (band.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const sub = Math.max(1, Math.ceil(1 / scale));
  const out = new Uint8Array(outW * outH);
  const sample = (x: number, y: number): number => {
    const fx = Math.min(W - 1, Math.max(0, x - 0.5));
    const fy = Math.min(H - 1, Math.max(0, y - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = src[y0 * W + x0] * (1 - tx) + src[y0 * W + x1] * tx;
    const bottom = src[y1 * W + x0] * (1 - tx) + src[y1 * W + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      let acc = 0;
      for (let j = 0; j < sub; j++) {
        for (let i = 0; i < sub; i++) {
          // Position in the upright band, relative to its centre, in still pixels.
          const lx = (u + (i + 0.5) / sub) / scale - rect.width / 2;
          const ly = (v + (j + 0.5) / sub) / scale - rect.height / 2;
          acc += sample(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
        }
      }
      out[v * outW + u] = Math.round(acc / (sub * sub));
    }
  }
  return { width: outW, height: outH, data: out };
}

function addBorder(img: GrayImage, border: number): GrayImage {
  const b = Math.max(0, Math.round(border));
  const width = img.width + 2 * b;
  const height = img.height + 2 * b;
  const data = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < img.height; y++) {
    data.set(img.data.subarray(y * img.width, (y + 1) * img.width), (y + b) * width + b);
  }
  return { width, height, data };
}

/** The image turned 180 degrees (a card held upside down). */
export function rotateGray180(image: GrayImage): GrayImage {
  assertGray(image);
  const n = image.width * image.height;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = image.data[n - 1 - i];
  return { width: image.width, height: image.height, data };
}

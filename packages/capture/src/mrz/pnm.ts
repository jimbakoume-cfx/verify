// 8-bit grayscale PGM ("P5"), the image format handed to the OCR engine and used by the MRZ test
// fixtures. Tesseract's image library (Leptonica) reads it natively, and it is just a short text
// header plus the pixels, so the bytes are built the same way in the browser and in Node: the
// tests then exercise exactly the path the phone uses.
import { assertGray } from "../pixels";
import type { GrayImage } from "../types";

/** Encodes `image` as a binary PGM (P5, maxval 255). */
export function encodePgm(image: GrayImage): Uint8Array {
  assertGray(image);
  const header = new TextEncoder().encode(`P5\n${image.width} ${image.height}\n255\n`);
  const n = image.width * image.height;
  const out = new Uint8Array(header.length + n);
  out.set(header, 0);
  out.set(image.data.subarray(0, n), header.length);
  return out;
}

/**
 * Decodes a binary PGM (P5) with a maxval of at most 255; `#` comments in the header are allowed.
 * Levels are rescaled to 0..255 when maxval is lower. Throws on anything else.
 */
export function decodePgm(bytes: Uint8Array): GrayImage {
  let pos = 0;
  const token = (): string => {
    // Skip whitespace and comments, then read up to the next whitespace.
    for (;;) {
      while (pos < bytes.length && isSpace(bytes[pos])) pos++;
      if (bytes[pos] !== 0x23) break;
      while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
    }
    const start = pos;
    while (pos < bytes.length && !isSpace(bytes[pos])) pos++;
    return String.fromCharCode(...bytes.subarray(start, pos));
  };
  if (token() !== "P5") throw new Error("not a binary PGM (P5)");
  const width = Number(token());
  const height = Number(token());
  const maxval = Number(token());
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("invalid PGM size");
  }
  if (!Number.isInteger(maxval) || maxval < 1 || maxval > 255) throw new Error("unsupported PGM maxval");
  pos++; // the single whitespace character after maxval
  const n = width * height;
  if (bytes.length - pos < n) throw new Error("PGM data too short");
  const data = bytes.slice(pos, pos + n);
  if (maxval !== 255) {
    for (let i = 0; i < n; i++) data[i] = Math.round((Math.min(data[i], maxval) * 255) / maxval);
  }
  return { width, height, data };
}

function isSpace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
}

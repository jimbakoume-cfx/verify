// Minimal JPEG inspection: the magic bytes and the frame size from the SOF header. Nothing is decoded,
// so a malicious file cannot reach an image decoder here; pixel checks belong to the M3 worker.

export interface JpegSize {
  width: number;
  height: number;
}

/** SOI marker followed by the start of another marker. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

// Start-of-frame markers (baseline, extended, progressive, lossless, arithmetic). C4 (DHT), C8 (JPG)
// and CC (DAC) share the range but are not frame headers.
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Walks the marker segments up to the first SOF. Returns null for anything malformed or truncated. */
export function readJpegSize(bytes: Uint8Array): JpegSize | null {
  if (!isJpeg(bytes)) return null;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    while (i < bytes.length && bytes[i] === 0xff) i++; // fill bytes
    if (i >= bytes.length) return null;
    const marker = bytes[i++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone markers
    // Stuffed zero, a second SOI, end of image or image data before any frame header: not a usable file.
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null;

    if (i + 2 > bytes.length) return null;
    const length = (bytes[i] << 8) | bytes[i + 1]; // includes the two length bytes
    if (length < 2 || i + length > bytes.length) return null;

    if (SOF_MARKERS.has(marker)) {
      // Lf(2) P(1) Y(2) X(2) Nf(1), then 3 bytes per component.
      if (length < 8) return null;
      const height = (bytes[i + 3] << 8) | bytes[i + 4];
      const width = (bytes[i + 5] << 8) | bytes[i + 6];
      const components = bytes[i + 7];
      // Height 0 means "defined later by a DNL marker": not something our encoder produces.
      if (width === 0 || height === 0 || components === 0 || length < 8 + 3 * components) return null;
      return { width, height };
    }
    i += length;
  }
  return null;
}

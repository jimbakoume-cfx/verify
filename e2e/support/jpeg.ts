// Reads the structure of an uploaded JPEG without decoding it: the marker segments and the frame
// size. Enough to check what the rider app sends (a canvas JPEG: no EXIF, no GPS).

export interface JpegInfo {
  width: number;
  height: number;
  /** Marker bytes in file order, up to the start of the image data (e.g. 0xe0 = APP0/JFIF). */
  markers: number[];
}

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP1 = 0xe1;

/** Start-of-frame markers carry the image size; 0xc4 (DHT), 0xc8 (JPG) and 0xcc (DAC) do not. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** The JPEG's markers and size, or null when `bytes` is not a well-formed JPEG header. */
export function inspectJpeg(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const markers: number[] = [];
  let width = 0;
  let height = 0;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    markers.push(marker);
    if (marker === SOS || marker === EOI) break;
    const length = view.getUint16(i + 2);
    if (isStartOfFrame(marker) && i + 9 <= bytes.length) {
      height = view.getUint16(i + 5);
      width = view.getUint16(i + 7);
    }
    i += 2 + length;
  }
  return width > 0 && height > 0 ? { width, height, markers } : null;
}

/** An APP1 segment holds EXIF (camera, time, GPS) or XMP metadata: a canvas JPEG has none. */
export function hasApp1(info: JpegInfo): boolean {
  return info.markers.includes(APP1);
}

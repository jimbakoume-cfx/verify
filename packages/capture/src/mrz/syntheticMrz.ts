// Synthetic stills for the MRZ pixel tests: a card back (TD1) or passport page (TD3) as the rider's
// still shows it (guide + 4%), with blocky 5x7 glyphs at the ICAO pitch, some printed text above,
// on a textured table. Options add tilt, a smaller document, a shadow, blur and noise.
// Deterministic for a given seed. Test support only: not exported from the package.
import { gaussianBlur, addNoise, rng } from "../test-support/synthetic";
import type { GrayImage, Rect } from "../types";

export type SyntheticFormat = "TD1" | "TD3";

const DOC_MM: Record<SyntheticFormat, [number, number]> = { TD1: [85.6, 53.98], TD3: [125, 88] };
const LINES: Record<SyntheticFormat, { count: number; chars: number; leftMm: number; baselinesMm: number[] }> = {
  // Baselines above the bottom edge, bottom line first.
  TD1: { count: 3, chars: 30, leftMm: 4.7, baselinesMm: [3.6, 7.9, 12.2] },
  TD3: { count: 2, chars: 44, leftMm: 6.6, baselinesMm: [4.6, 9.2] },
};
const PITCH_MM = 2.54;
const CAP_MM = 2.4;
const GLYPH_W_MM = 1.9;

export interface MrzStillOptions {
  format: SyntheticFormat;
  /** Width of the still in pixels; its height follows the document's aspect. */
  width: number;
  /** Document width / guide width (1 = fills the guide). */
  docScale?: number;
  /** Clockwise tilt of the document, degrees. */
  angleDeg?: number;
  /** Draw the code lines (default true). */
  mrz?: boolean;
  /** Draw the document upside down. */
  upsideDown?: boolean;
  paper?: number;
  ink?: number;
  table?: number;
  /** Darkens the still by `factor` inside `rect` (shares of the still's width and height). */
  shadow?: { rect: Rect; factor: number };
  blur?: number;
  noise?: number;
  seed?: number;
}

export interface MrzStill {
  image: GrayImage;
  /** Axis-aligned bounds of the code-line characters in the still (before any tilt is applied). */
  mrzRect: Rect;
  /** Height of the characters in still pixels. */
  charHeight: number;
  /** Pixels per mm on the document. */
  pxPerMm: number;
}

/** A 5x7 glyph: '<' is a chevron; any other character gets a fixed pattern with a vertical stem. */
function glyph(char: string): boolean[] {
  const cells = new Array<boolean>(35).fill(false);
  if (char === "<") {
    for (let row = 1; row <= 5; row++) cells[row * 5 + Math.abs(row - 3) + 1] = true;
    return cells;
  }
  const random = rng(char.charCodeAt(0) * 2654435761);
  const stem = random() < 0.5 ? 0 : 4;
  for (let row = 0; row < 7; row++) cells[row * 5 + stem] = true;
  for (let i = 0; i < 35; i++) if (random() < 0.3) cells[i] = true;
  return cells;
}

const SAMPLE_LINES: Record<SyntheticFormat, string[]> = {
  TD1: ["IDUTOSP01234566<<<<<<<<<<<<<<<", "9002155F3501014UTO<<<<<<<<<<<8", "SPECIMEN<<TEST<CARD<<<<<<<<<<<"],
  TD3: ["P<UTOSPECIMEN<<TEST<PASSPORT<<<<<<<<<<<<<<<<", "SP76543217UTO8507044M3306301TEST0042<<<<<<08"],
};

const cache = new Map<string, MrzStill>();

/**
 * Renders a still; see the file comment. Stills are cached by their options (tests share them):
 * do not modify the returned image.
 */
export function makeMrzStill(options: MrzStillOptions): MrzStill {
  const key = JSON.stringify(options);
  let still = cache.get(key);
  if (!still) {
    still = render(options);
    cache.set(key, still);
  }
  return still;
}

function render(options: MrzStillOptions): MrzStill {
  const { format, width } = options;
  const [docW, docH] = DOC_MM[format];
  const height = Math.round((width * docH) / docW);
  const guideW = width / 1.04;
  const pxPerMm = (guideW * (options.docScale ?? 1)) / docW;
  const paper = options.paper ?? 215;
  const ink = options.ink ?? 35;
  const table = options.table ?? 70;
  const layout = LINES[format];
  const lines = SAMPLE_LINES[format];
  const glyphs = new Map<string, boolean[]>();
  for (const c of lines.join("")) if (!glyphs.has(c)) glyphs.set(c, glyph(c));
  const table2 = rng((options.seed ?? 1) * 7919 + 3);
  const grain = Array.from({ length: 64 }, () => (table2() - 0.5) * 16);

  // Document content at (u, v) in mm from its top-left corner.
  const docLevel = (u: number, v: number): number => {
    if (options.upsideDown) {
      u = docW - u;
      v = docH - v;
    }
    // Printed fields: three lines of blocks in the upper half.
    for (let k = 0; k < 3; k++) {
      const top = 8 + k * 7;
      if (v >= top && v < top + 2 && u >= 5 && u < 5 + 30 + 8 * k && Math.floor(u / 1.6) % 4 !== 3) {
        return (Math.floor(u / 0.8) + k) % 2 === 0 ? ink + 20 : paper;
      }
    }
    if (options.mrz === false) return paper;
    for (let l = 0; l < layout.count; l++) {
      const base = docH - layout.baselinesMm[layout.count - 1 - l];
      if (v < base - CAP_MM || v >= base) continue;
      const i = Math.floor((u - layout.leftMm) / PITCH_MM);
      if (i < 0 || i >= layout.chars) continue;
      const cu = u - layout.leftMm - i * PITCH_MM;
      if (cu >= GLYPH_W_MM) continue;
      const col = Math.floor((cu / GLYPH_W_MM) * 5);
      const row = Math.floor(((v - (base - CAP_MM)) / CAP_MM) * 7);
      if (glyphs.get(lines[l][i])![row * 5 + col]) return ink;
    }
    return paper;
  };

  const angle = ((options.angleDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = width / 2;
  const cy = height / 2;
  const data = new Uint8Array(width * height);
  const sub = 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let j = 0; j < sub; j++) {
        for (let i = 0; i < sub; i++) {
          const dx = x + (i + 0.5) / sub - cx;
          const dy = y + (j + 0.5) / sub - cy;
          // Undo the clockwise tilt, then to mm from the document's top-left corner.
          const u = (cos * dx + sin * dy) / pxPerMm + docW / 2;
          const v = (-sin * dx + cos * dy) / pxPerMm + docH / 2;
          if (u >= 0 && u < docW && v >= 0 && v < docH) acc += docLevel(u, v);
          else acc += table + grain[(Math.floor(x / 3) * 7 + Math.floor(y / 2) * 13) & 63];
        }
      }
      data[y * width + x] = Math.round(acc / (sub * sub));
    }
  }
  let image: GrayImage = { width, height, data };
  if (options.shadow) {
    const { rect, factor } = options.shadow;
    const out = new Uint8Array(data);
    for (let y = Math.round(rect.y * height); y < Math.round((rect.y + rect.height) * height); y++) {
      for (let x = Math.round(rect.x * width); x < Math.round((rect.x + rect.width) * width); x++) {
        out[y * width + x] = Math.round(out[y * width + x] * factor);
      }
    }
    image = { width, height, data: out };
  }
  if (options.blur) image = gaussianBlur(image, options.blur);
  if (options.noise) image = addNoise(image, options.noise, options.seed ?? 7);

  const left = cx + (layout.leftMm - docW / 2) * pxPerMm;
  const top = cy + (docH / 2 - layout.baselinesMm[layout.count - 1] - CAP_MM) * pxPerMm;
  const bottom = cy + (docH / 2 - layout.baselinesMm[0]) * pxPerMm;
  const right = left + ((layout.chars - 1) * PITCH_MM + GLYPH_W_MM) * pxPerMm;
  return {
    image,
    mrzRect: { x: left, y: top, width: right - left, height: bottom - top },
    charHeight: CAP_MM * pxPerMm,
    pxPerMm,
  };
}

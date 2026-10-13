// Synthetic test images for the capture engine: a document-like card (guilloche-style
// background, header band, portrait box, text lines, two MRZ-like lines) placed on a
// background, plus the degradations a phone camera produces. Deterministic for a given seed.
// Test support only: not exported from the package.
import type { GrayImage, Rect } from "../types";

/** xorshift32 pseudo-random generator returning numbers in [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Standard normal sample (Box-Muller). */
export function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** ID-1 card aspect (85.60 x 53.98 mm), as in DOCUMENT_ASPECT. */
export const CARD_ASPECT = 85.6 / 53.98;
/** Analysis image width used by the rider app. */
export const SCENE_WIDTH = 480;
/** Guide width inside the analysis image (the crop is the guide grown by 20%). */
export const GUIDE_WIDTH = 400;

/** Scene size and guide, as `analysisCrop` produces them for an ID-1 guide. */
export function sceneGeometry(): { width: number; height: number; guide: Rect } {
  const guideH = GUIDE_WIDTH / CARD_ASPECT;
  const height = Math.round(guideH * 1.2);
  return {
    width: SCENE_WIDTH,
    height,
    guide: { x: (SCENE_WIDTH - GUIDE_WIDTH) / 2, y: (height - guideH) / 2, width: GUIDE_WIDTH, height: guideH },
  };
}

export type CardStyle = "light" | "dark";
export type Background = "dark" | "light" | "cluttered" | number;

export interface SceneOptions {
  /** Card width / guide width. Default 0.95. */
  scale?: number;
  /** Card centre offset from the guide centre, as a share of the guide width / height. */
  offsetX?: number;
  offsetY?: number;
  /** Clockwise tilt of the card, degrees. */
  angleDeg?: number;
  /**
   * Perspective of a phone pitched over the card: the card's bottom edge is this fraction wider
   * than its top edge (negative: narrower), its sides converge. Applied before the tilt.
   */
  keystone?: number;
  /** "light" card (default), "dark" card, or no card at all. */
  card?: CardStyle | "none";
  /** Default: "dark" for a light card, "light" for a dark card. */
  background?: Background;
  seed?: number;
}

export interface Scene {
  image: GrayImage;
  guide: Rect;
  /** The card's untilted rectangle in image pixels; null without a card. */
  card: Rect | null;
  /**
   * Axis-aligned bounds of every card pixel, tilt and rounded corners included (equal to `card`
   * when untilted); null without a card.
   */
  extent: Rect | null;
}

const TEX_W = 800;
const TEX_H = Math.round(TEX_W / CARD_ASPECT);

interface Palette {
  base: number;
  wave: number;
  header: number;
  portrait: number;
  face: number;
  hair: number;
  text: number;
  label: number;
  mrz: number;
}

const PALETTES: Record<CardStyle, Palette> = {
  light: { base: 205, wave: 6, header: 175, portrait: 150, face: 178, hair: 70, text: 45, label: 110, mrz: 35 },
  dark: { base: 100, wave: 4, header: 82, portrait: 70, face: 125, hair: 35, text: 25, label: 55, mrz: 20 },
};

const textureCache = new Map<string, Float32Array>();

/** The card artwork at 2x the guide size (800 px wide); cached per style and seed. */
export function cardTexture(style: CardStyle, seed = 1): Float32Array {
  const key = `${style}:${seed}`;
  const cached = textureCache.get(key);
  if (cached) return cached;
  const p = PALETTES[style];
  const tex = new Float32Array(TEX_W * TEX_H);
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const wave =
        Math.sin(2 * Math.PI * (x / 37 + 0.6 * Math.sin((2 * Math.PI * y) / 91))) +
        0.6 * Math.sin(2 * Math.PI * (y / 23 + x / 151));
      tex[y * TEX_W + x] = p.base + p.wave * wave;
    }
  }
  const fill = (x0: number, y0: number, w: number, h: number, v: number) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(TEX_H, Math.round(y0 + h)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(TEX_W, Math.round(x0 + w)); x++) {
        tex[y * TEX_W + x] = v;
      }
    }
  };
  const ellipse = (cx: number, cy: number, rx: number, ry: number, v: number, clip: Rect) => {
    for (let y = Math.round(clip.y); y < Math.round(clip.y + clip.height); y++) {
      for (let x = Math.round(clip.x); x < Math.round(clip.x + clip.width); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) tex[y * TEX_W + x] = v;
      }
    }
  };
  const random = rng(seed * 7919 + (style === "light" ? 1 : 2));
  // A glyph: 2-4 strokes (2 px thick at this scale, i.e. 1 px at analysis size).
  const glyph = (x: number, y: number, w: number, h: number, v: number) => {
    const strokes = 2 + Math.floor(random() * 3);
    for (let s = 0; s < strokes; s++) {
      const kind = Math.floor(random() * 7);
      if (kind === 0) fill(x, y, 2, h, v);
      else if (kind === 1) fill(x + w - 2, y, 2, h, v);
      else if (kind === 2) fill(x + w / 2 - 1, y, 2, h, v);
      else if (kind === 3) fill(x, y, w, 2, v);
      else if (kind === 4) fill(x, y + h / 2 - 1, w, 2, v);
      else if (kind === 5) fill(x, y + h - 2, w, 2, v);
      else for (let i = 0; i < h; i++) fill(x + (i * (w - 2)) / h, y + i, 2, 1, v);
    }
  };
  const textLine = (u0: number, u1: number, v: number, gw: number, gh: number, value: number) => {
    let x = u0 * TEX_W;
    const y = v * TEX_H;
    while (x + gw < u1 * TEX_W) {
      const letters = 2 + Math.floor(random() * 8);
      for (let i = 0; i < letters && x + gw < u1 * TEX_W; i++, x += gw + 3) glyph(x, y, gw, gh, value);
      x += gw;
    }
  };

  // Header band with a title.
  fill(0, 0.03 * TEX_H, TEX_W, 0.1 * TEX_H, p.header);
  textLine(0.25, 0.75, 0.055, 12, 16, p.text);
  // Portrait: background, shoulders, face.
  const portrait = { x: 0.04 * TEX_W, y: 0.19 * TEX_H, width: 0.26 * TEX_W, height: 0.55 * TEX_H };
  fill(portrait.x, portrait.y, portrait.width, portrait.height, p.portrait);
  ellipse(0.17 * TEX_W, 0.76 * TEX_H, 0.12 * TEX_W, 0.2 * TEX_H, p.hair, portrait);
  ellipse(0.17 * TEX_W, 0.42 * TEX_H, 0.065 * TEX_W, 0.15 * TEX_H, p.face, portrait);
  // Labels and values.
  for (let i = 0; i < 6; i++) {
    const v = 0.19 + i * 0.09;
    if (i % 2 === 0) textLine(0.36, 0.7, v, 9, 12, p.label);
    else textLine(0.36, 0.95, v, 13, 18, p.text);
  }
  // Two MRZ-like lines: monospaced, the full width.
  for (const v of [0.79, 0.88]) textLine(0.04, 0.96, v, 14, 22, p.mrz);

  textureCache.set(key, tex);
  return tex;
}

function backgroundSampler(bg: Background, width: number, height: number, seed: number): (x: number, y: number) => number {
  if (typeof bg === "number") return () => bg;
  if (bg === "dark") return (x, y) => 62 + (15 * x) / width + (8 * y) / height;
  if (bg === "light") return (x, y) => 218 - (12 * x) / width - (6 * y) / height;
  // Cluttered: overlapping rectangles of random brightness and size, plus diagonal stripes.
  const random = rng(seed * 104729 + 17);
  const layer = new Float32Array(width * height).fill(120);
  for (let r = 0; r < 45; r++) {
    const w = 10 + random() * 140;
    const h = 10 + random() * 140;
    const x0 = random() * width - w / 2;
    const y0 = random() * height - h / 2;
    const v = 30 + random() * 200;
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, Math.round(y0 + h)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, Math.round(x0 + w)); x++) layer[y * width + x] = v;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (((x + y) >> 3) % 7 === 0) layer[y * width + x] = Math.min(255, layer[y * width + x] + 35);
    }
  }
  return (x, y) => layer[Math.min(height - 1, Math.floor(y)) * width + Math.min(width - 1, Math.floor(x))];
}

function sampleTexture(tex: Float32Array, u: number, v: number): number {
  const x = Math.min(TEX_W - 1.001, Math.max(0, u * TEX_W - 0.5));
  const y = Math.min(TEX_H - 1.001, Math.max(0, v * TEX_H - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * TEX_W + x0;
  const top = tex[i] * (1 - fx) + tex[i + 1] * fx;
  const bottom = tex[i + TEX_W] * (1 - fx) + tex[i + TEX_W + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Renders a card on a background, as the analysis loop would see it. */
export function makeScene(options: SceneOptions = {}): Scene {
  const { width, height, guide } = sceneGeometry();
  const style = options.card ?? "light";
  const seed = options.seed ?? 1;
  const bg = backgroundSampler(options.background ?? (style === "dark" ? "light" : "dark"), width, height, seed);
  const data = new Uint8Array(width * height);
  if (style === "none") {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) data[y * width + x] = Math.round(bg(x + 0.5, y + 0.5));
    }
    return { image: { width, height, data }, guide, card: null, extent: null };
  }

  const scale = options.scale ?? 0.95;
  const cw = guide.width * scale;
  const ch = cw / CARD_ASPECT;
  const cx = guide.x + guide.width / 2 + (options.offsetX ?? 0) * guide.width;
  const cy = guide.y + guide.height / 2 + (options.offsetY ?? 0) * guide.height;
  const card = { x: cx - cw / 2, y: cy - ch / 2, width: cw, height: ch };
  const angle = ((options.angleDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const radius = 0.035 * cw; // rounded corners (ID-1: ~3 mm)
  const tex = cardTexture(style, seed);
  // Enough subsamples per pixel to average the texture when the card is shrunk.
  const sub = Math.min(4, Math.max(2, Math.ceil(TEX_W / cw)));

  const keystone = options.keystone ?? 0;
  let ex0 = Infinity;
  let ey0 = Infinity;
  let ex1 = -Infinity;
  let ey1 = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let j = 0; j < sub; j++) {
        for (let i = 0; i < sub; i++) {
          const sx = x + (i + 0.5) / sub;
          const sy = y + (j + 0.5) / sub;
          // Rotate the sample point back into the card's frame, then undo the perspective.
          const dx = sx - cx;
          const dy = sy - cy;
          const uy = -sin * dx + cos * dy;
          const lx = (cos * dx + sin * dy) / (1 + (keystone * uy) / ch) + cw / 2;
          const ly = uy + ch / 2;
          if (insideRoundedRect(lx, ly, cw, ch, radius)) {
            acc += sampleTexture(tex, lx / cw, ly / ch);
            ex0 = Math.min(ex0, sx);
            ex1 = Math.max(ex1, sx);
            ey0 = Math.min(ey0, sy);
            ey1 = Math.max(ey1, sy);
          } else {
            acc += bg(sx, sy);
          }
        }
      }
      data[y * width + x] = Math.round(acc / (sub * sub));
    }
  }
  const half = 0.5 / sub;
  const extent = { x: ex0 - half, y: ey0 - half, width: ex1 - ex0 + 2 * half, height: ey1 - ey0 + 2 * half };
  return { image: { width, height, data }, guide, card, extent };
}

function insideRoundedRect(x: number, y: number, w: number, h: number, r: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  const qx = x < r ? r - x : x > w - r ? x - (w - r) : 0;
  const qy = y < r ? r - y : y > h - r ? y - (h - r) : 0;
  return qx * qx + qy * qy <= r * r;
}

function mapPixels(img: GrayImage, f: (v: number, i: number) => number): GrayImage {
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(f(img.data[i], i))));
  return { width: img.width, height: img.height, data };
}

/** Separable convolution with clamp-to-edge borders. */
function convolve(img: GrayImage, kernel: number[]): GrayImage {
  const { width: w, height: h } = img;
  const r = (kernel.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += kernel[k + r] * img.data[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s;
    }
  }
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += kernel[k + r] * tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      data[y * w + x] = Math.max(0, Math.min(255, Math.round(s)));
    }
  }
  return { width: w, height: h, data };
}

/** Box blur with a (2r + 1) x (2r + 1) kernel. */
export function boxBlur(img: GrayImage, r: number): GrayImage {
  return convolve(img, new Array(2 * r + 1).fill(1 / (2 * r + 1)));
}

/** Gaussian blur of standard deviation `sigma` pixels (kernel cut at 3 sigma). */
export function gaussianBlur(img: GrayImage, sigma: number): GrayImage {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  return convolve(img, k.map((v) => v / sum));
}

/** A specular highlight: fully saturated disc of `radius` px with a soft halo out to 1.8 x radius. */
export function addGlare(img: GrayImage, cx: number, cy: number, radius: number): GrayImage {
  const w = img.width;
  return mapPixels(img, (v, i) => {
    const d = Math.hypot((i % w) + 0.5 - cx, Math.floor(i / w) + 0.5 - cy);
    if (d <= radius) return 255;
    const t = (d - radius) / (0.8 * radius);
    return t >= 1 ? v : v + (255 - v) * 0.8 * (1 - t) ** 2;
  });
}

/** Exposure change: v * gain + offset, clipped to 0..255 like a sensor. */
export function expose(img: GrayImage, gain: number, offset = 0): GrayImage {
  return mapPixels(img, (v) => v * gain + offset);
}

/** Adds Gaussian sensor noise of standard deviation `sigma` levels. */
export function addNoise(img: GrayImage, sigma: number, seed = 7): GrayImage {
  const random = rng(seed);
  return mapPixels(img, (v) => v + sigma * gaussian(random));
}

/**
 * Adds spatially correlated noise of standard deviation `std` levels, as a phone preview has it
 * (demosaicing, the ISP's denoiser and resampling smear the sensor's grain over neighbouring
 * pixels): white noise filtered by a Gaussian of `smooth` px, or by a 3x3 box with "box3", then
 * rescaled to `std`.
 */
export function addCorrelatedNoise(img: GrayImage, std: number, smooth: number | "box3", seed = 11): GrayImage {
  const { width: w, height: h } = img;
  const random = rng(seed);
  let kernel: number[];
  if (smooth === "box3") {
    kernel = [1 / 3, 1 / 3, 1 / 3];
  } else {
    const r = Math.max(1, Math.ceil(3 * smooth));
    kernel = [];
    for (let i = -r; i <= r; i++) kernel.push(Math.exp(-(i * i) / (2 * smooth * smooth)));
    const sum = kernel.reduce((a, b) => a + b, 0);
    kernel = kernel.map((v) => v / sum);
  }
  const r = (kernel.length - 1) / 2;
  const white = new Float64Array(w * h);
  for (let i = 0; i < white.length; i++) white[i] = gaussian(random);
  const pass = (src: Float64Array, horizontal: boolean): Float64Array => {
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
          s += kernel[k + r] * src[yy * w + xx];
        }
        out[y * w + x] = s;
      }
    }
    return out;
  };
  const field = pass(pass(white, true), false);
  let sumSq = 0;
  for (let i = 0; i < field.length; i++) sumSq += field[i] * field[i];
  const gain = std / Math.sqrt(sumSq / field.length);
  return mapPixels(img, (v, i) => v + gain * field[i]);
}

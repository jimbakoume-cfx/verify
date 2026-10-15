// Turns rendered images into training lines exactly as the rider's phone would hand them to the
// model: the rider's own locate and prepare steps (@verify/capture, unchanged), then each code line
// cut out where Tesseract itself cuts it.
//
// Jobs (one JSON object per line of <shard>/jobs.jsonl, written by py/docs.py or py/make_lines.py):
//   {"kind": "still", "file", "format": "TD1"|"TD3", "lines": [...], "binarization", "out"}
//       a whole document still: locateMrzBand + prepareForOcr, as reader.ts does.
//   {"kind": "line", "file", "text", "charHeight", "binarization", "out"}
//       one rendered line with a loose margin: prepareForOcr on the whole image, with the
//       character height measured a little wrong, as locate's measure is.
//
// Where Tesseract cuts a line (page segmentation 6, as the rider; linerec.cpp in Tesseract 5): the
// bounding box of the blobs it put in the row, stretched down to the row's descender line and up
// to its ascender line, plus 4 px of padding (kImagePadding). Every prepared band of a shard is
// run through native Tesseract in one batch; hOCR gives each line's box, baseline and descender
// and ascender room, from which the crop is rebuilt. The crops vary a lot from band to band (5-18
// px of descender room at 32 px capitals; on many bands the first line's box reaches up to specks
// at the band's top edge), which is exactly what the model must get used to. Only Tesseract's
// geometry is used: the text it reads is ignored (any model works for this; we use Google's
// tessdata_fast eng, Apache-2.0, see inputs.json).
//
// Our own row finding (connected components) pairs Tesseract's lines with the ground truth and
// checks them: a line whose row does not look like that code line (too few characters, the wrong
// width, Tesseract's line missing or split) is skipped, never guessed, because a wrong label teaches
// the model a wrong character.
//
// Writes <out dir>/<out>[_l<k>].png with .gt.txt and the line .box file, and cut-stats.json.
// usage: node run.mjs cutLines.ts SHARD_DIR OUT_DIR --tessdata DIR [--lang eng] [--keep-bands]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type GrayImage,
  type MrzBand,
  type MrzBinarization,
  PREPARE_DEFAULTS,
  decodePgm,
  encodePgm,
  locateMrzBand,
  prepareForOcr,
} from "@verify/capture";
import { encodePng, hash32, parseArgs, prng, readJsonLines, writeJson } from "./lib";

type Job =
  | { kind: "still"; file: string; format: "TD1" | "TD3"; lines: string[]; binarization: MrzBinarization; out: string }
  | { kind: "line"; file: string; text: string; charHeight: number; binarization: MrzBinarization; out: string };

interface Component {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A code line as our own row finding sees it, in prepared-band pixels. */
export interface Row {
  left: number;
  top: number;
  right: number;
  baseline: number;
  capHeight: number;
}

/** One text line of Tesseract's hOCR, and the crop its LSTM reads. */
export interface TesseractLine {
  bbox: [number, number, number, number];
  crop: [number, number, number, number];
}

/** Tesseract pads every line image by this many pixels (kImagePadding in linerec.cpp). */
const TESSERACT_PADDING = 4;
/** OCR-B advance per capital height at the ICAO pitch: 2.54 mm / 2.4 mm. */
const PITCH_PER_CAP = 2.54 / 2.4;
const WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";

/** 8-connected components of the ink (dark) pixels. */
export function components(img: GrayImage): Component[] {
  const { width: w, height: h, data } = img;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: Component[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || data[start] >= 128) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const c = { x0: w, y0: h, x1: 0, y1: 0 };
    while (top > 0) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      if (x < c.x0) c.x0 = x;
      if (x + 1 > c.x1) c.x1 = x + 1;
      if (y < c.y0) c.y0 = y;
      if (y + 1 > c.y1) c.y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!seen[q] && data[q] < 128) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
    }
    out.push(c);
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

export type CutFailure = "no_rows" | "row_count" | "characters" | "width" | "tesseract_lines";

/**
 * Finds the rows of `texts` (top to bottom) in a prepared (binarised) band from its connected
 * components, and checks that each looks like its code line. Returns a failure reason otherwise.
 */
export function findRows(img: GrayImage, texts: string[]): Row[] | CutFailure {
  const comps = components(img);
  const target = PREPARE_DEFAULTS.targetCharHeight;
  // Capital height as prepared (about 32 px, off by locate's measuring error).
  const tall = comps.filter((c) => c.y1 - c.y0 >= 0.6 * target && c.y1 - c.y0 <= 1.6 * target && c.x1 - c.x0 <= 1.5 * target);
  if (tall.length === 0) return "no_rows";
  const cap = median(tall.map((c) => c.y1 - c.y0));
  const isText = (c: Component) => {
    const ch = c.y1 - c.y0;
    return ch >= 0.35 * cap && ch <= 1.4 * cap && c.x1 - c.x0 <= 1.4 * cap;
  };
  // Group text blobs into rows by their vertical centre.
  const rows: { cy: number; members: Component[] }[] = [];
  for (const c of comps.filter(isText).sort((a, b) => a.y0 + a.y1 - b.y0 - b.y1)) {
    const cy = (c.y0 + c.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < 0.45 * cap);
    if (row) {
      row.members.push(c);
      row.cy += (cy - row.cy) / row.members.length;
    } else {
      rows.push({ cy, members: [c] });
    }
  }
  if (rows.length < texts.length) return "row_count";
  const bySize = [...rows].sort((a, b) => b.members.length - a.members.length);
  const chosen = bySize.slice(0, texts.length).sort((a, b) => a.cy - b.cy);
  // Another row nearly as full as the chosen ones: the band holds more than the code lines.
  const rest = bySize[texts.length];
  if (rest && rest.members.length > 0.5 * Math.min(...chosen.map((r) => r.members.length))) return "row_count";

  const out: Row[] = [];
  for (let k = 0; k < chosen.length; k++) {
    const { members } = chosen[k];
    const text = texts[k];
    // About one blob per character; touching or broken characters move the count a little.
    if (members.length < 0.6 * text.length || members.length > 1.6 * text.length) return "characters";
    const big = members.filter((c) => c.y1 - c.y0 >= 0.75 * cap);
    const row: Row = {
      left: Math.min(...members.map((c) => c.x0)),
      right: Math.max(...members.map((c) => c.x1)),
      top: median((big.length ? big : members).map((c) => c.y0)),
      baseline: median((big.length ? big : members).map((c) => c.y1)),
      capHeight: cap,
    };
    // A code line runs at the ICAO pitch from its first to its last character (fillers included).
    // The bounds are loose (pitch, capital height and stroke weight vary between documents and
    // with the measure of the capitals); they catch a line cut short or two lines run together.
    const ratio = (row.right - row.left) / (((text.length - 1) * PITCH_PER_CAP + 0.7) * cap);
    if (ratio < 0.8 || ratio > 1.25) return "width";
    out.push(row);
  }
  return out;
}

const LINE_RE =
  /class='ocr_line'[^>]*title="bbox (\d+) (\d+) (\d+) (\d+); baseline ([-\d.]+) ([-\d.]+); x_size ([\d.]+); x_descenders ([\d.]+); x_ascenders ([\d.]+)/g;

/**
 * The text lines of one hOCR page and the crop Tesseract's LSTM reads for each: the line's box,
 * reaching down to the descender line and up to the ascender line, padded by 4 px, within the
 * image. hOCR's baseline is "slope offset" from the box's bottom-left corner; x_size is the row's
 * x-height plus its ascender and descender room.
 */
export function tesseractLines(page: string, width: number, height: number): TesseractLine[] {
  const out: TesseractLine[] = [];
  for (const m of page.matchAll(LINE_RE)) {
    const [x0, y0, x1, y1] = [1, 2, 3, 4].map((i) => Number(m[i]));
    const [slope, offset, size, descenders] = [5, 6, 7, 8].map((i) => Number(m[i]));
    const baseline = y1 + offset + (slope * (x1 - x0)) / 2;
    const top = Math.min(y0, Math.round(baseline - (size - descenders)));
    const bottom = Math.max(y1, Math.round(baseline + descenders));
    const p = TESSERACT_PADDING;
    out.push({
      bbox: [x0, y0, x1, y1],
      crop: [Math.max(0, x0 - p), Math.max(0, top - p), Math.min(width, x1 + p), Math.min(height, bottom + p)],
    });
  }
  return out;
}

/**
 * Pairs each of our rows with the Tesseract line that overlaps it most, one to one. Tesseract's line
 * must cover the row from end to end (a line it split in two, or merged with the next, is no use).
 */
export function matchLines(rows: Row[], lines: TesseractLine[]): TesseractLine[] | null {
  const used = new Set<number>();
  const out: TesseractLine[] = [];
  for (const row of rows) {
    let best = -1;
    let bestOverlap = 0;
    lines.forEach((line, i) => {
      const overlap = Math.min(row.baseline, line.bbox[3]) - Math.max(row.top, line.bbox[1]);
      if (overlap > bestOverlap) {
        best = i;
        bestOverlap = overlap;
      }
    });
    if (best < 0 || used.has(best) || bestOverlap < 0.6 * (row.baseline - row.top)) return null;
    const [x0, , x1] = lines[best].bbox;
    const slack = 0.5 * row.capHeight;
    if (x0 > row.left + slack || x1 < row.right - slack) return null;
    // (A box much taller than the characters is kept: Tesseract does put specks above and below
    // into the line, and its LSTM then reads that tall crop. Two code lines run together show up
    // as one Tesseract line matching two rows, which `used` refuses.)
    used.add(best);
    out.push(lines[best]);
  }
  return out;
}

export function crop(img: GrayImage, [x0, y0, x1, y1]: [number, number, number, number]): GrayImage {
  const width = x1 - x0;
  const height = y1 - y0;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.set(img.data.subarray((y0 + y) * img.width + x0, (y0 + y) * img.width + x1), y * width);
  return { width, height, data };
}

/** The line box file tesstrain's generate_line_box.py would write for an image of this size. */
export function lineBox(text: string, width: number, height: number): string {
  return [...text].map((c) => `${c} 0 0 ${width} ${height} 0`).concat(`\t 0 0 ${width} ${height} 0`).join("\n") + "\n";
}

/** Runs native Tesseract once over many images (page segmentation 6) and returns each page's hOCR. */
function hocrPages(images: string[], workDir: string, tessdata: string, lang: string): string[] {
  const list = join(workDir, "bands.txt");
  writeFileSync(list, images.join("\n") + "\n");
  execFileSync(
    "tesseract",
    [list, join(workDir, "bands"), "--tessdata-dir", tessdata, "-l", lang, "--psm", "6",
      "-c", "load_system_dawg=0", "-c", "load_freq_dawg=0", "-c", `tessedit_char_whitelist=${WHITELIST}`,
      "-c", "tessedit_create_hocr=1"],
    { env: { ...process.env, OMP_THREAD_LIMIT: "1" }, stdio: ["ignore", "ignore", "ignore"] },
  );
  const hocr = readFileSync(join(workDir, "bands.hocr"), "utf8");
  // One ocr_page per image, in list order; the first chunk is the document's head.
  const pages = hocr.split("<div class='ocr_page'").slice(1);
  if (pages.length !== images.length) throw new Error(`hOCR has ${pages.length} pages for ${images.length} images`);
  pages.forEach((page, i) => {
    if (!page.includes(`image "${images[i]}"`)) throw new Error(`hOCR page ${i} is not ${images[i]}`);
  });
  return pages;
}

export async function main(argv: string[]): Promise<void> {
  const { options, positional } = parseArgs(argv);
  const [shardArg, outArg] = positional;
  if (!shardArg || !outArg || !options.tessdata) {
    throw new Error("usage: cutLines.ts SHARD_DIR OUT_DIR --tessdata DIR [--lang eng] [--keep-bands]");
  }
  const shard = resolve(shardArg);
  const outDir = resolve(outArg);
  const bandsDir = join(shard, "bands");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(bandsDir, { recursive: true });
  const stats: Record<string, number> = { jobs: 0, lines: 0, fallback: 0 };
  const fail = (reason: string) => (stats[reason] = (stats[reason] ?? 0) + 1);

  // 1. The rider's locate and prepare; our own row finding.
  const pending: { job: Job; texts: string[]; rows: Row[]; band: string }[] = [];
  for (const job of readJsonLines<Job>(join(shard, "jobs.jsonl"))) {
    stats.jobs++;
    const random = prng(hash32(job.out));
    const image = decodePgm(readFileSync(join(shard, job.file)));
    let band: MrzBand;
    let texts: string[];
    if (job.kind === "still") {
      band = locateMrzBand(image, job.format);
      texts = job.lines;
      if (band.fallback) {
        // The rider would read a fixed crop of the bottom: no line positions to trust.
        stats.fallback++;
        continue;
      }
    } else {
      band = {
        rect: { x: 0, y: 0, width: image.width, height: image.height },
        angle: 0,
        lines: 1,
        charHeight: job.charHeight * (0.9 + 0.2 * random()),
        confidence: 1,
        fallback: false,
      };
      texts = [job.text];
    }
    const prepared = prepareForOcr(image, band, { binarization: job.binarization });
    const rows = findRows(prepared, texts);
    if (typeof rows === "string") {
      fail(rows);
      continue;
    }
    const bandFile = join(bandsDir, `${job.out}.pgm`);
    writeFileSync(bandFile, encodePgm(prepared));
    pending.push({ job, texts, rows, band: bandFile });
  }

  // 2. Tesseract's own line finding, in one batch, and the crops its LSTM would read.
  const pages = pending.length ? hocrPages(pending.map((p) => p.band), bandsDir, options.tessdata, options.lang ?? "eng") : [];
  pending.forEach(({ job, texts, rows, band }, i) => {
    const prepared = decodePgm(readFileSync(band));
    const matched = matchLines(rows, tesseractLines(pages[i], prepared.width, prepared.height));
    if (!matched) {
      fail("tesseract_lines");
      return;
    }
    matched.forEach((line, k) => {
      const image = crop(prepared, line.crop);
      const name = texts.length === 1 ? job.out : `${job.out}_l${k + 1}`;
      writeFileSync(join(outDir, `${name}.png`), encodePng(image));
      writeFileSync(join(outDir, `${name}.gt.txt`), texts[k] + "\n");
      writeFileSync(join(outDir, `${name}.box`), lineBox(texts[k], image.width, image.height));
      stats.lines++;
    });
  });
  if (!("keep-bands" in options)) rmSync(bandsDir, { recursive: true, force: true });
  writeJson(join(outDir, `cut-stats-${hash32(shard).toString(16)}.json`), { shard, ...stats });
  console.log(JSON.stringify({ shard, ...stats }));
}

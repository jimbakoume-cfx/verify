// Small helpers shared by the training scripts in this folder (Node only, run through run.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import type { GrayImage } from "@verify/capture";

/** Encodes an 8-bit grayscale image as PNG (Tesseract, tesseract.js and Pillow all read it). */
export function encodePng(image: GrayImage): Uint8Array {
  const { width, height, data } = image;
  // Filter type 0 (none) before each row.
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Deterministic random numbers (mulberry32), so a shard is cut the same way every time. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A string's 32-bit FNV-1a hash, to derive per-item seeds. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** Edit distance (insertions, deletions, substitutions). */
export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** `--name value` options, `--flag` switches (value "") and positional arguments. */
export function parseArgs(args: string[]): { options: Record<string, string>; positional: string[] } {
  const options: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) positional.push(args[i]);
    else if (i + 1 < args.length && !args[i + 1].startsWith("--")) options[args[i].slice(2)] = args[++i];
    else options[args[i].slice(2)] = "";
  }
  return { options, positional };
}

export function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 1) + "\n");
}

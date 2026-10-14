import { describe, expect, it } from "vitest";
import type { GrayImage } from "../types";
import { fallbackMrzBand, locateMrzBand, type MrzBand } from "./locate";
import { PREPARE_DEFAULTS, prepareForOcr, rotateGray180 } from "./prepare";
import { makeMrzStill } from "./syntheticMrz";

/** Rows of `img` that contain ink (any pixel below 128), between `x0` and `x1`. */
function inkRows(img: GrayImage, x0 = 0, x1 = img.width): boolean[] {
  const rows: boolean[] = [];
  for (let y = 0; y < img.height; y++) {
    let ink = false;
    for (let x = x0; x < x1 && !ink; x++) ink = img.data[y * img.width + x] < 128;
    rows.push(ink);
  }
  return rows;
}

/** Runs of consecutive true values: [start, end) pairs. */
function runs(values: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  values.forEach((v, i) => {
    if (v && start < 0) start = i;
    if (!v && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, values.length]);
  return out;
}

function inkShare(img: GrayImage, x0: number, x1: number, y0: number, y1: number): number {
  let ink = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ink += img.data[y * img.width + x] < 128 ? 1 : 0;
  return ink / ((x1 - x0) * (y1 - y0));
}

describe("prepareForOcr", () => {
  const td3 = makeMrzStill({ format: "TD3", width: 816 });
  const td3Band = locateMrzBand(td3.image, "TD3");

  it("scales the characters to about 32 px and adds a white border", () => {
    const out = prepareForOcr(td3.image, td3Band);
    const scale = 32 / td3Band.charHeight;
    const border = PREPARE_DEFAULTS.border;
    expect(out.width).toBe(Math.round(td3Band.rect.width * scale) + 2 * border);
    expect(out.height).toBe(Math.round(td3Band.rect.height * scale) + 2 * border);
    // Two text lines, each about 32 px tall.
    const lines = runs(inkRows(out)).filter(([a, b]) => b - a > 5);
    expect(lines).toHaveLength(2);
    for (const [a, b] of lines) expect(Math.abs(b - a - 32)).toBeLessThanOrEqual(4);
    // The border is white.
    for (let x = 0; x < out.width; x++) {
      expect(out.data[x]).toBe(255);
      expect(out.data[(out.height - 1) * out.width + x]).toBe(255);
    }
    for (let y = 0; y < out.height; y++) {
      expect(out.data[y * out.width]).toBe(255);
      expect(out.data[y * out.width + out.width - 1]).toBe(255);
    }
  });

  it("returns pure black and white for both thresholds, and gray levels without one", () => {
    for (const binarization of ["local", "otsu"] as const) {
      const out = prepareForOcr(td3.image, td3Band, { binarization });
      expect(new Set(out.data)).toEqual(new Set([0, 255]));
    }
    const gray = prepareForOcr(td3.image, td3Band, { binarization: "none" });
    expect(new Set(gray.data).size).toBeGreaterThan(10);
  });

  it("straightens tilted lines so each code line keeps to its own rows", () => {
    const still = makeMrzStill({ format: "TD1", width: 850, angleDeg: 3.5 });
    const band = locateMrzBand(still.image, "TD1");
    expect(band.angle).toBeGreaterThan(2.5);
    const out = prepareForOcr(still.image, band);
    // Across the whole width, the rows with ink form exactly 3 bands: a 3.5-degree tilt left
    // uncorrected would smear them into one another over 1000 px.
    const lines = runs(inkRows(out)).filter(([a, b]) => b - a > 5);
    expect(lines).toHaveLength(3);
    for (const [a, b] of lines) expect(b - a).toBeLessThan(42);
  });

  it("keeps characters in a shadow with the local threshold, where one global threshold loses them", () => {
    const shadow = { rect: { x: 0, y: 0.5, width: 0.45, height: 0.5 }, factor: 0.5 };
    const lit = makeMrzStill({ format: "TD1", width: 850 });
    const shaded = makeMrzStill({ format: "TD1", width: 850, shadow });
    // The same band for both, so the outputs line up pixel for pixel.
    const band = locateMrzBand(lit.image, "TD1");
    expect(locateMrzBand(shaded.image, "TD1").fallback).toBe(false);
    const reference = prepareForOcr(lit.image, band, { binarization: "local" });
    const local = prepareForOcr(shaded.image, band, { binarization: "local" });
    const otsu = prepareForOcr(shaded.image, band, { binarization: "otsu" });
    // The left third of the band lies in the shadow.
    const b = PREPARE_DEFAULTS.border;
    const x1 = b + Math.round((local.width - 2 * b) / 3);
    let same = 0;
    let total = 0;
    for (let y = b; y < local.height - b; y++) {
      for (let x = b; x < x1; x++) {
        same += local.data[y * local.width + x] === reference.data[y * local.width + x] ? 1 : 0;
        total++;
      }
    }
    // Local: the shadowed characters come out as they do in full light.
    expect(same / total).toBeGreaterThan(0.97);
    expect(inkShare(local, b, x1, b, local.height - b)).toBeLessThan(0.35);
    // Otsu: the shadowed paper itself turns black.
    expect(inkShare(otsu, b, x1, b, otsu.height - b)).toBeGreaterThan(0.8);
  });

  it("shrinks large characters and caps the width", () => {
    const big = makeMrzStill({ format: "TD1", width: 1600 });
    const band = locateMrzBand(big.image, "TD1");
    expect(band.charHeight).toBeGreaterThan(40);
    const out = prepareForOcr(big.image, band, { border: 0 });
    expect(out.height).toBe(Math.round(band.rect.height * (32 / band.charHeight)));
    const capped = prepareForOcr(big.image, fallbackMrzBand(big.image, "TD1"), { maxWidth: 1000, border: 0 });
    expect(capped.width).toBe(1000);
  });

  it("stretches a low-contrast band to full black and white", () => {
    const dim = makeMrzStill({ format: "TD3", width: 816, paper: 90, ink: 50 });
    const band = locateMrzBand(dim.image, "TD3");
    const gray = prepareForOcr(dim.image, band, { binarization: "none", border: 0 });
    let min = 255;
    let max = 0;
    for (const v of gray.data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBe(0);
    expect(max).toBe(255);
  });

  it("validates its input", () => {
    const band: MrzBand = fallbackMrzBand({ width: 10, height: 10, data: new Uint8Array(100) }, "TD1");
    expect(() => prepareForOcr({ width: 10, height: 10, data: new Uint8Array(5) }, band)).toThrow(RangeError);
  });
});

describe("rotateGray180", () => {
  it("turns the image half a turn, and back", () => {
    const img = { width: 3, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    const turned = rotateGray180(img);
    expect(Array.from(turned.data)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(turned).toMatchObject({ width: 3, height: 2 });
    expect(Array.from(rotateGray180(turned).data)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

import { describe, expect, it } from "vitest";
import type { Rect } from "../types";
import { expectedMrzCharHeight, fallbackMrzBand, locateMrzBand, type MrzBand } from "./locate";
import { rotateGray180 } from "./prepare";
import { type MrzStillOptions, makeMrzStill } from "./syntheticMrz";

/** Corners of the band after its tilt, in still pixels. */
function bandCorners(band: MrzBand): [number, number][] {
  const { x, y, width, height } = band.rect;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const a = (band.angle * Math.PI) / 180;
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const lx = (sx * width) / 2;
    const ly = (sy * height) / 2;
    return [cx + lx * Math.cos(a) - ly * Math.sin(a), cy + lx * Math.sin(a) + ly * Math.cos(a)];
  });
}

/** True when the point lies inside the (tilted) band. */
function bandContains(band: MrzBand, px: number, py: number): boolean {
  const { x, y, width, height } = band.rect;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const a = (-band.angle * Math.PI) / 180;
  const lx = (px - cx) * Math.cos(a) - (py - cy) * Math.sin(a);
  const ly = (px - cx) * Math.sin(a) + (py - cy) * Math.cos(a);
  return Math.abs(lx) <= width / 2 && Math.abs(ly) <= height / 2;
}

/** The code lines' corners in the still, after the document's tilt about the still's centre. */
function mrzCorners(rect: Rect, angleDeg: number, w: number, h: number): [number, number][] {
  const a = (angleDeg * Math.PI) / 180;
  const corners: [number, number][] = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height],
    [rect.x, rect.y + rect.height],
  ];
  return corners.map(([px, py]) => {
    const dx = px - w / 2;
    const dy = py - h / 2;
    return [w / 2 + dx * Math.cos(a) - dy * Math.sin(a), h / 2 + dx * Math.sin(a) + dy * Math.cos(a)];
  });
}

function expectFound(options: MrzStillOptions) {
  const still = makeMrzStill(options);
  const band = locateMrzBand(still.image, options.format);
  const { width: w, height: h } = still.image;
  expect(band.fallback).toBe(false);
  expect(band.lines).toBe(options.format === "TD1" ? 3 : 2);
  expect(band.confidence).toBeGreaterThan(0.5);
  // Character height within 15% of the truth.
  expect(Math.abs(band.charHeight - still.charHeight) / still.charHeight).toBeLessThan(0.15);
  expect(Math.abs(band.angle - (options.angleDeg ?? 0))).toBeLessThanOrEqual(0.75);
  // Every character is inside the band, with no more than about two lines of margin.
  for (const [px, py] of mrzCorners(still.mrzRect, options.angleDeg ?? 0, w, h)) {
    expect(bandContains(band, px, py)).toBe(true);
  }
  expect(band.rect.height).toBeLessThan(still.mrzRect.height + 4 * still.charHeight);
  for (const [px, py] of bandCorners(band)) {
    expect(px).toBeGreaterThan(-still.charHeight);
    expect(py).toBeLessThan(h + still.charHeight);
  }
  return { band, still };
}

describe("expectedMrzCharHeight", () => {
  it("expects 2.4 mm capitals on a document filling the guide (the still is the guide + 4%)", () => {
    // 850 px still: the card is 817 px wide, 9.55 px/mm.
    expect(expectedMrzCharHeight(850, "TD1")).toBeCloseTo((850 / 1.04 / 85.6) * 2.4, 6);
    expect(expectedMrzCharHeight(850, "TD1")).toBeCloseTo(22.9, 1);
    // Passport page held upright, about 6.4 px/mm: characters about 15 px tall.
    expect(expectedMrzCharHeight(816, "TD3")).toBeCloseTo(15.1, 1);
  });
});

describe("locateMrzBand", () => {
  it("finds the 3 lines of a TD1 card back", () => {
    expectFound({ format: "TD1", width: 850 });
  });

  it("finds the 2 lines of a passport page at about 6.4 px/mm (15 px characters)", () => {
    expectFound({ format: "TD3", width: 816 });
  });

  it("finds them on the smallest and largest stills (720 and 1600 px)", () => {
    expectFound({ format: "TD3", width: 720, blur: 0.7, noise: 3 });
    expectFound({ format: "TD1", width: 1600, blur: 1.5 });
  });

  it("measures the tilt of a card turned up to 4 degrees and covers the turned lines", () => {
    expectFound({ format: "TD1", width: 850, angleDeg: 3.5 });
    expectFound({ format: "TD3", width: 816, angleDeg: -3 });
  });

  it("finds a document smaller than the guide, ignoring the table texture around it", () => {
    expectFound({ format: "TD1", width: 850, docScale: 0.85 });
  });

  it("finds lines half in shadow", () => {
    expectFound({
      format: "TD1",
      width: 850,
      shadow: { rect: { x: 0, y: 0.5, width: 0.45, height: 0.5 }, factor: 0.5 },
    });
  });

  it("finds blurred, noisy lines", () => {
    expectFound({ format: "TD3", width: 816, blur: 1.2, noise: 4 });
  });

  it("falls back to the bottom crop when the document has no code lines", () => {
    const still = makeMrzStill({ format: "TD1", width: 850, mrz: false });
    const band = locateMrzBand(still.image, "TD1");
    expect(band).toEqual(fallbackMrzBand(still.image, "TD1"));
    expect(band).toMatchObject({ fallback: true, lines: 0, confidence: 0, angle: 0 });
  });

  it("does not find upside-down lines, but finds them once the still is turned 180 degrees", () => {
    const still = makeMrzStill({ format: "TD1", width: 850, upsideDown: true });
    expect(locateMrzBand(still.image, "TD1").fallback).toBe(true);
    const turned = locateMrzBand(rotateGray180(still.image), "TD1");
    expect(turned.fallback).toBe(false);
    expect(turned.lines).toBe(3);
  });

  it("does not take TD3 lines for TD1 (two lines are not three)", () => {
    const still = makeMrzStill({ format: "TD3", width: 816 });
    expect(locateMrzBand(still.image, "TD1").fallback).toBe(true);
  });

  it("falls back on a blank or tiny image", () => {
    const blank = { width: 800, height: 505, data: new Uint8Array(800 * 505).fill(200) };
    expect(locateMrzBand(blank, "TD1").fallback).toBe(true);
    const tiny = { width: 20, height: 12, data: new Uint8Array(240).fill(200) };
    expect(locateMrzBand(tiny, "TD3").fallback).toBe(true);
  });
});

describe("fallbackMrzBand", () => {
  it("crops the bottom of the still where the lines must be, with the expected character height", () => {
    const image = { width: 850, height: 536, data: new Uint8Array(850 * 536) };
    const td1 = fallbackMrzBand(image, "TD1");
    expect(td1.rect).toEqual({ x: 0, y: Math.floor(536 * 0.58), width: 850, height: 536 - Math.floor(536 * 0.58) });
    expect(td1.charHeight).toBeCloseTo(expectedMrzCharHeight(850, "TD1"), 6);
    const td3 = fallbackMrzBand(image, "TD3");
    expect(td3.rect.y).toBe(Math.floor(536 * 0.66));
    expect(td3.rect.y + td3.rect.height).toBe(536);
  });
});

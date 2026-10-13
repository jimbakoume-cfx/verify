import { describe, expect, it } from "vitest";
import { detectDocumentBox } from "./detect";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import { addGlare, addNoise, boxBlur, expose, gaussianBlur, makeScene, type SceneOptions } from "./test-support/synthetic";
import type { GrayImage, Rect } from "./types";

/** Largest distance between corresponding edges of two rectangles, in pixels. */
function edgeError(found: Rect | null, truth: Rect): number {
  if (!found) return Infinity;
  return Math.max(
    Math.abs(found.x - truth.x),
    Math.abs(found.y - truth.y),
    Math.abs(found.x + found.width - truth.x - truth.width),
    Math.abs(found.y + found.height - truth.y - truth.height),
  );
}

/** Largest distance between corresponding sides of two rectangles, in pixels. */
function extentError(found: Rect | null, truth: Rect): number {
  return edgeError(found, truth);
}

/** Whether `outer` holds `inner`, allowing `slack` pixels. */
function contains(outer: Rect, inner: Rect, slack: number): boolean {
  return (
    outer.x <= inner.x + slack &&
    outer.y <= inner.y + slack &&
    outer.x + outer.width >= inner.x + inner.width - slack &&
    outer.y + outer.height >= inner.y + inner.height - slack
  );
}

function detect(options: SceneOptions, degrade?: (img: GrayImage) => GrayImage) {
  const scene = makeScene(options);
  const result = detectDocumentBox(degrade ? degrade(scene.image) : scene.image, scene.guide);
  return { ...result, error: edgeError(result.box, scene.card!) };
}

/** Draws an opaque ellipse (a finger holding the card). */
function finger(img: GrayImage, cx: number, cy: number, rx: number, ry: number, luma: number): GrayImage {
  const data = new Uint8Array(img.data);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) data[y * img.width + x] = luma;
    }
  }
  return { width: img.width, height: img.height, data };
}

const minConfidence = DEFAULT_THRESHOLDS.minDocumentConfidence;

describe("detectDocumentBox: finds the card", () => {
  it("light card on a darker background", () => {
    const r = detect({ card: "light", background: "dark" });
    expect(r.error).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.polarity).toBe("light");
  });

  it("darker card on a lighter background", () => {
    const r = detect({ card: "dark", background: "light" });
    expect(r.error).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.polarity).toBe("dark");
  });

  it.each([0.5, 0.9, 1.1])("card at %s of the guide", (scale) => {
    for (const card of ["light", "dark"] as const) {
      const r = detect({ scale, card });
      expect(r.error).toBeLessThan(1.5);
      expect(r.confidence).toBeGreaterThan(0.9);
    }
  });

  it.each([
    [0.1, 0],
    [0, 0.1],
    [-0.1, 0.06],
  ])("off-centre card (%s, %s)", (offsetX, offsetY) => {
    const r = detect({ scale: 0.85, offsetX, offsetY });
    expect(r.error).toBeLessThan(1.5);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("blurred, noisy, dim or with glare", () => {
    const cases: [string, (img: GrayImage) => GrayImage][] = [
      ["gaussian 2", (i) => gaussianBlur(i, 2)],
      ["gaussian 4", (i) => gaussianBlur(i, 4)],
      ["box 3", (i) => boxBlur(i, 3)],
      ["noise 10", (i) => addNoise(i, 10)],
      ["dim and noisy", (i) => addNoise(expose(i, 0.35), 5)],
      ["glare", (i) => addGlare(i, 300, 120, 16)],
    ];
    for (const [name, degrade] of cases) {
      const r = detect({ scale: 0.9 }, degrade);
      expect({ name, ok: r.error < 1.5 && r.confidence > 0.9 }).toEqual({ name, ok: true });
    }
  });

  it("on a table close to the card's brightness", () => {
    // The light card's base is 205: tables 15-25 levels darker or lighter.
    for (const background of [180, 190, 225, 230]) {
      const r = detect({ background });
      expect({ background, error: r.error < 1.5, confident: r.confidence >= minConfidence }).toEqual({
        background,
        error: true,
        confident: true,
      });
    }
  });

  it("tilted by up to 3 degrees", () => {
    for (const angleDeg of [-3, -1, 2, 3]) {
      const r = detect({ scale: 0.88, angleDeg });
      expect(r.error).toBeLessThan(3);
      expect(r.confidence).toBeGreaterThan(0.9);
    }
  });

  it("tilted by up to 10 degrees: measures the tilt and the corners", () => {
    for (const card of ["light", "dark"] as const) {
      for (const angleDeg of [-10, -8, -7, -6, -5, 4, 5, 6, 7, 8, 10]) {
        for (const scale of [0.86, 0.95]) {
          const scene = makeScene({ scale, angleDeg, card });
          const r = detectDocumentBox(scene.image, scene.guide);
          const label = { card, angleDeg, scale };
          expect({ ...label, confident: r.confidence >= 0.9 }).toEqual({ ...label, confident: true });
          expect(Math.abs(r.angle - angleDeg)).toBeLessThan(0.5);
          // The corners' bounds hold every card pixel; the sharp corners of the lines reach at
          // most ~2 px beyond the rounded ones.
          expect(extentError(r.extent, scene.extent!)).toBeLessThan(3.5);
          expect(contains(r.extent!, scene.extent!, 1)).toBe(true);
        }
      }
    }
  });

  it("seen at an angle (perspective), upright or tilted", () => {
    for (const keystone of [-0.1, -0.05, 0.05, 0.1]) {
      for (const angleDeg of [0, 4, -6]) {
        const scene = makeScene({ scale: 0.9, angleDeg, keystone });
        const r = detectDocumentBox(scene.image, scene.guide);
        expect(r.confidence).toBeGreaterThan(0.9);
        expect(contains(r.extent!, scene.extent!, 1)).toBe(true);
        expect(extentError(r.extent, scene.extent!)).toBeLessThan(3.5);
      }
    }
  });

  it("reports no tilt and the box itself as extent for an upright card", () => {
    const r = detect({ scale: 0.9 });
    expect(Math.abs(r.angle)).toBeLessThan(0.1);
    expect(extentError(r.extent, r.box!)).toBeLessThan(0.5);
  });

  it("held with fingers over its edges", () => {
    const scene = makeScene({ scale: 0.9 });
    const c = scene.card!;
    const held = finger(
      finger(scene.image, c.x + c.width * 0.3, c.y + c.height, 18, 30, 150),
      c.x,
      c.y + c.height * 0.6,
      25,
      16,
      140,
    );
    const r = detectDocumentBox(held, scene.guide);
    expect(edgeError(r.box, c)).toBeLessThan(2);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("on a cluttered background, usually (known limit, see README)", () => {
    let found = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = detect({ background: "cluttered", seed });
      if (r.confidence >= minConfidence && r.error < 8) found++;
    }
    expect(found).toBeGreaterThanOrEqual(10);
  });
});

describe("detectDocumentBox: no card", () => {
  it("plain backgrounds give no box", () => {
    for (const luma of [0, 70, 128, 220, 255]) {
      const scene = makeScene({ card: "none", background: luma });
      expect(detectDocumentBox(scene.image, scene.guide)).toEqual({
        box: null,
        confidence: 0,
        polarity: null,
        angle: 0,
        extent: null,
      });
    }
  });

  it("noisy backgrounds are never confident", () => {
    for (const background of [30, 128, 220, "dark", "light"] as const) {
      for (const sigma of [2, 5, 10, 20, 40]) {
        const scene = makeScene({ card: "none", background });
        const r = detectDocumentBox(addNoise(scene.image, sigma, sigma * 31), scene.guide);
        expect(r.confidence).toBeLessThan(0.1);
      }
    }
  });

  it("cluttered backgrounds without a card stay below the threshold", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const scene = makeScene({ card: "none", background: "cluttered", seed });
      expect(detectDocumentBox(scene.image, scene.guide).confidence).toBeLessThan(minConfidence);
    }
  });

  it("handles degenerate input", () => {
    const tiny: GrayImage = { width: 8, height: 8, data: new Uint8Array(64) };
    expect(detectDocumentBox(tiny, { x: 1, y: 1, width: 6, height: 6 }).box).toBeNull();
    const scene = makeScene();
    expect(detectDocumentBox(scene.image, { x: 0, y: 0, width: 0, height: 10 }).box).toBeNull();
    expect(detectDocumentBox(scene.image, { x: 900, y: 900, width: 100, height: 60 }).box).toBeNull();
    expect(() => detectDocumentBox({ width: 10, height: 10, data: new Uint8Array(5) }, scene.guide)).toThrow(RangeError);
  });
});

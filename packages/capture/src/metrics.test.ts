import { describe, expect, it } from "vitest";
import {
  estimateNoise,
  frameMotion,
  glare,
  laplacianDetail,
  laplacianVariance,
  lumaStats,
  meanLuma,
  temporalNoise,
} from "./metrics";
import { addCorrelatedNoise, addNoise, gaussianBlur, makeScene } from "./test-support/synthetic";
import type { GrayImage } from "./types";

function image(width: number, height: number, f: (x: number, y: number) => number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x, y);
  return { width, height, data };
}

describe("laplacianVariance", () => {
  it("is 0 on a flat image", () => {
    expect(laplacianVariance(image(20, 20, () => 128))).toBe(0);
  });

  it("matches hand-computed values on fine patterns", () => {
    // Checkerboard: every interior pixel's Laplacian is +-4 x 255.
    expect(laplacianVariance(image(10, 10, (x, y) => ((x + y) % 2) * 255))).toBe(1020 ** 2);
    // 1-px vertical stripes: +-2 x 255.
    expect(laplacianVariance(image(10, 10, (x) => (x % 2) * 255))).toBe(510 ** 2);
  });

  it("only measures inside the region", () => {
    const img = image(40, 20, (x, y) => (x < 20 ? 100 : ((x + y) % 2) * 255));
    expect(laplacianVariance(img, { x: 0, y: 0, width: 18, height: 20 })).toBe(0);
    expect(laplacianVariance(img, { x: 22, y: 0, width: 18, height: 20 })).toBeGreaterThan(1e5);
    expect(laplacianVariance(img, { x: 100, y: 100, width: 5, height: 5 })).toBe(0);
  });

  it("drops as the card is blurred", () => {
    const { image: sharp, card } = makeScene();
    const values = [0, 0.7, 1.5, 3].map((s) => laplacianVariance(s ? gaussianBlur(sharp, s) : sharp, card));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThan(values[i - 1]);
  });
});

describe("laplacianDetail", () => {
  const flat = image(200, 140, () => 128);

  it("is 0 on a flat image and on an empty region", () => {
    expect(laplacianDetail(flat)).toBe(0);
    expect(laplacianDetail(flat, { x: 500, y: 500, width: 10, height: 10 })).toBe(0);
  });

  it("is about 0 on noise alone, white or correlated", () => {
    for (const noisy of [addNoise(flat, 8), addCorrelatedNoise(flat, 6, 0.7), addCorrelatedNoise(flat, 6, "box3")]) {
      // The smoothed Laplacian of this noise has a variance of about 5-15; almost none is left.
      expect(laplacianDetail(noisy)).toBeLessThan(0.5);
    }
  });

  it("drops steeply as the card is blurred", () => {
    const { image: sharp, card } = makeScene();
    const values = [0, 1, 2, 3].map((s) => laplacianDetail(s ? gaussianBlur(sharp, s) : sharp, card));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThan(values[i - 1] / 2.5);
  });

  it("is not raised by correlated grain on a blurred card", () => {
    // The white-noise model behind estimateNoise reads this grain several times too low, so
    // `laplacianVariance - 20 * noise^2` would call this card sharp.
    const { image, card } = makeScene();
    const blurred = gaussianBlur(image, 2.5);
    const clean = laplacianDetail(blurred, card);
    expect(laplacianDetail(addCorrelatedNoise(blurred, 5, 0.5), card)).toBeLessThan(clean + 0.5);
    expect(laplacianDetail(addCorrelatedNoise(blurred, 6, "box3"), card)).toBeLessThan(clean + 0.5);
    const noise = estimateNoise(addCorrelatedNoise(blurred, 6, "box3"), card);
    expect(noise).toBeLessThan(3);
  });
});

describe("meanLuma / lumaStats", () => {
  it("averages inside the region", () => {
    const img = image(10, 10, (x) => (x < 5 ? 0 : 200));
    expect(meanLuma(img)).toBe(100);
    expect(meanLuma(img, { x: 5, y: 0, width: 5, height: 10 })).toBe(200);
    expect(meanLuma(img, { x: 50, y: 50, width: 5, height: 5 })).toBe(0);
    const stats = lumaStats(img);
    expect(stats.variance).toBe(100 * 100);
    expect(stats.count).toBe(100);
  });

  it("rounds a fractional region to whole pixels", () => {
    const img = image(10, 10, (x) => x * 10);
    expect(meanLuma(img, { x: 1.6, y: 0, width: 1, height: 10 })).toBe(20);
  });
});

describe("glare", () => {
  it("counts pixels at 250 and above as saturated", () => {
    const img = image(10, 10, (x, y) => (y === 0 ? (x < 5 ? 250 : 249) : 100));
    expect(glare(img, null, 1)).toEqual({ ratio: 0.05, maxTileRatio: 0.05 });
  });

  it("finds a hotspot that is small overall", () => {
    const img = image(200, 120, (x, y) => (Math.hypot(x - 30, y - 30) < 8 ? 255 : 120));
    const g = glare(img);
    expect(g.ratio).toBeLessThan(0.01);
    expect(g.maxTileRatio).toBeGreaterThan(0.05);
  });

  it("sees a hotspot on a tile boundary as a whole (tiles overlap)", () => {
    const blob = (cx: number, cy: number) => image(200, 200, (x, y) => (Math.hypot(x - cx, y - cy) < 10 ? 255 : 120));
    const inside = glare(blob(25, 25)).maxTileRatio; // centre of the first tile
    const onBoundary = glare(blob(100, 100)).maxTileRatio; // where four tiles meet
    expect(onBoundary).toBeCloseTo(inside, 2);
  });

  it("is zero without saturated pixels or region", () => {
    expect(glare(image(10, 10, () => 249))).toEqual({ ratio: 0, maxTileRatio: 0 });
    expect(glare(image(10, 10, () => 255), { x: 20, y: 20, width: 5, height: 5 })).toEqual({ ratio: 0, maxTileRatio: 0 });
    expect(() => glare(image(4, 4, () => 0), null, 0)).toThrow(RangeError);
  });
});

describe("estimateNoise", () => {
  it("recovers the standard deviation of added noise", () => {
    const flat = image(240, 160, () => 128);
    for (const sigma of [2, 5, 10]) {
      expect(estimateNoise(addNoise(flat, sigma))).toBeCloseTo(sigma, 0);
    }
  });

  it("ignores straight edges and smooth gradients", () => {
    // A noiseless image reads ~0.06, not 0: the median is interpolated inside the zero bin.
    expect(estimateNoise(image(60, 60, (x) => (x < 30 ? 40 : 200)))).toBeLessThan(0.1);
    expect(estimateNoise(image(60, 60, (x, y) => x + 2 * y))).toBeLessThan(0.1);
  });

  it("stays low on a clean printed card", () => {
    const { image: img, card } = makeScene();
    expect(estimateNoise(img, card)).toBeLessThan(1);
    // Text adds a little on top of the noise.
    const noisy = estimateNoise(addNoise(img, 6), card);
    expect(noisy).toBeGreaterThan(5.5);
    expect(noisy).toBeLessThan(7);
  });
});

describe("temporalNoise", () => {
  it("recovers the grain of each frame, white or correlated", () => {
    const { image: card } = makeScene({ scale: 0.9 });
    for (const [a, b, sigma] of [
      [addNoise(card, 4, 1), addNoise(card, 4, 2), 4],
      [addCorrelatedNoise(card, 6, "box3", 1), addCorrelatedNoise(card, 6, "box3", 2), 6],
      [addCorrelatedNoise(card, 5, 0.7, 1), addCorrelatedNoise(card, 5, 0.7, 2), 5],
    ] as const) {
      const value = temporalNoise(a, b);
      expect(value).toBeGreaterThan(sigma * 0.85);
      expect(value).toBeLessThan(sigma * 1.2);
    }
  });

  it("stays low when only the card moved", () => {
    const a = makeScene({ scale: 0.9 }).image;
    expect(temporalNoise(a, a)).toBeLessThan(0.5);
    expect(temporalNoise(a, makeScene({ scale: 0.9, offsetX: 2 / 400 }).image)).toBeLessThan(1);
  });

  it("requires frames of the same size", () => {
    expect(() => temporalNoise(image(4, 4, () => 0), image(4, 5, () => 0))).toThrow(RangeError);
  });
});

describe("frameMotion", () => {
  it("is the mean absolute difference", () => {
    const a = image(8, 8, () => 100);
    expect(frameMotion(a, a)).toBe(0);
    expect(frameMotion(a, image(8, 8, (x) => (x < 4 ? 110 : 90)))).toBe(10);
  });

  it("grows with the shift between frames", () => {
    const a = makeScene({ scale: 0.9 }).image;
    const one = makeScene({ scale: 0.9, offsetX: 1 / 400 }).image;
    const four = makeScene({ scale: 0.9, offsetX: 4 / 400 }).image;
    expect(frameMotion(a, one)).toBeLessThan(frameMotion(a, four));
  });

  it("requires frames of the same size", () => {
    expect(() => frameMotion(image(4, 4, () => 0), image(4, 5, () => 0))).toThrow(RangeError);
  });
});

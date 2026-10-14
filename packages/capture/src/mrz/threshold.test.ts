import { describe, expect, it } from "vitest";
import { histogram, localInkMask, otsuThreshold, percentile } from "./threshold";

describe("otsuThreshold", () => {
  it("splits two clusters between them", () => {
    const hist = new Array(256).fill(0);
    for (let v = 20; v <= 40; v++) hist[v] = 10;
    for (let v = 190; v <= 220; v++) hist[v] = 30;
    const t = otsuThreshold(hist);
    expect(t).toBeGreaterThanOrEqual(40);
    expect(t).toBeLessThan(190);
  });

  it("returns a middle value for an empty histogram", () => {
    expect(otsuThreshold(new Array(256).fill(0))).toBe(127);
  });
});

describe("percentile", () => {
  it("finds the level below which a share of the pixels lie", () => {
    const hist = new Array(256).fill(0);
    hist[10] = 1;
    hist[100] = 98;
    hist[250] = 1;
    expect(percentile(hist, 0.005)).toBe(10);
    expect(percentile(hist, 0.5)).toBe(100);
    expect(percentile(hist, 0.995)).toBe(250);
  });
});

describe("histogram", () => {
  it("counts the levels inside the bounds only", () => {
    const img = { width: 3, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    const hist = histogram(img, { x0: 1, y0: 0, x1: 3, y1: 2 });
    expect([hist[2], hist[3], hist[5], hist[6], hist[1], hist[4]]).toEqual([1, 1, 1, 1, 0, 0]);
  });
});

describe("localInkMask", () => {
  const options = { radius: 8, darker: 0.2, minContrast: 20 };

  it("marks dark strokes on paper, under falling light as in the light", () => {
    // Paper fading from 230 to 90 across the image, with 2-px strokes at 45% of the paper level.
    const w = 120;
    const h = 20;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const paper = 230 - (140 * x) / w;
        data[y * w + x] = x % 10 < 2 ? Math.round(paper * 0.45) : Math.round(paper);
      }
    }
    const mask = localInkMask({ width: w, height: h, data }, { x0: 0, y0: 0, x1: w, y1: h }, options);
    for (let x = 0; x < w; x++) expect(mask[10 * w + x]).toBe(x % 10 < 2 ? 1 : 0);
  });

  it("leaves flat paper with sensor noise and faint texture alone", () => {
    const w = 60;
    const h = 30;
    const data = new Uint8Array(w * h).map((_, i) => 200 + ((i * 7919) % 13) - 6);
    const mask = localInkMask({ width: w, height: h, data }, { x0: 0, y0: 0, x1: w, y1: h }, options);
    expect(mask.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("returns a mask the size of the bounds", () => {
    const img = { width: 10, height: 10, data: new Uint8Array(100).fill(200) };
    expect(localInkMask(img, { x0: 2, y0: 3, x1: 7, y1: 9 }, options)).toHaveLength(30);
    expect(localInkMask(img, { x0: 2, y0: 3, x1: 2, y1: 9 }, options)).toHaveLength(0);
  });
});

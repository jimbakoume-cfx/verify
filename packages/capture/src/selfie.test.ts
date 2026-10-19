import { describe, expect, it } from "vitest";
import { SELFIE_THRESHOLDS, analyzeSelfie } from "./selfie";
import { rng } from "./test-support/synthetic";
import type { GrayImage, Rect } from "./types";

const W = 96;
const H = 128;
const OVAL: Rect = { x: 18, y: 16, width: 60, height: 80 };

/** A picture: `background` around, a face-like oval of `face` brightness with eyes and a mouth, plus noise. */
function scene({ background = 120, face = 140, features = true, noise = 4, seed = 1 } = {}): GrayImage {
  const random = rng(seed);
  const data = new Uint8ClampedArray(W * H);
  const cx = OVAL.x + OVAL.width / 2;
  const cy = OVAL.y + OVAL.height / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inOval = ((x - cx) / (OVAL.width / 2)) ** 2 + ((y - cy) / (OVAL.height / 2)) ** 2 <= 1;
      let v = inOval ? face : background;
      if (features && inOval) {
        const eye = (Math.abs(x - (cx - 12)) < 5 || Math.abs(x - (cx + 12)) < 5) && Math.abs(y - (cy - 10)) < 3;
        const mouth = Math.abs(x - cx) < 12 && Math.abs(y - (cy + 18)) < 3;
        const hair = y < OVAL.y + 14;
        if (eye || mouth) v = face - 90;
        if (hair) v = face - 100;
      }
      data[y * W + x] = v + (random() - 0.5) * 2 * noise;
    }
  }
  return { width: W, height: H, data };
}

describe("analyzeSelfie", () => {
  it("finds nothing to say about a lit face in the oval", () => {
    const result = analyzeSelfie(scene(), OVAL);
    expect(result.hint).toBeNull();
    expect(result.meanLuma).toBeGreaterThan(SELFIE_THRESHOLDS.minMeanLuma);
    expect(result.contrast).toBeGreaterThan(SELFIE_THRESHOLDS.minContrast);
  });

  it.each([
    ["too_dark", scene({ background: 20, face: 30 })],
    ["too_bright", scene({ background: 250, face: 245, noise: 1 })],
    ["backlit", scene({ background: 235, face: 120 })],
    ["no_face", scene({ background: 128, face: 128, features: false, noise: 2 })],
  ])("says %s", (hint, image) => {
    expect(analyzeSelfie(image, OVAL).hint).toBe(hint);
  });

  it("puts darkness before every other problem", () => {
    // Dark, flat and lit from behind at once: the rider is told about the light first.
    expect(analyzeSelfie(scene({ background: 200, face: 20, features: false }), OVAL).hint).toBe("too_dark");
  });

  it("measures the backlight as the surroundings minus the oval", () => {
    const result = analyzeSelfie(scene({ background: 200, face: 120, features: false, noise: 0 }), OVAL);
    // About 80 less what the inner box takes from the background at its corners.
    expect(result.backlight).toBeGreaterThan(60);
    expect(result.backlight).toBeLessThan(80);
  });

  it("takes other thresholds", () => {
    expect(analyzeSelfie(scene(), OVAL, { ...SELFIE_THRESHOLDS, minMeanLuma: 200 }).hint).toBe("too_dark");
  });
});

// Calibration of DEFAULT_THRESHOLDS on synthetic images: each case states the hints it must get.
// To print the measured values (e.g. after changing a threshold or the card artwork):
//   CAPTURE_CALIBRATION=1 npx vitest run packages/capture/src/calibration.test.ts
import { describe, expect, it } from "vitest";
import { analyzeFrame } from "./analyze";
import { STILL_CROP_EXPANSION, expandRect } from "./geometry";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import {
  addCorrelatedNoise,
  addGlare,
  addNoise,
  boxBlur,
  expose,
  gaussianBlur,
  makeScene,
  type SceneOptions,
} from "./test-support/synthetic";
import type { FrameAnalysis, GrayImage, Hint, Rect } from "./types";

interface Case {
  name: string;
  scene?: SceneOptions;
  degrade?: (img: GrayImage) => GrayImage;
  /** Previous frame, for the steadiness cases. */
  prev?: SceneOptions;
  /** Degradation of the previous frame (e.g. its own sensor noise). */
  prevDegrade?: (img: GrayImage) => GrayImage;
  expected: Hint[];
}

const card = { x: 240, y: 150 }; // a point on the card's text, for glare blobs

const groups: Record<string, Case[]> = {
  "sharpness (blur)": [
    { name: "sharp", expected: [] },
    { name: "box blur r1", degrade: (i) => boxBlur(i, 1), expected: [] },
    { name: "box blur r2", degrade: (i) => boxBlur(i, 2), expected: [] },
    { name: "box blur r3", degrade: (i) => boxBlur(i, 3), expected: ["blurry"] },
    { name: "box blur r5", degrade: (i) => boxBlur(i, 5), expected: ["blurry"] },
    { name: "gaussian 0.6", degrade: (i) => gaussianBlur(i, 0.6), expected: [] },
    { name: "gaussian 1.0", degrade: (i) => gaussianBlur(i, 1), expected: [] },
    // Borderline on purpose: passes on a clean picture, fails once grain or dim light is added.
    { name: "gaussian 1.5 (borderline)", degrade: (i) => gaussianBlur(i, 1.5), expected: [] },
    { name: "gaussian 2", degrade: (i) => gaussianBlur(i, 2), expected: ["blurry"] },
    { name: "gaussian 4", degrade: (i) => gaussianBlur(i, 4), expected: ["blurry"] },
    { name: "dark card, gaussian 1.0", scene: { card: "dark" }, degrade: (i) => gaussianBlur(i, 1), expected: [] },
    { name: "dark card, gaussian 2", scene: { card: "dark" }, degrade: (i) => gaussianBlur(i, 2), expected: ["blurry"] },
    { name: "dim (0.4x), gaussian 1.0", degrade: (i) => expose(gaussianBlur(i, 1), 0.4), expected: [] },
    { name: "dim (0.4x), gaussian 2", degrade: (i) => expose(gaussianBlur(i, 2), 0.4), expected: ["blurry"] },
  ],
  "noise": [
    { name: "noise 4", degrade: (i) => addNoise(i, 4), expected: [] },
    { name: "noise 10", degrade: (i) => addNoise(i, 10), expected: [] },
    { name: "dark card, noise 8", scene: { card: "dark" }, degrade: (i) => addNoise(i, 8), expected: [] },
    { name: "gaussian 2 + noise 4", degrade: (i) => addNoise(gaussianBlur(i, 2), 4), expected: ["blurry"] },
    { name: "gaussian 2 + noise 10", degrade: (i) => addNoise(gaussianBlur(i, 2), 10), expected: ["blurry"] },
    { name: "box blur r3 + noise 6", degrade: (i) => addNoise(boxBlur(i, 3), 6), expected: ["blurry"] },
  ],
  // Phone previews: the grain is smeared over neighbouring pixels (demosaicing, denoising,
  // resampling). A white-noise model reads it several times too low; it must not pass a blurred
  // card, least of all in dim light, where autofocus misses most.
  "correlated noise": [
    { name: "sharp + grain 5 (0.5 px)", degrade: (i) => addCorrelatedNoise(i, 5, 0.5), expected: [] },
    { name: "sharp + grain 6 (3x3)", degrade: (i) => addCorrelatedNoise(i, 6, "box3"), expected: [] },
    { name: "gaussian 1 + grain 5 (0.5 px)", degrade: (i) => addCorrelatedNoise(gaussianBlur(i, 1), 5, 0.5), expected: [] },
    { name: "gaussian 1 + grain 6 (3x3)", degrade: (i) => addCorrelatedNoise(gaussianBlur(i, 1), 6, "box3"), expected: [] },
    { name: "0.5x, gaussian 1 + grain 3 (0.7 px)", degrade: (i) => addCorrelatedNoise(expose(gaussianBlur(i, 1), 0.5), 3, 0.7), expected: [] },
    { name: "dark card, gaussian 1 + grain 3 (0.5 px)", scene: { card: "dark" }, degrade: (i) => addCorrelatedNoise(gaussianBlur(i, 1), 3, 0.5), expected: [] },
    { name: "gaussian 2.5 + grain 5 (0.5 px)", degrade: (i) => addCorrelatedNoise(gaussianBlur(i, 2.5), 5, 0.5), expected: ["blurry"] },
    { name: "0.6x, gaussian 2.5 + grain 5 (0.5 px)", degrade: (i) => addCorrelatedNoise(expose(gaussianBlur(i, 2.5), 0.6), 5, 0.5), expected: ["blurry"] },
    { name: "gaussian 3 + grain 6 (3x3)", degrade: (i) => addCorrelatedNoise(gaussianBlur(i, 3), 6, "box3"), expected: ["blurry"] },
    { name: "0.5x, gaussian 3 + grain 6 (3x3)", degrade: (i) => addCorrelatedNoise(expose(gaussianBlur(i, 3), 0.5), 6, "box3"), expected: ["blurry"] },
    { name: "0.5x, gaussian 2 + grain 3 (0.5 px)", degrade: (i) => addCorrelatedNoise(expose(gaussianBlur(i, 2), 0.5), 3, 0.5), expected: ["blurry"] },
    { name: "0.6x, gaussian 2 + grain 3 (0.7 px)", degrade: (i) => addCorrelatedNoise(expose(gaussianBlur(i, 2), 0.6), 3, 0.7), expected: ["blurry"] },
    { name: "0.5x, gaussian 2 + grain 4 (1 px)", degrade: (i) => addCorrelatedNoise(expose(gaussianBlur(i, 2), 0.5), 4, 1), expected: ["blurry"] },
    { name: "dark card, gaussian 2 + grain 3 (0.5 px)", scene: { card: "dark" }, degrade: (i) => addCorrelatedNoise(gaussianBlur(i, 2), 3, 0.5), expected: ["blurry"] },
    { name: "dark card, gaussian 3 + grain 3 (0.7 px)", scene: { card: "dark" }, degrade: (i) => addCorrelatedNoise(gaussianBlur(i, 3), 3, 0.7), expected: ["blurry"] },
    { name: "0.5x, gaussian 1.5 + grain 4 (0.7 px)", degrade: (i) => addCorrelatedNoise(expose(gaussianBlur(i, 1.5), 0.5), 4, 0.7), expected: ["blurry"] },
  ],
  "glare": [
    { name: "hotspot r3", degrade: (i) => addGlare(i, card.x, card.y, 3), expected: [] },
    { name: "hotspot r6", degrade: (i) => addGlare(i, card.x, card.y, 6), expected: [] },
    { name: "hotspot r9", degrade: (i) => addGlare(i, card.x, card.y, 9), expected: ["glare"] },
    { name: "hotspot r12", degrade: (i) => addGlare(i, card.x, card.y, 12), expected: ["glare"] },
    { name: "hotspot r24", degrade: (i) => addGlare(i, card.x, card.y, 24), expected: ["glare"] },
    // A darker card on white paper in daylight: the slivers of paper in the corners of a slightly
    // tilted card's box are not glare on the card.
    { name: "dark card on clipped white, tilted 1.5", scene: { card: "dark", background: 255, scale: 0.9, angleDeg: 1.5 }, expected: [] },
    { name: "dark card on clipped white, tilted 3", scene: { card: "dark", background: 255, scale: 0.9, angleDeg: -3 }, expected: [] },
    { name: "dark card on 250, tilted 3", scene: { card: "dark", background: 250, scale: 0.9, angleDeg: 3 }, expected: [] },
    {
      name: "six small glints",
      degrade: (i) => [60, 120, 180, 240, 300, 360].reduce((img, x) => addGlare(img, x + 40, 100 + (x % 120), 5), i),
      expected: [],
    },
  ],
  "exposure": [
    { name: "0.25x (under)", degrade: (i) => expose(i, 0.25), expected: ["too_dark"] },
    { name: "0.35x", degrade: (i) => expose(i, 0.35), expected: [] },
    { name: "0.7x", degrade: (i) => expose(i, 0.7), expected: [] },
    { name: "1.1x", degrade: (i) => expose(i, 1.1), expected: [] },
    { name: "1.3x + 10 (over)", degrade: (i) => expose(i, 1.3, 10), expected: ["too_bright", "glare"] },
    { name: "1.5x + 10 (over)", degrade: (i) => expose(i, 1.5, 10), expected: ["too_bright", "glare"] },
    { name: "dark card, normal", scene: { card: "dark" }, expected: [] },
    { name: "dark card, 0.5x", scene: { card: "dark" }, degrade: (i) => expose(i, 0.5), expected: ["too_dark"] },
  ],
  "framing": [
    { name: "50% of the guide", scene: { scale: 0.5 }, expected: ["move_closer"] },
    { name: "80%", scene: { scale: 0.8 }, expected: ["move_closer"] },
    { name: "90%", scene: { scale: 0.9 }, expected: [] },
    { name: "100%", scene: { scale: 1 }, expected: [] },
    { name: "110%", scene: { scale: 1.1 }, expected: ["move_back"] },
    { name: "dark card 50%", scene: { scale: 0.5, card: "dark" }, expected: ["move_closer"] },
    { name: "dark card 90%", scene: { scale: 0.9, card: "dark" }, expected: [] },
    { name: "dark card 110%", scene: { scale: 1.1, card: "dark" }, expected: ["move_back"] },
    { name: "off-centre 5% right", scene: { scale: 0.88, offsetX: 0.05 }, expected: [] },
    { name: "off-centre 10% right", scene: { scale: 0.85, offsetX: 0.1 }, expected: ["center_document"] },
    { name: "off-centre 10% down", scene: { scale: 0.85, offsetY: 0.1 }, expected: ["center_document"] },
    { name: "off-centre up-left", scene: { scale: 0.85, offsetX: -0.1, offsetY: -0.06 }, expected: ["center_document"] },
    { name: "tilted 3 degrees", scene: { scale: 0.88, angleDeg: 3 }, expected: [] },
  ],
  // A card held askew: up to maxTiltDeg (4) it is accepted as long as its corners fit; beyond,
  // the rider is asked to straighten it (center_document), and it is still found up to ~10.
  "tilt and perspective": [
    { name: "tilted -4 degrees", scene: { scale: 0.86, angleDeg: -4 }, expected: [] },
    { name: "tilted 5 degrees", scene: { scale: 0.86, angleDeg: 5 }, expected: ["center_document"] },
    { name: "tilted -7 degrees", scene: { scale: 0.86, angleDeg: -7 }, expected: ["center_document"] },
    { name: "tilted 10 degrees", scene: { scale: 0.86, angleDeg: 10 }, expected: ["center_document"] },
    { name: "dark card tilted 8 degrees", scene: { scale: 0.86, angleDeg: 8, card: "dark" }, expected: ["center_document"] },
    // Fits upright, but at 3 degrees its corners would be cut from the photo.
    { name: "100%, tilted 3 degrees", scene: { scale: 1, angleDeg: 3 }, expected: ["center_document"] },
    { name: "perspective (bottom 6% wider)", scene: { scale: 0.9, keystone: 0.06 }, expected: [] },
    { name: "perspective, tilted 3 degrees", scene: { scale: 0.88, keystone: -0.06, angleDeg: 3 }, expected: [] },
  ],
  "backgrounds": [
    { name: "light card on dark table", scene: { card: "light", background: "dark" }, expected: [] },
    { name: "dark card on light table", scene: { card: "dark", background: "light" }, expected: [] },
    { name: "light card on similar table (190)", scene: { background: 190 }, expected: [] },
    { name: "light card on white table (230)", scene: { background: 230 }, expected: [] },
    { name: "no card, plain", scene: { card: "none", background: 120 }, expected: ["no_document", "blurry"] },
    { name: "no card, noise 10", scene: { card: "none", background: 120 }, degrade: (i) => addNoise(i, 10), expected: ["no_document", "blurry"] },
  ],
  "steadiness": [
    { name: "same frame", prev: {}, expected: [] },
    { name: "moved 1 px", scene: { offsetX: 1 / 400 }, prev: {}, expected: [] },
    { name: "moved 2 px", scene: { offsetX: 2 / 400 }, prev: {}, expected: [] },
    { name: "moved 4 px", scene: { offsetX: 4 / 400 }, prev: {}, expected: ["hold_still"] },
    { name: "dark card moved 8 px", scene: { card: "dark", offsetX: 8 / 400 }, prev: { card: "dark" }, expected: ["hold_still"] },
    // Fresh grain in every frame: a still phone in dim light must not be asked to hold still.
    {
      name: "still, grain 6 (3x3) each frame",
      prev: {},
      degrade: (i) => addCorrelatedNoise(i, 6, "box3", 21),
      prevDegrade: (i) => addCorrelatedNoise(i, 6, "box3", 22),
      expected: [],
    },
    {
      name: "moved 1 px, grain 6 (3x3) each frame",
      scene: { offsetX: 1 / 400 },
      prev: {},
      degrade: (i) => addCorrelatedNoise(i, 6, "box3", 21),
      prevDegrade: (i) => addCorrelatedNoise(i, 6, "box3", 22),
      expected: [],
    },
    {
      name: "moved 4 px, grain 4 (0.7 px) each frame",
      scene: { offsetX: 4 / 400 },
      prev: {},
      degrade: (i) => addCorrelatedNoise(i, 4, 0.7, 21),
      prevDegrade: (i) => addCorrelatedNoise(i, 4, 0.7, 22),
      expected: ["hold_still"],
    },
  ],
};

function run(c: Case): FrameAnalysis {
  const scene = makeScene(c.scene);
  const image = c.degrade ? c.degrade(scene.image) : scene.image;
  const prevScene = c.prev ? makeScene(c.prev).image : null;
  const prev = prevScene && c.prevDegrade ? c.prevDegrade(prevScene) : prevScene;
  return analyzeFrame(image, scene.guide, prev, DEFAULT_THRESHOLDS);
}

describe("auto-capture never cuts the card", () => {
  it("no accepted frame has card pixels outside the still crop (tilt 0-10, perspective)", () => {
    const crop = (guide: Rect) => expandRect(guide, STILL_CROP_EXPANSION);
    const cut: string[] = [];
    let accepted = 0;
    for (const scale of [0.9, 0.96, 1, 1.02]) {
      for (const angleDeg of [0, 1, -2, 3, -4, 5, -6, 8, -10]) {
        for (const keystone of [0, 0.06]) {
          const scene = makeScene({ scale, angleDeg, keystone });
          const a = analyzeFrame(scene.image, scene.guide, null, DEFAULT_THRESHOLDS);
          if (!a.ok) continue;
          accepted++;
          const c = crop(scene.guide);
          const e = scene.extent!;
          const outside = Math.max(c.x - e.x, e.x + e.width - c.x - c.width, c.y - e.y, e.y + e.height - c.y - c.height);
          if (outside > 0) cut.push(`scale ${scale}, ${angleDeg} deg, keystone ${keystone}: ${outside.toFixed(1)} px`);
        }
      }
    }
    expect(cut).toEqual([]);
    expect(accepted).toBeGreaterThan(10);
  });
});

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const report = Boolean(env?.CAPTURE_CALIBRATION);

describe("DEFAULT_THRESHOLDS calibration (synthetic images)", () => {
  for (const [group, cases] of Object.entries(groups)) {
    it(group, () => {
      const rows = cases.map((c) => ({ c, a: run(c) }));
      if (report) {
        console.table(
          rows.map(({ c, a }) => ({
            case: c.name,
            focus: Math.round(a.metrics.focus),
            sharpness: Math.round(a.metrics.sharpness),
            noise: +a.metrics.noise.toFixed(1),
            glareTile: +a.metrics.glareTileRatio.toFixed(4),
            glare: +a.metrics.glareRatio.toFixed(4),
            luma: Math.round(a.metrics.meanLuma),
            framing: +a.metrics.framing.toFixed(2),
            offset: +a.metrics.centerOffset.toFixed(3),
            overshoot: +a.metrics.overshoot.toFixed(3),
            motion: a.metrics.motion === null ? "-" : +a.metrics.motion.toFixed(2),
            confidence: +a.metrics.documentConfidence.toFixed(2),
            tilt: +a.metrics.documentAngle.toFixed(1),
            hints: a.hints.join(" "),
          })),
        );
      }
      for (const { c, a } of rows) expect({ case: c.name, hints: a.hints }).toEqual({ case: c.name, hints: c.expected });
    });
  }
});

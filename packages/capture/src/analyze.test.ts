import { describe, expect, it } from "vitest";
import { HINT_PRIORITY, analyzeFrame } from "./analyze";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import { addGlare, addNoise, gaussianBlur, makeScene } from "./test-support/synthetic";
import type { GrayImage } from "./types";

describe("analyzeFrame", () => {
  it("accepts a sharp, well-lit card that fills the guide", () => {
    const { image, guide, card } = makeScene({ scale: 0.95 });
    const a = analyzeFrame(image, guide, image);
    expect(a.hints).toEqual([]);
    expect(a.ok).toBe(true);
    const m = a.metrics;
    expect(m.documentBox).not.toBeNull();
    expect(Math.abs(m.documentBox!.x - card!.x)).toBeLessThan(1);
    expect(m.framing).toBeCloseTo(0.95 * 0.95, 2);
    expect(m.coverage).toBeCloseTo(0.95 * 0.95, 2);
    expect(m.centerOffset).toBeLessThan(0.01);
    expect(m.overshoot).toBe(0);
    expect(m.motion).toBe(0);
    expect(m.documentConfidence).toBeGreaterThan(0.9);
  });

  it("measures brightness, glare and sharpness on the card, not the background", () => {
    const { image, guide } = makeScene({ scale: 0.9, background: "dark" });
    const a = analyzeFrame(image, guide, null);
    // The light card averages ~186; the whole image, with its dark surround, much less.
    expect(a.metrics.meanLuma).toBeGreaterThan(175);
    // A hotspot on the table, outside the card, is not glare on the document.
    const tableGlare = analyzeFrame(addGlare(image, 12, 12, 10), guide, null);
    expect(tableGlare.hints).not.toContain("glare");
    const cardGlare = analyzeFrame(addGlare(image, 240, 150, 10), guide, null);
    expect(cardGlare.hints).toContain("glare");
  });

  it("measures inside the guide when no document is found", () => {
    const { image, guide } = makeScene({ card: "none", background: 128 });
    const a = analyzeFrame(image, guide, null);
    expect(a.hints[0]).toBe("no_document");
    expect(a.metrics.documentBox).toBeNull();
    expect(a.metrics.framing).toBe(0);
    expect(a.metrics.meanLuma).toBe(128);
    expect(a.ok).toBe(false);
  });

  it("asks to move closer, move back or centre the card", () => {
    const hintsFor = (scale: number, offsetX = 0, offsetY = 0) => {
      const { image, guide } = makeScene({ scale, offsetX, offsetY });
      return analyzeFrame(image, guide, null).hints;
    };
    expect(hintsFor(0.5)).toEqual(["move_closer"]);
    expect(hintsFor(0.8)).toEqual(["move_closer"]);
    expect(hintsFor(0.9)).toEqual([]);
    expect(hintsFor(1.0)).toEqual([]);
    expect(hintsFor(1.1)).toEqual(["move_back"]);
    expect(hintsFor(0.85, 0.1)).toEqual(["center_document"]);
    // Right size, but sticking out on one side: it would be cut off, so centre it.
    expect(hintsFor(1.0, 0.03)).toEqual(["center_document"]);
    // Too small and off-centre: both, closer first.
    expect(hintsFor(0.6, 0.12)).toEqual(["move_closer", "center_document"]);
  });

  it("lists hints in priority order", () => {
    const { image, guide } = makeScene({ scale: 0.5 });
    const dimBlurredGlare = addGlare(gaussianBlur(image, 2), 240, 150, 12);
    const hints = analyzeFrame(dimBlurredGlare, guide, null).hints;
    expect(hints).toEqual(["move_closer", "glare", "blurry"]);
    expect([...hints].sort((a, b) => HINT_PRIORITY.indexOf(a) - HINT_PRIORITY.indexOf(b))).toEqual(hints);
  });

  it("checks steadiness against the previous frame", () => {
    const still = makeScene({ scale: 0.9 });
    const moved = makeScene({ scale: 0.9, offsetX: 4 / 400 });
    expect(analyzeFrame(moved.image, still.guide, still.image).hints).toEqual(["hold_still"]);
    const nudged = makeScene({ scale: 0.9, offsetX: 1 / 400 });
    expect(analyzeFrame(nudged.image, still.guide, still.image).hints).toEqual([]);
    // Camera grain alone is not movement.
    const grain = analyzeFrame(addNoise(still.image, 6, 2), still.guide, addNoise(still.image, 6, 1));
    expect(grain.hints).toEqual([]);
    expect(grain.metrics.motion).toBeGreaterThan(5);
  });

  it("ignores a previous frame of another size", () => {
    const { image, guide } = makeScene();
    const other: GrayImage = { width: 10, height: 10, data: new Uint8Array(100) };
    expect(analyzeFrame(image, guide, other).metrics.motion).toBeNull();
    expect(analyzeFrame(image, guide, null).metrics.motion).toBeNull();
  });

  it("uses the thresholds it is given", () => {
    const { image, guide } = makeScene();
    expect(analyzeFrame(image, guide, null, { ...DEFAULT_THRESHOLDS, minSharpness: 1e9 }).hints).toEqual(["blurry"]);
    expect(analyzeFrame(image, guide, null, { ...DEFAULT_THRESHOLDS, maxMeanLuma: 100 }).hints).toEqual(["too_bright"]);
    expect(analyzeFrame(image, guide, null, { ...DEFAULT_THRESHOLDS, minDocumentConfidence: 1.01 }).hints[0]).toBe(
      "no_document",
    );
  });

  it("keeps DEFAULT_THRESHOLDS read-only", () => {
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
  });

  it("runs well within the frame budget (480 x 303)", () => {
    const { image, guide } = makeScene({ background: "cluttered", seed: 3 });
    const prev = addNoise(image, 3);
    for (let i = 0; i < 10; i++) analyzeFrame(image, guide, prev);
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      analyzeFrame(image, guide, prev);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    // Spec target: under 15 ms in Node. Typical: 3-5 ms on a laptop.
    expect(times[15]).toBeLessThan(15);
  });
});

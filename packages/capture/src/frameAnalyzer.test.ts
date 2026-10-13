import { describe, expect, it } from "vitest";
import { FrameAnalyzer, toClientQuality } from "./frameAnalyzer";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import { makeScene } from "./test-support/synthetic";
import type { GrayImage } from "./types";

/** Gray image to RGBA, as a canvas would deliver it. */
function rgba(img: GrayImage) {
  const data = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = img.data[i];
    data[i * 4 + 3] = 255;
  }
  return { data, width: img.width, height: img.height };
}

describe("FrameAnalyzer", () => {
  const steady = makeScene({ scale: 0.95 });
  const frame = rgba(steady.image);

  it("captures after the required good frames, once", () => {
    const analyzer = new FrameAnalyzer();
    const decisions = Array.from({ length: 8 }, () => analyzer.push(frame, steady.guide).decision);
    const n = DEFAULT_THRESHOLDS.stableFramesRequired;
    expect(decisions.indexOf("capture")).toBe(n - 1);
    expect(decisions.filter((d) => d === "capture")).toHaveLength(1);
  });

  it("compares each frame with the previous one", () => {
    const analyzer = new FrameAnalyzer();
    expect(analyzer.push(frame, steady.guide).analysis.metrics.motion).toBeNull();
    expect(analyzer.push(frame, steady.guide).analysis.metrics.motion).toBe(0);
    const moved = rgba(makeScene({ scale: 0.95, offsetX: 4 / 400 }).image);
    const step = analyzer.push(moved, steady.guide);
    expect(step.analysis.hints).toContain("hold_still");
    // The buffers are swapped, not overwritten: the next comparison is with `moved`.
    expect(analyzer.push(moved, steady.guide).analysis.metrics.motion).toBe(0);
  });

  it("re-arms on reset", () => {
    const analyzer = new FrameAnalyzer({ ...DEFAULT_THRESHOLDS, stableFramesRequired: 1 });
    expect(analyzer.push(frame, steady.guide).decision).toBe("capture");
    expect(analyzer.push(frame, steady.guide).decision).toBe("wait");
    analyzer.reset();
    const step = analyzer.push(frame, steady.guide);
    expect(step.decision).toBe("capture");
    expect(step.analysis.metrics.motion).toBeNull();
  });

  it("copes with a frame size change", () => {
    const analyzer = new FrameAnalyzer();
    analyzer.push(frame, steady.guide);
    const small = makeScene();
    const half = { width: 240, height: 151, data: new Uint8ClampedArray(240 * 151 * 4) };
    expect(analyzer.push(half, { x: 20, y: 12, width: 200, height: 126 }).analysis.metrics.motion).toBeNull();
    expect(analyzer.push(rgba(small.image), small.guide).analysis.metrics.motion).toBeNull();
  });
});

describe("toClientQuality", () => {
  it("maps metrics and context to the contract's shape", () => {
    expect(
      toClientQuality(
        { sharpness: 1234.567, glareRatio: 0.012345, meanLuma: 180.04, framing: 0.81234 },
        { source: "auto", videoWidth: 1920, videoHeight: 1080, elapsedMs: 4321.7 },
      ),
    ).toEqual({
      source: "auto",
      sharpness: 1234.6,
      glareRatio: 0.0123,
      meanLuma: 180,
      framing: 0.812,
      videoWidth: 1920,
      videoHeight: 1080,
      elapsedMs: 4322,
    });
  });
});

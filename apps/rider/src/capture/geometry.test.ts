import { describe, expect, it } from "vitest";
import { ANALYSIS_WIDTH } from "@verify/capture";
import { CAPTURE_LIMITS, DOCUMENT_ASPECT } from "@verify/shared";
import { guideInArea, guideInStillCopy, planFrame, planStill } from "./geometry";

const ASPECT = DOCUMENT_ASPECT.cni_legacy;
const close = (value: number, expected: number, digits = 3) => expect(value).toBeCloseTo(expected, digits);

describe("guideInArea", () => {
  it("fits a card-shaped guide in the free area, centred", () => {
    const area = { x: 0, y: 120, width: 390, height: 560 };
    const guide = guideInArea(area, ASPECT);
    close(guide.width / guide.height, ASPECT);
    close(guide.width, 390 * 0.92);
    close(guide.x + guide.width / 2, 195);
    close(guide.y + guide.height / 2, 120 + 280);
  });

  it("is limited by height in landscape", () => {
    const guide = guideInArea({ x: 0, y: 48, width: 740, height: 300 }, ASPECT);
    close(guide.height, 300 * 0.92);
    expect(guide.width).toBeLessThan(740 * 0.92);
  });
});

describe("planFrame", () => {
  const view = { width: 390, height: 844 };
  const guideView = guideInArea({ x: 0, y: 120, width: 390, height: 560 }, ASPECT);

  it("maps a portrait phone stream (1080x1920) to video pixels", () => {
    const plan = planFrame(guideView, view, { width: 1080, height: 1920 })!;
    // cover: scale = max(390/1080, 844/1920) = 0.4396; the video overflows sideways.
    const scale = Math.max(390 / 1080, 844 / 1920);
    close(plan.guideSrc.width, guideView.width / scale);
    close(plan.guideSrc.x, (guideView.x - (390 - 1080 * scale) / 2) / scale);
    expect(plan.crop.width).toBe(ANALYSIS_WIDTH);
    // The guide sits inside the analysis image with the same proportions.
    close(plan.crop.guide.width / plan.crop.guide.height, ASPECT, 2);
    expect(plan.crop.guide.x).toBeGreaterThan(0);
    expect(plan.crop.guide.x + plan.crop.guide.width).toBeLessThan(plan.crop.width);
  });

  it("maps a landscape stream shown in a portrait view (sides cropped)", () => {
    const plan = planFrame(guideView, view, { width: 1920, height: 1080 })!;
    const scale = Math.max(390 / 1920, 844 / 1080);
    close(plan.guideSrc.width, guideView.width / scale);
    expect(plan.guideSrc.x).toBeGreaterThan(0);
    expect(plan.guideSrc.x + plan.guideSrc.width).toBeLessThan(1920);
  });

  it("waits for real sizes", () => {
    expect(planFrame(guideView, view, { width: 0, height: 0 })).toBeNull();
    expect(planFrame(guideView, { width: 0, height: 0 }, { width: 1080, height: 1920 })).toBeNull();
    expect(planFrame({ x: 0, y: 0, width: 0, height: 0 }, view, { width: 1080, height: 1920 })).toBeNull();
  });
});

describe("planStill", () => {
  it("cuts the guide plus 4% in whole pixels and keeps enough detail", () => {
    const guideSrc = { x: 60, y: 700, width: 960, height: 605 };
    const plan = planStill(guideSrc, { width: 1080, height: 1920 });
    expect(Number.isInteger(plan.source.x) && Number.isInteger(plan.source.width)).toBe(true);
    close(plan.source.width, 960 * 1.04, -1);
    expect(plan.size.width).toBe(plan.source.width); // under 1600: not resized
    expect(plan.lowResolution).toBe(false);
  });

  it("downsizes a large crop to the 1600 px long side", () => {
    const plan = planStill({ x: 100, y: 100, width: 1800, height: 1134 }, { width: 3840, height: 2160 });
    expect(Math.max(plan.size.width, plan.size.height)).toBe(CAPTURE_LIMITS.maxLongSide);
  });

  it("clamps at the frame edge and flags a crop too small for the server", () => {
    const plan = planStill({ x: -20, y: 10, width: 500, height: 315 }, { width: 640, height: 480 });
    expect(plan.source.x).toBe(0);
    expect(plan.lowResolution).toBe(true);
  });
});

describe("still size on real layouts (server minimum: 800 px long side)", () => {
  // Free area for the guide, as rider.css lays out the camera screen. Portrait: top bar 60 px, hint
  // 121 px, shutter row 112 px. Landscape (height up to 560 px): top bar 52 px; the hint and the
  // shutter sit in a 200 px column on the right, so the guide gets the full height below the bar.
  const stillLongSide = (view: { width: number; height: number }, area: { x: number; y: number; width: number; height: number }, video: { width: number; height: number }) => {
    const plan = planFrame(guideInArea(area, ASPECT), view, video)!;
    const still = planStill(plan.guideSrc, video);
    return { long: Math.max(still.size.width, still.size.height), low: still.lowResolution };
  };

  it("portrait browser viewport with the 1080p stream phones deliver upright", () => {
    const view = { width: 360, height: 672 };
    const r = stillLongSide(view, { x: 0, y: 181, width: 360, height: 379 }, { width: 1080, height: 1920 });
    expect(r.low).toBe(false);
    expect(r.long).toBeGreaterThanOrEqual(CAPTURE_LIMITS.minLongSide);
  });

  it("landscape (phone sideways, browser bar showing) with a 1080p stream", () => {
    const view = { width: 867, height: 332 };
    const r = stillLongSide(view, { x: 0, y: 52, width: 667, height: 280 }, { width: 1920, height: 1080 });
    expect(r.low).toBe(false);
    expect(r.long).toBeGreaterThanOrEqual(CAPTURE_LIMITS.minLongSide);
  });

  it("flags a 720p stream, which can never reach the minimum (the screen then says so)", () => {
    const r = stillLongSide({ width: 360, height: 672 }, { x: 0, y: 181, width: 360, height: 379 }, { width: 720, height: 1280 });
    expect(r.low).toBe(true);
  });
});

describe("guideInStillCopy", () => {
  it("places the guide in a downscaled copy of the still, even when clamped", () => {
    const guideSrc = { x: 10, y: 40, width: 600, height: 378 };
    const still = { x: 0, y: 32, width: 622, height: 393 };
    const g = guideInStillCopy(guideSrc, still, { width: 311, height: 196.5 });
    close(g.x, 5);
    close(g.y, 4);
    close(g.width, 300);
  });
});

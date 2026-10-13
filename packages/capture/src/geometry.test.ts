import { describe, expect, it } from "vitest";
import {
  ANALYSIS_WIDTH,
  analysisCrop,
  analysisRectToSource,
  clampRect,
  expandRect,
  guideInStill,
  guideRect,
  intersectRect,
  mapSourceRectToView,
  mapViewRectToSource,
  scaleRect,
} from "./geometry";
import type { Rect } from "./types";

const ID1 = 85.6 / 53.98;

function expectRect(actual: Rect, expected: Rect, digits = 6) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.width).toBeCloseTo(expected.width, digits);
  expect(actual.height).toBeCloseTo(expected.height, digits);
}

describe("guideRect", () => {
  it("fills 90% of a portrait screen's width, centred", () => {
    const g = guideRect(360, 640, ID1);
    expect(g.width).toBeCloseTo(324);
    expect(g.width / g.height).toBeCloseTo(ID1);
    expect(g.x).toBeCloseTo(18);
    expect(g.y + g.height / 2).toBeCloseTo(320);
  });

  it("is limited by 60% of the height on a landscape screen", () => {
    const g = guideRect(800, 360, ID1);
    expect(g.height).toBeCloseTo(216);
    expect(g.width).toBeCloseTo(216 * ID1);
    expect(g.x + g.width / 2).toBeCloseTo(400);
  });

  it("accepts custom fractions", () => {
    const g = guideRect(1000, 1000, 2, 0.5, 0.5);
    expectRect(g, { x: 250, y: 375, width: 500, height: 250 });
  });
});

describe("mapViewRectToSource (object-fit: cover)", () => {
  it("portrait video in a portrait view: uniform scale, nothing cropped", () => {
    const g = guideRect(360, 640, ID1);
    const src = mapViewRectToSource(g, 360, 640, 1080, 1920);
    expectRect(src, scaleRect(g, 3));
  });

  it("landscape video in a portrait view: the sides are cropped", () => {
    // Scale = 640 / 1080; the video is drawn 1137.8 px wide, centred, so 388.9 px hang off each side.
    const view = { x: 18, y: 217.8, width: 324, height: 204.3 };
    const src = mapViewRectToSource(view, 360, 640, 1920, 1080);
    const scale = 640 / 1080;
    const offsetX = (360 - 1920 * scale) / 2;
    expectRect(src, { x: (18 - offsetX) / scale, y: 217.8 / scale, width: 324 / scale, height: 204.3 / scale });
    expect(src.x).toBeGreaterThan(600); // well inside the frame, not at its left edge
  });

  it("landscape video in a landscape view: top and bottom are cropped", () => {
    const src = mapViewRectToSource({ x: 0, y: 0, width: 800, height: 360 }, 800, 360, 1280, 720);
    // Scale 0.625: the video is drawn 450 px tall, 45 px hidden above and below.
    expectRect(src, { x: 0, y: 72, width: 1280, height: 576 });
  });

  it("round-trips with mapSourceRectToView", () => {
    const r = { x: 12.5, y: 40, width: 200, height: 120 };
    for (const [vw, vh, sw, sh] of [
      [360, 640, 1920, 1080],
      [360, 640, 1080, 1920],
      [800, 360, 640, 480],
    ]) {
      expectRect(mapSourceRectToView(mapViewRectToSource(r, vw, vh, sw, sh), vw, vh, sw, sh), r);
    }
  });
});

describe("rect helpers", () => {
  it("expandRect grows around the centre and can shrink", () => {
    expectRect(expandRect({ x: 10, y: 10, width: 100, height: 50 }, 0.2), { x: 0, y: 5, width: 120, height: 60 });
    expectRect(expandRect({ x: 0, y: 0, width: 100, height: 100 }, -0.5), { x: 25, y: 25, width: 50, height: 50 });
    expect(expandRect({ x: 0, y: 0, width: 10, height: 10 }, -2).width).toBe(0);
  });

  it("clampRect keeps the part inside the image", () => {
    expectRect(clampRect({ x: -10, y: 5, width: 50, height: 100 }, 30, 60), { x: 0, y: 5, width: 30, height: 55 });
    const outside = clampRect({ x: 100, y: 100, width: 10, height: 10 }, 50, 50);
    expect(outside.width * outside.height).toBe(0);
  });

  it("scaleRect scales position and size", () => {
    expectRect(scaleRect({ x: 1, y: 2, width: 3, height: 4 }, 2, 0.5), { x: 2, y: 1, width: 6, height: 2 });
    expectRect(scaleRect({ x: 1, y: 2, width: 3, height: 4 }, 3), { x: 3, y: 6, width: 9, height: 12 });
  });

  it("intersectRect returns the overlap", () => {
    expectRect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 8, width: 10, height: 10 }), {
      x: 5,
      y: 8,
      width: 5,
      height: 2,
    });
  });
});

describe("analysisCrop", () => {
  it("cuts the guide plus 20% and scales it to 480 px wide", () => {
    const guideSrc = { x: 600, y: 400, width: 800, height: 800 / ID1 };
    const crop = analysisCrop(guideSrc, 1920, 1080);
    expect(crop.width).toBe(ANALYSIS_WIDTH);
    expect(crop.source.width).toBe(960);
    expect(crop.guide.width).toBeCloseTo(400, 0);
    expect(crop.guide.x).toBeCloseTo(40, 0);
    expect(crop.height).toBe(Math.round((crop.source.height * 480) / 960));
    // The guide maps back to where it came from.
    expectRect(analysisRectToSource(crop.guide, crop), guideSrc, 3);
  });

  it("stays inside the frame when the guide is near its edge", () => {
    const crop = analysisCrop({ x: 5, y: 5, width: 600, height: 380 }, 640, 480);
    expect(crop.source.x).toBe(0);
    expect(crop.source.y).toBe(0);
    expect(crop.source.x + crop.source.width).toBeLessThanOrEqual(640);
    expect(crop.source.y + crop.source.height).toBeLessThanOrEqual(480);
  });
});

describe("guideInStill", () => {
  it("undoes the 4% still margin", () => {
    const g = guideInStill(1040, 656);
    expect(g.width).toBeCloseTo(1000);
    expect(g.height).toBeCloseTo(656 / 1.04);
    expect(g.x).toBeCloseTo(20);
  });
});

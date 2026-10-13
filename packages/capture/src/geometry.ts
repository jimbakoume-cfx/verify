// Rectangle helpers shared by the camera screen (view/CSS pixels), the video frame
// (source pixels) and the analysis image. All functions are pure and return new objects.
import type { Rect } from "./types";

/** Width of the grayscale image the analysis loop works on. */
export const ANALYSIS_WIDTH = 480;

/**
 * How much bigger than the guide the analysis crop is (0.2 = 20% wider and taller).
 * Must exceed the 15% detection search margin so a card slightly larger than the guide
 * still has its edges inside the image, away from the 1-pixel border the filters skip.
 */
export const ANALYSIS_CROP_EXPANSION = 0.2;

/** Margin added around the guide when cutting the final still (spec: 4%). */
export const STILL_CROP_EXPANSION = 0.04;

/** Area of `r`; 0 when it is empty. */
export function rectArea(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/** Centre point of `r`. */
export function rectCenter(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Overlap of two rectangles; a zero-size rectangle when they do not overlap. */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return { x: x0, y: y0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Moves `rect` by (dx, dy). */
export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

/**
 * Grows `rect` around its centre: the width and height each become `(1 + fraction)` times larger
 * (so every side moves out by `fraction / 2` of that dimension). A negative fraction shrinks it.
 */
export function expandRect(rect: Rect, fraction: number): Rect {
  const dx = (rect.width * fraction) / 2;
  const dy = (rect.height * fraction) / 2;
  return {
    x: rect.x - dx,
    y: rect.y - dy,
    width: Math.max(0, rect.width + 2 * dx),
    height: Math.max(0, rect.height + 2 * dy),
  };
}

/** Restricts `rect` to the area [0, w] x [0, h]. The result can have zero size. */
export function clampRect(rect: Rect, w: number, h: number): Rect {
  return intersectRect(rect, { x: 0, y: 0, width: w, height: h });
}

/** Multiplies position and size by (sx, sy); `sy` defaults to `sx`. */
export function scaleRect(rect: Rect, sx: number, sy: number = sx): Rect {
  return { x: rect.x * sx, y: rect.y * sy, width: rect.width * sx, height: rect.height * sy };
}

/**
 * The on-screen card guide: the largest rectangle of the given aspect (width / height) that fits in
 * `maxWidthFraction` of the view width and `maxHeightFraction` of its height, centred.
 * Values are in the same units as the view (CSS pixels) and may be fractional.
 */
export function guideRect(
  viewW: number,
  viewH: number,
  aspect: number,
  maxWidthFraction = 0.9,
  maxHeightFraction = 0.6,
): Rect {
  const width = Math.min(viewW * maxWidthFraction, viewH * maxHeightFraction * aspect);
  const height = width / aspect;
  return { x: (viewW - width) / 2, y: (viewH - height) / 2, width, height };
}

// object-fit: cover scales the video uniformly until it covers the element, centred
// (object-position 50% 50%), so the parts that overflow are cropped equally on both sides.
function coverTransform(viewW: number, viewH: number, srcW: number, srcH: number) {
  const scale = Math.max(viewW / srcW, viewH / srcH);
  return { scale, offsetX: (viewW - srcW * scale) / 2, offsetY: (viewH - srcH * scale) / 2 };
}

/**
 * Maps a rectangle in the `<video>` element's box (CSS pixels, `object-fit: cover`) to the
 * video's own pixels (`videoWidth` x `videoHeight`). The result is not clamped.
 */
export function mapViewRectToSource(
  rect: Rect,
  viewW: number,
  viewH: number,
  srcW: number,
  srcH: number,
): Rect {
  const { scale, offsetX, offsetY } = coverTransform(viewW, viewH, srcW, srcH);
  return {
    x: (rect.x - offsetX) / scale,
    y: (rect.y - offsetY) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };
}

/** Inverse of {@link mapViewRectToSource}: video pixels to the element's CSS pixels. */
export function mapSourceRectToView(
  rect: Rect,
  viewW: number,
  viewH: number,
  srcW: number,
  srcH: number,
): Rect {
  const { scale, offsetX, offsetY } = coverTransform(viewW, viewH, srcW, srcH);
  return {
    x: rect.x * scale + offsetX,
    y: rect.y * scale + offsetY,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** Where to cut the analysis image from a video frame, and where the guide falls inside it. */
export interface AnalysisCrop {
  /** Region of the video frame to draw, in whole source pixels. */
  source: Rect;
  /** Size of the analysis image (draw `source` scaled into a canvas of this size). */
  width: number;
  height: number;
  /** The guide in analysis-image pixels: pass it to `analyzeFrame`. */
  guide: Rect;
  /** Analysis pixels per source pixel, horizontally and vertically (nearly equal). */
  scaleX: number;
  scaleY: number;
}

/**
 * Plans the analysis crop: the guide (already in video pixels, see {@link mapViewRectToSource})
 * expanded by `expand`, clamped to the frame, rounded to whole pixels and scaled to `width`.
 *
 * @example
 * const guideSrc = mapViewRectToSource(guideRect(vw, vh, aspect), vw, vh, video.videoWidth, video.videoHeight);
 * const crop = analysisCrop(guideSrc, video.videoWidth, video.videoHeight);
 * ctx.drawImage(video, crop.source.x, crop.source.y, crop.source.width, crop.source.height, 0, 0, crop.width, crop.height);
 * // worker: analyzeFrame(toGray(imageData.data, crop.width, crop.height), crop.guide, prev)
 */
export function analysisCrop(
  guideInSource: Rect,
  srcW: number,
  srcH: number,
  width: number = ANALYSIS_WIDTH,
  expand: number = ANALYSIS_CROP_EXPANSION,
): AnalysisCrop {
  const area = clampRect(expandRect(guideInSource, expand), srcW, srcH);
  const x0 = Math.max(0, Math.floor(area.x));
  const y0 = Math.max(0, Math.floor(area.y));
  const x1 = Math.min(srcW, Math.ceil(area.x + area.width));
  const y1 = Math.min(srcH, Math.ceil(area.y + area.height));
  const source = { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  const outW = Math.max(1, Math.round(width));
  const outH = Math.max(1, Math.round((source.height * outW) / source.width));
  const scaleX = outW / source.width;
  const scaleY = outH / source.height;
  return {
    source,
    width: outW,
    height: outH,
    guide: scaleRect(translateRect(guideInSource, -x0, -y0), scaleX, scaleY),
    scaleX,
    scaleY,
  };
}

/** Maps a rectangle from analysis-image pixels (e.g. a detected box) back to video pixels. */
export function analysisRectToSource(rect: Rect, crop: AnalysisCrop): Rect {
  return translateRect(scaleRect(rect, 1 / crop.scaleX, 1 / crop.scaleY), crop.source.x, crop.source.y);
}

/**
 * Where the guide sits inside a still cut as the guide grown by `expansion` (see
 * {@link STILL_CROP_EXPANSION}) and drawn at `width` x `height`. Use it to re-run `analyzeFrame`
 * on a downscaled copy of the still. Assumes the still crop was not clamped by the frame edge.
 */
export function guideInStill(width: number, height: number, expansion: number = STILL_CROP_EXPANSION): Rect {
  return expandRect({ x: 0, y: 0, width, height }, 1 / (1 + expansion) - 1);
}

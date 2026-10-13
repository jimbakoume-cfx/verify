// Where the guide is on screen, and which video pixels it covers.
//
// Everything on screen is in CSS pixels (getBoundingClientRect, the SVG overlay), and the video is
// mapped through its intrinsic size (videoWidth x videoHeight) with the object-fit: cover rule.
// devicePixelRatio therefore never enters the mapping: the overlay is vector (SVG), and the crops
// are cut from the camera's own pixels, not from the screen. Orientation is read from the stream
// on every frame: phones deliver portrait streams (e.g. 1080x1920) when held upright, and the
// size changes when the phone is turned.
import { CAPTURE_LIMITS } from "@verify/shared";
import {
  STILL_CROP_EXPANSION,
  type AnalysisCrop,
  type OutputSize,
  type Rect,
  analysisCrop,
  clampRect,
  expandRect,
  guideRect,
  mapViewRectToSource,
  outputSize,
  scaleRect,
  translateRect,
} from "@verify/capture";

export interface Size {
  width: number;
  height: number;
}

/** The guide drawn on screen: the largest card-shaped box filling most of the free `area`. */
export function guideInArea(area: Rect, aspect: number): Rect {
  return translateRect(guideRect(area.width, area.height, aspect, 0.92, 0.92), area.x, area.y);
}

export interface FramePlan {
  /** The guide in video pixels. */
  guideSrc: Rect;
  /** What to draw into the 480 px analysis image, and where the guide falls in it. */
  crop: AnalysisCrop;
}

/** Plans one analysis frame; null until the video and the layout have a size. */
export function planFrame(guideView: Rect, view: Size, video: Size): FramePlan | null {
  if (!(view.width > 0 && view.height > 0 && video.width > 0 && video.height > 0)) return null;
  if (!(guideView.width > 0 && guideView.height > 0)) return null;
  const guideSrc = mapViewRectToSource(guideView, view.width, view.height, video.width, video.height);
  return { guideSrc, crop: analysisCrop(guideSrc, video.width, video.height) };
}

export interface StillPlan {
  /** Whole video pixels to cut: the guide grown by 4%, clamped to the frame. */
  source: Rect;
  /** Pixel size of the uploaded JPEG (long side at most 1600, never enlarged). */
  size: OutputSize;
  /** The long side is under the server's minimum: the photo would be refused. */
  lowResolution: boolean;
}

export function planStill(guideSrc: Rect, video: Size): StillPlan {
  const area = clampRect(expandRect(guideSrc, STILL_CROP_EXPANSION), video.width, video.height);
  const x = Math.max(0, Math.floor(area.x));
  const y = Math.max(0, Math.floor(area.y));
  const source = {
    x,
    y,
    width: Math.max(1, Math.min(video.width, Math.ceil(area.x + area.width)) - x),
    height: Math.max(1, Math.min(video.height, Math.ceil(area.y + area.height)) - y),
  };
  const size = outputSize(source.width, source.height);
  return { source, size, lowResolution: Math.max(size.width, size.height) < CAPTURE_LIMITS.minLongSide };
}

/**
 * The guide inside a copy of the still drawn at `copy` size. Exact even when the still was clamped
 * at the frame edge (unlike assuming a centred 4% margin).
 */
export function guideInStillCopy(guideSrc: Rect, still: Rect, copy: Size): Rect {
  return scaleRect(translateRect(guideSrc, -still.x, -still.y), copy.width / still.width, copy.height / still.height);
}

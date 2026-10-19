// The face check's pictures: the oval on screen, a small grayscale sample for the presence hint, and
// the frames themselves (the whole camera picture, scaled, re-encoded from a canvas: no EXIF or GPS).
import {
  type GrayImage,
  type Rect,
  type SelfieAnalysis,
  analyzeSelfie,
  compressToTarget,
  mapViewRectToSource,
  scaleRect,
  toGray,
} from "@verify/capture";
import type { Size } from "../capture/geometry";

/**
 * The oval guide in stage (= video element) CSS pixels: a face-shaped ellipse box (3:4), centred
 * horizontally, a little above the middle, as wide as the screen allows under the prompts.
 */
export function ovalRect(stage: Size): Rect {
  const width = Math.min(stage.width * 0.72, stage.height * 0.42);
  const height = width * (4 / 3);
  return { x: (stage.width - width) / 2, y: stage.height * 0.46 - height / 2, width, height };
}

/** Width of the presence sample: plenty for brightness and contrast, cheap on any phone. */
export const SAMPLE_WIDTH = 96;

function canvas2d(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d unavailable");
  return [canvas, ctx];
}

/** A reusable sampler: the video scaled to SAMPLE_WIDTH, checked inside the oval (analyzeSelfie). */
export function createPresenceSampler(): { sample(video: HTMLVideoElement, stage: Size): SelfieAnalysis | null; dispose(): void } {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let gray: Uint8Array | undefined;
  return {
    sample(video, stage) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return null;
      const w = SAMPLE_WIDTH;
      const h = Math.max(1, Math.round((vh * w) / vw));
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        [canvas, ctx] = canvas2d(w, h);
        gray = undefined;
      }
      ctx!.drawImage(video, 0, 0, w, h);
      const { data } = ctx!.getImageData(0, 0, w, h);
      const image: GrayImage = toGray(data, w, h, gray);
      gray = image.data as Uint8Array;
      // The oval is centred, so the mirrored preview and the picture agree on where it is.
      const oval = scaleRect(mapViewRectToSource(ovalRect(stage), stage.width, stage.height, vw, vh), w / vw, h / vh);
      return analyzeSelfie(image, oval);
    },
    dispose() {
      if (canvas) canvas.width = canvas.height = 1;
      canvas = null;
      ctx = null;
    },
  };
}

/** The current video picture, scaled so its long side is `longSide` (never enlarged). Synchronous. */
export function grabFrame(video: HTMLVideoElement, longSide: number): HTMLCanvasElement {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, longSide / Math.max(vw, vh));
  const [canvas, ctx] = canvas2d(Math.max(1, Math.round(vw * scale)), Math.max(1, Math.round(vh * scale)));
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("JPEG encoding failed"))), "image/jpeg", quality),
  );
}

/** JPEG qualities and scales tried, in order, until a frame fits its byte target. */
export const FRAME_QUALITIES = [0.8, 0.7, 0.6, 0.5] as const;
export const FRAME_SCALES = [1, 0.75] as const;

/** Encodes a grabbed frame under `target` bytes, then frees its pixels. */
export async function encodeFrame(canvas: HTMLCanvasElement, target: number): Promise<Blob> {
  let smaller: HTMLCanvasElement | null = null;
  const at = (scale: number) => {
    if (scale === 1) return canvas;
    if (!smaller) {
      [smaller] = canvas2d(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
      smaller.getContext("2d")!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    }
    return smaller;
  };
  try {
    const result = await compressToTarget((q, s) => toJpeg(at(s), q), target, {
      qualities: FRAME_QUALITIES,
      scales: FRAME_SCALES,
    });
    return result.blob;
  } finally {
    canvas.width = canvas.height = 1;
    if (smaller) (smaller as HTMLCanvasElement).width = (smaller as HTMLCanvasElement).height = 1;
  }
}

/** SHA-256 of a blob's bytes, as lower-case hex (what the server compares with its own). */
export async function sha256OfBlob(blob: Blob): Promise<string> {
  const bytes = typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : await new Response(blob).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Copies the guide region of the live video into a small RGBA image for the analysis loop.
import type { AnalysisCrop } from "@verify/capture";

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameGrabber {
  /** Draws `crop.source` of the current video frame at `crop.width` x `crop.height`; null if the canvas fails. */
  grab(video: HTMLVideoElement, crop: AnalysisCrop): ImageData | null;
  dispose(): void;
}

export function createFrameGrabber(): FrameGrabber {
  // OffscreenCanvas when available (no DOM node, cheaper), else a detached <canvas>.
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
  // willReadFrequently keeps the canvas in CPU memory: getImageData every frame is then cheap.
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false }) as Context2D | null;

  return {
    grab(video, crop) {
      if (!ctx) return null;
      if (canvas.width !== crop.width || canvas.height !== crop.height) {
        canvas.width = crop.width;
        canvas.height = crop.height;
      }
      const { x, y, width, height } = crop.source;
      ctx.drawImage(video, x, y, width, height, 0, 0, crop.width, crop.height);
      return ctx.getImageData(0, 0, crop.width, crop.height);
    },
    dispose() {
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}

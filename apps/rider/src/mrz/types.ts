// The MRZ ("code lines") reader as the rider flow sees it. The pipeline (locate the band, prepare
// it, OCR with tesseract.js, correct look-alike characters, parse) lives in reader.ts and
// ocrEngine.ts; the flow only depends on this interface.
import type { GrayImage } from "@verify/capture";
import type { MrzExpectation, MrzFormat, ParsedMrz } from "@verify/shared";

/**
 * Self-hosted OCR files. The engine files are emitted from node_modules by the Vite plugin in
 * vite.config.ts; the model is committed under public/ocr/mrz-1. Paths are versioned, so they can be
 * cached forever; change the folder (and `cachePath`) whenever a file changes.
 */
export const OCR_ASSETS = {
  workerPath: "/ocr/7.0.0/worker.min.js",
  /** Folder: tesseract.js picks the *-lstm.wasm.js variant the browser supports. */
  corePath: "/ocr/7.0.0",
  langPath: "/ocr/mrz-1",
  language: "mrz",
  /** IndexedDB key prefix for the cached model: a new model needs a new prefix. */
  cachePath: "ocr-mrz-1",
  /** Sent to the server with each report (MrzReadReport.engine). */
  engine: "tesseract.js-7.0.0/mrz-1",
} as const;

/**
 * valid: a complete MRZ of the expected format with every check digit right.
 * invalid: a complete MRZ of the expected format, but some check digit is wrong.
 * not_found: no complete MRZ of the expected format.
 * unavailable: the reader could not run (no WebAssembly, files failed to load, timeout). Never
 *   blocks the rider.
 */
export type MrzReadStatus = "valid" | "invalid" | "not_found" | "unavailable";

export interface MrzReadResult {
  status: MrzReadStatus;
  format: MrzFormat;
  /** Corrected lines when status is valid or invalid; null otherwise. */
  lines: string[] | null;
  /** parseMrz(lines) when lines is set. */
  parsed: ParsedMrz | null;
  /** Characters changed by the look-alike correction. */
  corrections: number;
  /** Wall time of the read, in milliseconds (excluding the first download). */
  ms: number;
  /** Raw OCR text, for the debug panel only. Never uploaded or logged. */
  rawText: string;
  /** Estimated MRZ character height in the still, in pixels (calibration); null when not found. */
  charHeight: number | null;
  /** True when the MRZ was only found after turning the image 180 degrees. */
  rotated: boolean;
}

export interface MrzReadOptions {
  signal?: AbortSignal;
  /** First use only: download and start-up progress, 0..1. */
  onProgress?: (progress: number) => void;
}

export interface MrzReader {
  /** Starts downloading and starting the OCR engine in the background. Safe to call repeatedly. */
  warmUp(): void;
  /**
   * Reads the MRZ from a full-resolution grayscale copy of the still. Never rejects: failures come
   * back as status "unavailable" (or "not_found"). An aborted read resolves as "unavailable" and
   * restarts the engine, so a stale job cannot delay the next read.
   */
  read(image: GrayImage, expectation: MrzExpectation, options?: MrzReadOptions): Promise<MrzReadResult>;
  /** Stops the engine and frees its memory. */
  dispose(): void;
}

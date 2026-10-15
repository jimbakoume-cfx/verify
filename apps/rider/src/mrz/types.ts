// The MRZ ("code lines") reader as the rider flow sees it. The pipeline (locate the band, prepare
// it, OCR with tesseract.js, correct look-alike characters, parse) lives in reader.ts and
// ocrEngine.ts; the flow only depends on this interface.
import type { GrayImage } from "@verify/capture";
import type { MrzExpectation, MrzFormat, ParsedMrz } from "@verify/shared";

/** A reading model: a `<language>.traineddata.gz` in its own versioned folder. */
export interface MrzModel {
  /** Folder of the model, served under /ocr/. */
  langPath: string;
  /** IndexedDB key prefix for the cached model: a new model needs a new prefix. */
  cachePath: string;
  /** Sent to the server with each report (MrzReadReport.engine) and shown in the debug panel. */
  engine: string;
}

/**
 * The reading models. mrz-1: DoubangoTelecom's (BSD-3-Clause; trained by its authors on images from
 * the web), for every session. mrz-2: our own (M3 training, run 2, fine-tuned from Google's eng),
 * which passed the automated gates; for test sessions only until the PM's own photos (G4) pass.
 */
export const MRZ_MODELS = {
  "mrz-1": { langPath: "/ocr/mrz-1", cachePath: "ocr-mrz-1", engine: "tesseract.js-7.0.0/mrz-1" },
  "mrz-2": { langPath: "/ocr/mrz-2", cachePath: "ocr-mrz-2", engine: "tesseract.js-7.0.0/mrz-2" },
} as const satisfies Record<string, MrzModel>;

/** Test sessions read with our own model (PM, 2026-10-15); every other session with Doubango's. */
export function mrzModelFor(isTest: boolean): MrzModel {
  return MRZ_MODELS[isTest ? "mrz-2" : "mrz-1"];
}

/**
 * Self-hosted OCR files. The engine files are emitted from node_modules by the Vite plugin in
 * vite.config.ts; the models are committed under public/ocr/mrz-<n>. Paths are versioned, so they can
 * be cached forever; change the folder (and `cachePath`) whenever a file changes. The model fields
 * here are the default model's (real sessions).
 */
export const OCR_ASSETS = {
  workerPath: "/ocr/7.0.0/worker.min.js",
  /** Folder: tesseract.js picks the *-lstm.wasm.js variant the browser supports. */
  corePath: "/ocr/7.0.0",
  language: "mrz",
  ...MRZ_MODELS["mrz-1"],
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
  /** The engine and model that read (MrzModel.engine): reported to the server, shown in debug mode. */
  engine: string;
}

export interface MrzReadOptions {
  signal?: AbortSignal;
  /**
   * Start-up progress, 0..1, while the engine's first start-up on the page runs (it downloads the
   * files the first time; partly estimated, see ocrEngine.ts). Never called once it has started.
   */
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

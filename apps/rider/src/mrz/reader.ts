// Reads the MRZ ("code lines") from the full-resolution grayscale still:
//   locate the band -> prepare it -> OCR -> correct look-alikes -> parse and check.
// Up to three OCR passes: the band as located; if no code lines came out, the still turned 180
// degrees (a card held upside down); if the best result still is not valid, the same band with
// the other binarisation (one global threshold instead of a local one). A pass only counts when
// its own check digits say so, so extra passes cannot make wrong lines look valid. The two
// readings of the same band also serve as evidence for each other's document-number repair
// (see correct.ts).
import {
  type GrayImage,
  type MrzBand,
  type MrzBinarization,
  encodePgm,
  locateMrzBand,
  prepareForOcr,
  rotateGray180,
} from "@verify/capture";
import { type MrzExpectation, parseMrz } from "@verify/shared";
import { correctMrz } from "./correct";
import { type OcrEngine, createOcrEngine } from "./ocrEngine";
import type { MrzReadOptions, MrzReadResult, MrzReadStatus, MrzReader } from "./types";

export interface MrzReaderDeps {
  /** Default: the tesseract.js engine with the self-hosted files (OCR_ASSETS). */
  engine?: OcrEngine;
  /** Clock for `ms`. */
  now?: () => number;
  /** Decides the century of two-digit years. */
  today?: () => Date;
}

interface Pass {
  status: MrzReadStatus;
  lines: string[] | null;
  corrections: number;
  rawText: string;
  charHeight: number | null;
  rotated: boolean;
  image: GrayImage;
  band: MrzBand;
}

const RANK: Record<MrzReadStatus, number> = { valid: 3, invalid: 2, not_found: 1, unavailable: 0 };

export function createMrzReader(deps: MrzReaderDeps = {}): MrzReader {
  const engine = deps.engine ?? createOcrEngine();
  const now = deps.now ?? (() => performance.now());
  const today = deps.today ?? (() => new Date());

  async function read(image: GrayImage, expectation: MrzExpectation, options: MrzReadOptions = {}): Promise<MrzReadResult> {
    const { format } = expectation;
    const { signal } = options;
    const result = (pass: Pass | null, status: MrzReadStatus, ms: number): MrzReadResult => {
      const lines = pass && (status === "valid" || status === "invalid") ? pass.lines : null;
      return {
        status,
        format,
        lines,
        parsed: lines ? parseMrz(lines, today()) : null,
        corrections: lines && pass ? pass.corrections : 0,
        ms: Math.round(ms),
        rawText: pass?.rawText ?? "",
        charHeight: pass?.charHeight ?? null,
        rotated: pass?.rotated ?? false,
      };
    };

    try {
      await engine.ready({ signal, onProgress: options.onProgress });
    } catch {
      return result(null, "unavailable", 0);
    }

    const started = now();
    const evaluate = (rawText: string, otherReadings: string[], img: GrayImage, band: MrzBand, rotated: boolean): Pass => {
      const corrected = correctMrz(rawText, format, otherReadings);
      const parsed = corrected.lines ? parseMrz(corrected.lines, today()) : null;
      return {
        status: parsed ? (parsed.valid ? "valid" : "invalid") : "not_found",
        lines: corrected.lines,
        corrections: corrected.corrections,
        rawText,
        charHeight: band.fallback ? null : band.charHeight,
        rotated,
        image: img,
        band,
      };
    };
    const attempt = async (img: GrayImage, band: MrzBand, binarization: MrzBinarization, rotated: boolean): Promise<Pass> => {
      // Let the "Reading..." screen paint between the heavier steps.
      await yieldToUi();
      const prepared = prepareForOcr(img, band, { binarization });
      const rawText = await engine.recognize(encodePgm(prepared), { signal });
      return evaluate(rawText, [], img, band, rotated);
    };
    const better = (a: Pass, b: Pass) => (RANK[b.status] > RANK[a.status] ? b : a);

    let best: Pass | null = null;
    try {
      await yieldToUi();
      best = await attempt(image, locateMrzBand(image, format), "local", false);
      if (best.status === "not_found") {
        await yieldToUi();
        const turned = rotateGray180(image);
        best = better(best, await attempt(turned, locateMrzBand(turned, format), "local", true));
      }
      if (best.status !== "valid") {
        const first = best;
        const second = await attempt(first.image, first.band, "otsu", first.rotated);
        best = better(first, second);
        // Each reading backs the other's document-number repair.
        if (best.status !== "valid") {
          best = better(best, evaluate(first.rawText, [second.rawText], first.image, first.band, first.rotated));
          best = better(best, evaluate(second.rawText, [first.rawText], first.image, first.band, first.rotated));
        }
      }
      return result(best, best.status, now() - started);
    } catch {
      // Cancelled, timed out, or the engine failed: never blocks the rider. A later pass that
      // fails keeps what an earlier pass read, unless the read was cancelled.
      if (best && !signal?.aborted) return result(best, best.status, now() - started);
      return result(null, "unavailable", now() - started);
    }
  }

  return {
    warmUp: () => engine.warmUp(),
    read,
    dispose: () => engine.dispose(),
  };
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

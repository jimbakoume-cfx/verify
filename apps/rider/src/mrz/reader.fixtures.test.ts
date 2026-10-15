// The whole reading pipeline with the REAL OCR engine (tesseract.js 7 and each committed model) on
// the committed fixtures (scripts/make-mrz-fixtures.py): decode the still, locate, prepare, encode
// as PGM, OCR, correct, parse. The phone runs the same path; only the worker and core files come
// from node_modules instead of /ocr/. Catches regressions in the model, the engine or the pipeline.
import { type GrayImage, decodePgm, expectedMrzCharHeight, rotateGray180 } from "@verify/capture";
import { MRZ_EXPECTATION, type MrzExpectation, type MrzFormat } from "@verify/shared";
import { afterAll, describe, expect, it } from "vitest";
import { createOcrEngine } from "./ocrEngine";
import { createMrzReader } from "./reader";
import { MRZ_MODELS, type MrzModel } from "./types";

// The rider app is typed for the browser (no Node types): Node's fs is imported by a non-literal
// name and given the one function used here.
interface NodeFs {
  readFileSync(path: URL): Uint8Array;
}
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as NodeFs;

const FIXTURES = new URL("../../../../e2e/fixtures/mrz/", import.meta.url);
const modelDir = (model: MrzModel) => decodeURIComponent(new URL(`../../public${model.langPath}`, import.meta.url).pathname);

interface Manifest {
  documents: Record<string, { format: MrzFormat; lines: string[] }>;
  stills: { file: string; document: string; format: MrzFormat; pxPerMm: number; expect: "valid" | "not_valid" }[];
}

const manifest = JSON.parse(new TextDecoder().decode(readFileSync(new URL("manifest.json", FIXTURES)))) as Manifest;
const load = (file: string): GrayImage => decodePgm(readFileSync(new URL(file, FIXTURES)));
const expectation: Record<MrzFormat, MrzExpectation> = {
  TD1: MRZ_EXPECTATION.cni_biometric as MrzExpectation,
  TD3: MRZ_EXPECTATION.passport as MrzExpectation,
};

// Doubango's model (every session) and our own (test sessions, M4): both must read every fixture.
describe.each(Object.entries(MRZ_MODELS))("reading the fixtures with the real OCR engine and %s", (_id, model) => {
  // Node: tesseract.js uses its own Node worker and the core from node_modules; the model is read
  // from the folder the site serves it from, never cached.
  const reader = createMrzReader({
    model,
    engine: createOcrEngine({
      workerPath: undefined,
      corePath: undefined,
      langPath: modelDir(model),
      cacheMethod: "none",
      isSupported: () => true,
    }),
  });

  afterAll(() => reader.dispose());

  for (const still of manifest.stills) {
    it(`${still.file}: ${still.expect === "valid" ? "reads every line exactly" : "is not read as valid"}`, { timeout: 60_000 }, async () => {
      const result = await reader.read(load(still.file), expectation[still.format]);
      if (still.expect === "valid") {
        expect(result.rawText).not.toBe("");
        expect(result.status).toBe("valid");
        expect(result.engine).toBe(model.engine);
        expect(result.lines).toEqual(manifest.documents[still.document].lines);
        expect(result.parsed?.valid).toBe(true);
        expect(result.rotated).toBe(false);
        // Measured character height within 25% of the printed 2.4 mm.
        expect(result.charHeight).not.toBeNull();
        expect(Math.abs(result.charHeight! - 2.4 * still.pxPerMm) / (2.4 * still.pxPerMm)).toBeLessThan(0.25);
      } else {
        expect(result.status).not.toBe("valid");
        expect(result.status).not.toBe("unavailable");
      }
    });
  }

  it("reads a card photographed upside down", { timeout: 60_000 }, async () => {
    const td1 = manifest.stills.find((s) => s.format === "TD1" && s.expect === "valid")!;
    const image = rotateGray180(load(td1.file));
    const result = await reader.read(image, expectation.TD1);
    expect(result).toMatchObject({ status: "valid", rotated: true, lines: manifest.documents[td1.document].lines });
    expect(result.charHeight).toBeCloseTo(expectedMrzCharHeight(image.width, "TD1"), -1);
  });
});

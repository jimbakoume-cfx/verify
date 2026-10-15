// G2/G3 document benchmark: reads fictitious document stills through the REAL rider pipeline,
// unchanged (apps/rider/src/mrz/reader.ts: locate, prepare, tesseract.js 7.0.0 with page
// segmentation 6, the look-alike correction, the parser, the extra passes), with a given model,
// and counts what the rider would have been told.
//
// The one number that matters most is "wrong but valid": every check digit passes, so the phone
// says "code lines read", yet a character differs from the truth. Only the names line has no
// check digit, and the rider's length repair can pad a dropped letter back, so such reads exist.
//
// Each worker is its own reader with its own tesseract.js worker thread, so the reads run in
// parallel; the locate and prepare steps share this process's main thread.
//
// usage: node run.mjs docbench.ts --model DIR --out FILE (--bench BENCH.json | --fixtures)
//                                  [--limit N] [--workers K] [--tag NAME]
//   --model    folder holding mrz.traineddata.gz (as the rider site serves it)
//   --bench    list written by py/bench.py; image paths are relative to its folder
//   --fixtures the repository's own MRZ fixtures (e2e/fixtures/mrz), with the same expectations as
//              apps/rider/src/mrz/reader.fixtures.test.ts, plus the card upside down
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { decodePgm, rotateGray180 } from "@verify/capture";
import { MRZ_EXPECTATION, type MrzExpectation } from "@verify/shared";
import { createOcrEngine } from "../../../apps/rider/src/mrz/ocrEngine";
import { createMrzReader } from "../../../apps/rider/src/mrz/reader";
import type { MrzReader } from "../../../apps/rider/src/mrz/types";
import { levenshtein, parseArgs, writeJson } from "./lib";

interface Item {
  file: string;
  format: "TD1" | "TD3";
  variant: string;
  lines: string[];
  /** Fixtures only: "not_valid" for a still that must NOT read as valid (a smudge). */
  expect?: "valid" | "not_valid";
  rotate180?: boolean;
}

interface Tally {
  n: number;
  validExact: number;
  validWrong: number;
  /**
   * Wrong-but-valid reads whose raw OCR text was exactly right: the look-alike correction made them
   * wrong, not the model (e.g. a real K turned into '<': K is worth 20, so no check digit sees it).
   */
  validWrongFromCorrection: number;
  invalid: number;
  notFound: number;
  unavailable: number;
  /** Stills whose names line came out exactly right. */
  nameExact: number;
  /** Lines whose first character came out wrong (the trial models' typical mistake). */
  firstCharWrong: number;
  chars: number;
  errors: number;
  ms: number;
}

const EXPECTATION: Record<Item["format"], MrzExpectation> = {
  TD1: MRZ_EXPECTATION.cni_biometric as MrzExpectation,
  TD3: MRZ_EXPECTATION.passport as MrzExpectation,
};
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
/** Fixed, so the century of two-digit years (and so the parse) never depends on the day it runs. */
const TODAY = new Date("2026-10-14T00:00:00Z");

const emptyTally = (): Tally => ({
  n: 0, validExact: 0, validWrong: 0, validWrongFromCorrection: 0, invalid: 0, notFound: 0, unavailable: 0, nameExact: 0, firstCharWrong: 0,
  chars: 0, errors: 0, ms: 0,
});

function fixtureItems(): { dir: string; items: Item[] } {
  const dir = join(REPO, "e2e/fixtures/mrz");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    documents: Record<string, { lines: string[] }>;
    stills: { file: string; document: string; format: "TD1" | "TD3"; variant: string; expect: "valid" | "not_valid" }[];
  };
  const items: Item[] = manifest.stills.map((s) => ({
    file: s.file, format: s.format, variant: s.variant, lines: manifest.documents[s.document].lines, expect: s.expect,
  }));
  const td1 = items.find((i) => i.format === "TD1" && i.expect === "valid")!;
  items.push({ ...td1, variant: "upside down", rotate180: true });
  return { dir, items };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function main(argv: string[]): Promise<void> {
  const { options } = parseArgs(argv);
  if (!options.model || !options.out || (!options.bench && !("fixtures" in options))) {
    throw new Error("usage: docbench.ts --model DIR --out FILE (--bench BENCH.json | --fixtures) [--limit N] [--workers K]");
  }
  const modelDir = resolve(options.model);
  let dir: string;
  let items: Item[];
  if ("fixtures" in options) {
    ({ dir, items } = fixtureItems());
  } else {
    dir = dirname(resolve(options.bench));
    items = JSON.parse(readFileSync(resolve(options.bench), "utf8")) as Item[];
  }
  if (options.limit) items = items.slice(0, Number(options.limit));
  const workers = Math.max(1, Number(options.workers ?? 4));

  // The rider's reader, with the files from node_modules (tesseract.js's own Node worker and core)
  // and the model from the folder given, never cached.
  const readers: MrzReader[] = Array.from({ length: workers }, () =>
    createMrzReader({
      engine: createOcrEngine({ workerPath: undefined, corePath: undefined, langPath: modelDir, cacheMethod: "none", isSupported: () => true }),
      today: () => TODAY,
    }),
  );

  const groups = new Map<string, Tally>();
  const overall = emptyTally();
  const wrongButValid: unknown[] = [];
  const fixtureFailures: unknown[] = [];
  const started = Date.now();
  let next = 0;
  let done = 0;
  await Promise.all(
    readers.map(async (reader) => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        const item = items[i];
        let image = decodePgm(readFileSync(resolve(dir, item.file)));
        if (item.rotate180) image = rotateGray180(image);
        const result = await reader.read(image, EXPECTATION[item.format]);
        const key = `${item.format}-${item.variant}`;
        if (!groups.has(key)) groups.set(key, emptyTally());
        const lines = result.lines;
        const exact = lines !== null && lines.length === item.lines.length && lines.every((l, k) => l === item.lines[k]);
        const raw = result.rawText.split("\n").map((l) => l.replace(/\s+/g, "")).filter(Boolean);
        const ocrExact = raw.length === item.lines.length && raw.every((l, k) => l === item.lines[k]);
        const nameIndex = item.format === "TD1" ? 2 : 0;
        for (const t of [groups.get(key)!, overall]) {
          t.n++;
          t.ms += result.ms;
          if (result.status === "valid") {
            if (exact) t.validExact++;
            else {
              t.validWrong++;
              if (ocrExact) t.validWrongFromCorrection++;
            }
          } else if (result.status === "invalid") t.invalid++;
          else if (result.status === "not_found") t.notFound++;
          else t.unavailable++;
          for (let k = 0; k < item.lines.length; k++) {
            const got = lines?.[k] ?? "";
            t.chars += item.lines[k].length;
            t.errors += levenshtein(got, item.lines[k]);
            if (lines && got[0] !== item.lines[k][0]) t.firstCharWrong++;
          }
          if (lines && lines[nameIndex] === item.lines[nameIndex]) t.nameExact++;
        }
        if (result.status === "valid" && !exact) {
          // Fictitious data only (rendered here), never a real document.
          wrongButValid.push({
            file: item.file, truth: item.lines, read: lines, ocr: raw, ocrExact, corrections: result.corrections, rotated: result.rotated,
          });
        }
        if (item.expect) {
          const ok = item.expect === "valid"
            ? result.status === "valid" && exact && result.rotated === Boolean(item.rotate180)
            : result.status !== "valid" && result.status !== "unavailable";
          if (!ok) fixtureFailures.push({ file: item.file, variant: item.variant, expect: item.expect, status: result.status });
        }
        done++;
        if (done % 50 === 0) console.error(`${done}/${items.length} read, ${overall.validWrong} wrong but valid`);
      }
    }),
  );
  for (const reader of readers) reader.dispose();

  const summarise = (t: Tally) => ({
    ...t,
    cer: t.chars ? +((100 * t.errors) / t.chars).toFixed(3) : 0,
    validExactRate: t.n ? +((100 * t.validExact) / t.n).toFixed(2) : 0,
    nameExactRate: t.n ? +((100 * t.nameExact) / t.n).toFixed(2) : 0,
    msPerStill: t.n ? Math.round(t.ms / t.n) : 0,
  });
  const report = {
    tag: options.tag ?? "",
    model: { dir: relative(REPO, modelDir), sha256: sha256(join(modelDir, "mrz.traineddata.gz")) },
    bench: "fixtures" in options
      ? { fixtures: "e2e/fixtures/mrz", count: items.length }
      : { file: relative(REPO, resolve(options.bench)), sha256: sha256(resolve(options.bench)), count: items.length },
    engine: "tesseract.js 7.0.0, page segmentation 6, the rider's reader (apps/rider/src/mrz/reader.ts)",
    workers,
    wallSeconds: Math.round((Date.now() - started) / 1000),
    overall: summarise(overall),
    groups: Object.fromEntries([...groups.entries()].sort().map(([k, t]) => [k, summarise(t)])),
    wrongButValid,
    ...("fixtures" in options ? { fixtureFailures } : {}),
  };
  writeJson(resolve(options.out), report);
  const o = report.overall;
  console.log(JSON.stringify({ tag: report.tag, n: o.n, validExact: o.validExact, validWrong: o.validWrong,
    validWrongFromCorrection: o.validWrongFromCorrection, invalid: o.invalid,
    notFound: o.notFound, unavailable: o.unavailable, nameExact: o.nameExact, cer: o.cer, msPerStill: o.msPerStill,
    wallSeconds: report.wallSeconds, ...("fixtures" in options ? { fixtureFailures: fixtureFailures.length } : {}) }));
  // The reader could not run (the model failed to load, or reads timed out): the numbers say
  // nothing about the model.
  if (o.unavailable > 0) {
    console.error(`${o.unavailable} reads were unavailable: check the model and the machine's load`);
    process.exitCode = 2;
  }
}

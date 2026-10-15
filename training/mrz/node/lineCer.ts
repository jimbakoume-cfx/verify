// G1 line harness: character error rate (CER) of a model on a held-out set of line images, read by
// tesseract.js 7.0.0 (the rider's engine) with the rider's settings (LSTM only, dictionaries off,
// the MRZ whitelist) except the page segmentation: 7, one line per image, since the images are
// single lines. The rider itself reads whole bands with page segmentation 6; that is G2's job.
//
// usage: node run.mjs lineCer.ts --set DIR --model DIR [--out FILE] [--workers K] [--limit N] [--dump N]
//   --set    folder of <name>.png with <name>.gt.txt (as node/cutLines.ts writes them)
//   --model  folder holding mrz.traineddata.gz
//   --dump   print up to N misread lines (truth, then what was read): fictitious data only
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { levenshtein, parseArgs, writeJson } from "./lib";

interface TesseractWorker {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(image: Uint8Array): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

const WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "../../..");

export async function main(argv: string[]): Promise<void> {
  const { options } = parseArgs(argv);
  if (!options.set || !options.model) throw new Error("usage: lineCer.ts --set DIR --model DIR [--out FILE] [--workers K]");
  const setDir = resolve(options.set);
  const modelDir = resolve(options.model);
  let files = readdirSync(setDir).filter((f) => f.endsWith(".png")).sort();
  if (options.limit) files = files.slice(0, Number(options.limit));
  const workers = Math.max(1, Number(options.workers ?? 4));

  const mod = (await import("tesseract.js")) as unknown as {
    createWorker?: (...args: unknown[]) => Promise<TesseractWorker>;
    default?: { createWorker: (...args: unknown[]) => Promise<TesseractWorker> };
  };
  const createWorker = mod.createWorker ?? mod.default!.createWorker;
  const pool = await Promise.all(
    Array.from({ length: workers }, async () => {
      const w = await createWorker("mrz", 1, { langPath: modelDir, gzip: true, cacheMethod: "none" },
        { load_system_dawg: "0", load_freq_dawg: "0" });
      await w.setParameters({ tessedit_char_whitelist: WHITELIST, tessedit_pageseg_mode: "7" });
      return w;
    }),
  );

  let chars = 0;
  let errors = 0;
  let exact = 0;
  let firstWrong = 0;
  let dumped = 0;
  let next = 0;
  const started = Date.now();
  await Promise.all(
    pool.map(async (w) => {
      for (;;) {
        const i = next++;
        if (i >= files.length) return;
        const truth = readFileSync(join(setDir, files[i].replace(/\.png$/, ".gt.txt")), "utf8").trim();
        const { data } = await w.recognize(readFileSync(join(setDir, files[i])));
        const read = data.text.replace(/\s+/g, "");
        const e = levenshtein(read, truth);
        chars += truth.length;
        errors += e;
        if (e === 0) exact++;
        if (read[0] !== truth[0]) firstWrong++;
        if (e > 0 && dumped < Number(options.dump ?? 0)) {
          dumped++;
          console.error(`${files[i]}\n  truth ${truth}\n  read  ${read}`);
        }
      }
    }),
  );
  await Promise.all(pool.map((w) => w.terminate()));
  const report = {
    set: basename(setDir),
    model: relative(REPO, modelDir),
    engine: "tesseract.js 7.0.0, page segmentation 7",
    lines: files.length,
    cer: files.length ? +((100 * errors) / chars).toFixed(3) : 0,
    lineExact: files.length ? +((100 * exact) / files.length).toFixed(2) : 0,
    firstCharWrong: files.length ? +((100 * firstWrong) / files.length).toFixed(2) : 0,
    msPerLine: files.length ? Math.round(((Date.now() - started) * workers) / files.length) : 0,
  };
  if (options.out) writeJson(resolve(options.out), report);
  console.log(JSON.stringify(report));
}

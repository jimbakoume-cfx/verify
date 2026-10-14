# Our own MRZ model: training pipeline (M3)

The rider's phone reads the code lines (MRZ) with tesseract.js and a model trained by DoubangoTelecom
(`apps/rider/public/ocr/mrz-1`). That model is BSD-3-Clause, but its authors trained it on MRZ images
collected from the web, which may include real people's documents. This folder trains our own model
**only on fictitious documents we draw ourselves**, and decides with automated gates whether it may
replace Doubango's.

Route A of the M3 research: Tesseract's own LSTM training (tesstrain), the same engine the phone
already runs, so a new model is just a new file under a new path (`/ocr/mrz-2/`). Run 1 trains **from
zero** (cleanest provenance). Only if it fails the gates, run 2 **fine-tunes Google's `eng` model**
(Apache-2.0; see Licences). Doubango stays until one model passes; M3 is complete even if none does.

Nothing here runs in CI or ships by itself. Everything generated goes to `work/` (git-ignored).

## Quick start (exact commands, 4 vCPU / 8 GB / 10 GB free disk)

Run from the repository root after `npm ci` (Ubuntu 24.04 with
`apt-get install --no-install-recommends tesseract-ocr make git curl`; `uv` 0.11+; Node 22+).

| # | Command | What it does | Time on 4 vCPU |
|---|---|---|---|
| 0 | `training/mrz/bin/00-setup.sh` | checks the tools, installs Pillow and NumPy (wheels from `uv.lock`), fetches the pinned inputs and checks their SHA-256 | 1 min |
| 1 | `training/mrz/bin/10-data.sh` | 80,000 training lines (half through the rider's real pipeline) and the held-out G1 sets | about 75 min |
| 2 | `training/mrz/bin/20-lstmf.sh` | `.lstmf` files, unicharset, proto model, train/eval lists (tesstrain) | about 15 min |
| 3 | `nohup training/mrz/bin/30-train.sh > training/mrz/work/logs/train-scratch.out 2>&1 &` | run 1: 150,000 iterations from zero; resumable | about 4.5 h (about 600 iterations a minute with 4 threads) |
| 4 | `training/mrz/bin/40-export.sh scratch` | the integer model (phone) and float model from the best checkpoint | seconds |
| 5 | `training/mrz/bin/50-bench.sh` | the 1,000-document G2/G3 benchmark (once) | about 11 min, 400 MB |
| 6 | `training/mrz/bin/60-gates.sh training/mrz/work/models/scratch-<checkpoint>` | G1, G2, G3, fixtures, size; `report.md`; exit 0 only if all pass | about 10 min (20 the first time: Doubango's numbers are measured once) |

Everything up to the end of training in one go, detached (about 6.5 h; about 3 GB in `work/`):

```
B=training/mrz/bin
$B/00-setup.sh && nohup sh -c "$B/10-data.sh && $B/20-lstmf.sh && $B/50-bench.sh && $B/30-train.sh" \
  > training/mrz/work/logs/run1.out 2>&1 &
tail -F training/mrz/work/runs/scratch/progress.log
```

If run 1 fails: `training/mrz/bin/00-setup.sh --finetune`, then
`nohup training/mrz/bin/31-finetune.sh > training/mrz/work/logs/train-finetune.out 2>&1 &`
(30,000 iterations, about 2 h at about 280 iterations a minute), `40-export.sh finetune`, `60-gates.sh` on its folder.

Every setting can be changed from the environment (see `bin/env.sh` and the top of each script):
`THREADS` (parallel jobs, default all cores), `TRAIN_THREADS` (OpenMP threads of `lstmtraining`,
default min(4, cores)), `LINES`, `MAX_ITERATIONS`, `LEARNING_RATE`, `NET_SPEC`, `MRZ_WORK` (another
work folder, e.g. on a bigger disk).

### Resuming

Every stage can be stopped (Ctrl-C, a reboot) and started again with the same command:

- `10-data.sh` works in shards of 250 stills or 500 lines and skips every shard already done
  (`.done` marker); the held-out sets likewise.
- `20-lstmf.sh` is `make`: only missing `.lstmf` files are built.
- `30-train.sh` / `31-finetune.sh`: `lstmtraining` writes `work/runs/<run>/checkpoints/mrz_checkpoint`
  every 100 iterations and continues from it when the same command runs again, so a stop loses at most
  100 iterations. To train further than planned, raise the limit: `MAX_ITERATIONS=200000 bin/30-train.sh`.
  Progress: `work/runs/<run>/progress.log` (one line every 5 minutes: iteration, training error, latest
  evaluation error); the full log is `training.log`. Best-model checkpoints are pruned on the way (the 3
  lowest-error and 2 newest stay; up to 18 MB each from zero, up to 68 MB fine-tuned).
- `50-bench.sh` renders in ranges of 50 and skips ranges already drawn.
- `60-gates.sh` measures Doubango once per benchmark size and reuses it.

## How the data is made

Every document and line is **fictitious**: random names from syllables and letters, random numbers and
dates, real or made-up state codes, valid ICAO check digits (`py/mrztext.py`). No real document image is
ever used for training (and the PM's test photos, G4, never will be).

**Realistic half (the research's key finding).** Both trial models of the research failed mostly on the
first character of a line in the real pipeline: their training lines had wide white margins, while
Tesseract hands its LSTM a tight crop. So half the lines go through exactly what the phone does:

1. `py/docs.py` draws a whole TD1 card back (3 lines) or TD3 passport page (2 lines) as the rider's still
   shows it: security-print waves (often under the code lines), headings, fields, a QR-like block or a
   portrait, a signature; on a dark, mid or light table; the still 640-1,700 px wide, the document 82-100%
   of the guide, turned up to 4 degrees with a little perspective; uneven light, shadows, glare kept from
   wiping characters out; focus blur, hand shake, sensor noise, phone sharpening, sometimes JPEG.
   Capitals come out 12-45 px tall.
2. `node/cutLines.ts` runs the rider's own `locateMrzBand` and `prepareForOcr` (`@verify/capture`,
   unchanged, through `node/run.mjs`), with the local threshold 80% of the time and Otsu's 20% (the
   reader's second pass).
3. The prepared bands of a shard go through native Tesseract in one batch (page segmentation 6, as the
   rider), and each line is cut **where Tesseract cuts it** for its LSTM (`linerec.cpp`: the row's box
   stretched to its descender and ascender lines, plus 4 px), rebuilt from hOCR. These crops vary a lot:
   5-18 px of room below the baseline at 32 px capitals, and on many bands the first line's box reaches
   up to specks at the band's edge. Only Tesseract's geometry is used; the text it reads (with Google's
   `tessdata_fast` eng, pinned) is thrown away.
4. Our own row finding pairs Tesseract's lines with the ground truth and checks them. A line whose row
   does not look like its code line (characters missing, wrong width, Tesseract's line split or merged)
   is skipped, never guessed. Stills where the rider's locate step finds nothing are skipped too (11-15%
   of these renders; see Findings); `work/data/summary.json` counts every reason.

**Synthetic half.** `py/make_lines.py` draws single lines (`py/lines.py`): 15% random strings over the
37 characters, the rest TD3, TD1 and TD2 lines. Augmentations from the research: capitals 10-42 px
(log-uniform), pitch ±7%, character jitter, bolder and thinner strokes, paper and ink levels, low
contrast, guilloche, light gradient, glare, rotation, keystone, blur up to 0.1 × capital height,
resolution loss, noise, sharpening, JPEG 25-95. 60% of them also go through the rider's prepare step and
Tesseract's cut (as above); 40% are cropped like Tesseract's crops and keep their grey levels, with
specks before the first character and bits of the neighbouring line sometimes in the crop.

**Volume.** 80,000 lines by default (60-100k is the target; `LINES=100000` for more). tesstrain keeps
4% for `lstmtraining`'s own evaluation. About 2.1 lines come out of each still.

**Held-out sets.**
- G1 line sets (`work/data/g1/{clean,degraded,lowres}`, 600/1,000/1,000 lines, their own seeds):
  single lines rendered with the research's clean, degraded and low-resolution (14-16 px capitals)
  presets, then prepared and cut as above.
- G2/G3 document benchmark (`work/bench`, 1,000 stills, its own seed): drawn with **another renderer**,
  the repository's fixture renderer `scripts/make-mrz-fixtures.py` (imported read-only), TD1 and TD3
  alternating, clean and degraded (half of the degraded ones turned up to 2.5 degrees).

## Training

- **Run 1, from zero** (`bin/30-train.sh`): tesstrain's network `[1,36,0,1 Ct3,3,16 Mp3,3 Lfys48 Lfx96
  Lrx96 Lfx192 O1c<n>]` (about 372k weights; 0.35 MB gzipped as an integer model), learning rate 0.002,
  150,000 iterations. The output size is the unicharset's: our 37 characters plus Tesseract's own entries.
- **Run 2, fallback fine-tune** (`bin/31-finetune.sh`): `combine_tessdata -e eng.traineddata eng.lstm`,
  then `lstmtraining --old_traineddata eng.traineddata --continue_from eng.lstm` with our proto model, so
  eng's 111 outputs are cut down to ours (the log says "Code range changed from 111 to 39"); learning
  rate 0.0001, 30,000 iterations. tesstrain's own `START_MODEL` path is not used: it would merge eng's
  111-symbol set into ours.
- **Export** (`bin/40-export.sh`): the integer model (`--convert_to_int`), the only kind tesseract.js
  7.0.0 can run, gzipped with `gzip -9n` as the site would serve it; and the float model of the same
  checkpoint for native Tesseract (lstmeval in the gates). `model.json` records sizes and SHA-256.

## The gates (`gates.json`, `py/gates.py`, `bin/60-gates.sh`)

| Gate | What | Pass |
|---|---|---|
| G1 | Line CER on the held-out sets: integer model in tesseract.js 7.0.0, the rider's settings with page segmentation 7 (one line per image) | clean ≤ 0.5% and ≥ 98% lines exact; low-res ≤ 1.0%; degraded ≤ 10%; never worse than Doubango on the same set |
| G2 | Wrong-but-valid reads (every check digit passes, a character is wrong) on the 1,000-document benchmark through the **real rider pipeline**: `apps/rider/src/mrz/reader.ts` unchanged, tesseract.js 7.0.0, page segmentation 6, `cacheMethod: "none"`, the candidate via `langPath` | exactly 0, on at least 1,000 documents |
| G3 | The same 1,000 documents compared with Doubango | valid and exact ≥ 97% and ≥ Doubango's; wrong-but-valid ≤ Doubango's; names line exact ≥ 99% |
| fixtures | The repository's MRZ fixtures as `reader.fixtures.test.ts` expects them (6/6) | no failure |
| size | Integer model, gzipped | ≤ 1.5 MB |
| G4 | The PM's own test-session photos, read offline before switching | manual: valid rate ≥ Doubango's, zero wrong-but-valid |

`bin/60-gates.sh` writes `work/gates/<model>/report.md` (and `report.json`, the benchmark broken down by
format and variant, the wrong-but-valid reads with their fictitious lines, and native `lstmeval` of the
integer and float models for information). Exit code 0 only when every automated gate passes. A check
that lacks its data (a candidate without `model.json`, a Doubango G1 result missing for a set) is
"missing", which fails like any other check; `60-gates.sh` measures Doubango again whenever one of its
G1 results is missing or older than the sets. `py/test_gates.py` covers these rules (in CI:
`python3 -m unittest discover -s training/mrz/py -p "test_*.py"`).

The two harnesses can also be run alone, e.g. on any folder holding a `mrz.traineddata.gz`:

```
node training/mrz/node/run.mjs training/mrz/node/docbench.ts --bench training/mrz/work/bench/bench.json \
  --model apps/rider/public/ocr/mrz-1 --out /tmp/doubango.json --limit 200 --workers 4
node training/mrz/node/run.mjs training/mrz/node/lineCer.ts --set training/mrz/work/data/g1/clean \
  --model apps/rider/public/ocr/mrz-1
```

For G4, the same `docbench.ts` reads any list in the `bench.json` format (`file`, `format`, `variant`,
`lines`) of 8-bit PGM stills; the photos stay on the PM's machine and are never used for training.

### Doubango's numbers (the baseline to beat)

Measured on 2026-10-14 (4 vCPU sandbox) with `bin/10-data.sh --g1`, `bin/20-lstmf.sh --g1`,
`bin/50-bench.sh 200` and `bin/60-gates.sh --baseline --docs 200`; full numbers in
`results/baseline-doubango.json`.

| | Doubango (`mrz-1`) |
|---|---|
| G1 clean (600 lines) | CER 0.014%, 99.5% of lines exact |
| G1 low resolution (980 lines) | CER 0.922%, 90.0% exact |
| G1 degraded (919 lines) | CER 5.457%, 62.2% exact; first character wrong on 10.8% of lines |
| native lstmeval (integer) | clean 0.019%, degraded 7.822%, low resolution 1.395% |
| G2/G3, first 200 benchmark documents | 196 valid and exact (98%), **1 wrong but valid**, 3 invalid (all TD3 clean), 0 not found; names line exact 200/200; CER 0.039%; 424 ms per still |
| repository fixtures | 6/6 |

Doubango's one wrong-but-valid read was **not the model's**: the OCR read
`2801142F8612076BELK<<<<<<<<<<6` exactly, then the shared look-alike correction turned the optional
data's real `K` into `<` (see Findings). The G1 sets keep 92-100% of the lines rendered: the cutter
skips lines whose characters it cannot count, which are the worst of the degraded set.

## Smoke test

`training/mrz/bin/smoke.sh` runs the whole pipeline tiny (3,000 lines, 100-line G1 sets, 300
iterations from zero and 200 fine-tuned, 20 benchmark documents) in `work/smoke/` and records each
stage's time in `work/smoke/timings.json`. Its models are far too young to pass; the point is that every
stage runs and the gates write their report. Delete `work/smoke` afterwards.

Last run (2026-10-14, 4 vCPU, from an empty `work/smoke`; `results/smoke.json`): setup 1 s, data 176 s
(3,327 lines with the G1 sets: about 19 lines a second), `.lstmf` 35 s, 300 iterations from zero 30 s,
resuming to 400 10 s, 200 fine-tuning iterations 43 s, export 2 s, gates 118 s and 105 s (20
documents); the 200 benchmark stills took 127 s on their own. In all about 9 minutes. After its 200
iterations the fine-tuned model already read 14 of 20 benchmark documents exactly, with no wrong-but-
valid read; the model from zero, at 400 iterations, reads nothing yet (as expected).

## Shipping a model that passes

1. `gzip`ped integer model to `apps/rider/public/ocr/mrz-2/mrz.traineddata.gz`; in
   `apps/rider/src/mrz/types.ts` `OCR_ASSETS`: `langPath: "/ocr/mrz-2"`, `cachePath: "ocr-mrz-2"`,
   `engine: "tesseract.js-7.0.0/mrz-2"` (a new path, so phones never mix the old cached model with the
   new one).
2. Notice: our model, Apache-2.0-compatible inputs; a fine-tuned model must also carry the Apache-2.0
   text with a statement that we changed Google's `eng` weights (`apps/rider/public/ocr/NOTICE.txt`).
3. `docs/LICENSES.md`: the model's row with its SHA-256 (from `model.json`), the run (`run.json`), the
   inputs (`inputs.json`), the training log archived with it.
4. `npx vitest run apps/rider/src/mrz/reader.fixtures.test.ts` with the new model, and G4 on the PM's
   photos, before switching.
5. If no model passes, Doubango stays and the outcome is recorded in `docs/M3_SPEC.md`.

## Licences and provenance

- **Inputs** (`inputs.json`, all checked by SHA-256): tesstrain at commit `405346a` (Apache-2.0);
  langdata_lstm `radical-stroke.txt` and `Latin.unicharset` at `07930fd` (Apache-2.0, character property
  tables); tessdata_fast `eng` at `8741641` (Apache-2.0; only lets Tesseract find text lines, its output
  is discarded); tessdata_best `eng` at `e12c65a` (Apache-2.0; fallback run 2 only).
- **Fonts**: OCR-B 0.3.1 by Matthew Skala after Norbert Schwarz (`scripts/fonts/ocr-b`, free use without
  limitation; no copyright claimed by Skala) for every code line; Pillow's bundled Aileron Regular
  (dot-colon, CC0) for headings and fields. The fonts are only used to draw images; they are not shipped.
- **Fine-tune provenance (run 2 only)**: Google trained `eng` on synthetic renders of text in about
  4,500 fonts. langdata_lstm `eng/okfonts.txt` lists 4,567 of them, most commercial (1,970 "Std" and 474
  "MT" entries), and the training text is undocumented. The weights are Apache-2.0, but the lawyer
  should see that list before a fine-tuned model ships. Run 1 avoids the question.
- **Python**: the PyPI wheels of Pillow 12.3.0 (MIT-CMU; it bundles FreeType, used under the FreeType
  Licence, not GPL) and NumPy 2.5.3 (BSD-3-Clause), from `uv.lock` with hashes, `exclude-newer`
  2026-10-01. **Never Ubuntu's `python3-pil`**: it links libimagequant (GPL-3.0+) and libjbig (GPL-2+).
  tesstrain's `requirements.txt` is not installed (python-bidi is LGPL and only for right-to-left
  scripts).
- **Build tools only, never shipped**: Ubuntu 24.04's `tesseract-ocr` 5.3.4-1build5 (Apache-2.0) with its
  training tools. Through leptonica and libtiff it loads **libjbig0 (GPL-2+)**, and LGPL libraries
  (pango, cairo, glib, fribidi, gnutls, nettle, libidn2 and others) plus the GCC runtime (GPL-3 with the
  runtime exception); GNU Make (GPL-3.0+) and bash (GPL-3.0+) run tesstrain. They run on the training
  machine and produce data files; none of their code ends up in the model or reaches a rider. The phone
  runs our model in tesseract.js-core, whose libraries are listed in `docs/LICENSES.md`.
- **The model** is our own output: weights learned from our renders (and, for run 2 only, from Google's
  Apache-2.0 eng weights).

## Findings for other areas

- **G2 cannot reach zero while the correction turns real K's into fillers.**
  `restoreOptionalFillers` (`supabase/functions/_shared/mrzCorrect.ts`, step 4) turns a K in the run of
  fillers that ends an optional-data field into `<`. Its comment explains why: K counts 20, and 20 × 7,
  20 × 3 and 20 × 1 are all multiples of 10, so no check digit can tell K from `<`, and a `<` misread as
  K would pass unseen. The same arithmetic cuts the other way: a **real** K there (optional data
  `K<<<<<<<<<<`, or `AB<K<<<<`) silently becomes `<` and the read passes. That made Doubango's only
  wrong-but-valid read on the first 200 benchmark documents (the OCR had read the line exactly), and with
  random optional data it will happen a few times in 1,000 documents whatever the model. The gate report
  lists these reads separately ("made wrong by the correction step"); `gates.json` has
  `G2.countCorrectionCaused` (true: the plan's strict reading, every wrong-but-valid read counts; false:
  judge the model alone). Someone has to decide which, or change the correction.
- **The rider's locate step finds no code lines on about 11-15% of the training stills** (security-print
  waves running under the code lines, a 3-4 degree tilt with some blur, small documents); the phone then
  reads a fixed crop instead. Those stills are skipped here, so the model learns only from bands locate
  found. Worth checking against real photos in G4.
- `scripts/fonts/ocr-b/README.md` and `docs/LICENSES.md` describe OCR-B as "tests only"; it now also
  draws the training data (rendered images only, the font is not shipped), and the training tools,
  inputs and Pillow's bundled Aileron font need their rows (see Licences).

## Files

| Path | What |
|---|---|
| `bin/env.sh` | paths, seeds, threads; sourced by every stage |
| `bin/00-setup.sh` ... `bin/60-gates.sh`, `bin/smoke.sh` | one command per stage (above) |
| `inputs.json` | every pinned input with its SHA-256 and licence |
| `gates.json` | the gate thresholds |
| `py/mrztext.py` | fictitious MRZ text with valid check digits (`python py/mrztext.py` self-tests) |
| `py/lines.py`, `py/make_lines.py` | single-line renderer and its shard script |
| `py/docs.py` | training document stills |
| `py/bench.py` | G2/G3 benchmark stills (the fixture renderer) |
| `py/inputs.py`, `py/gates.py`, `py/test_gates.py` | fetch and check the inputs; apply the gates; test the gate rules |
| `node/run.mjs` | runs a TypeScript script with the repository's code (Vite's module runner) |
| `node/cutLines.ts` | locate + prepare + Tesseract's cut, for training and G1 lines |
| `node/docbench.ts` | G2/G3 (and fixtures) through the real rider reader |
| `node/lineCer.ts` | G1 line CER in tesseract.js |
| `results/` | committed numbers: Doubango's baseline, the smoke test |
| `pyproject.toml`, `uv.lock`, `.python-version` | the Python environment (3.12) |

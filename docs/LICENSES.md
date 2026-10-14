# Licence register

**Rule:** every library, model, font and asset used by Confiance Verify must allow **commercial use**. Software released "for research / non-commercial use only" is never allowed.

**Automatic check:** CI runs `npm run licenses` (`scripts/check-licenses.mjs`). It fails the build if *any* npm package, direct or indirect, has a licence outside the allowlist. Models, fonts and other files we copy into the repository are not npm packages, so they are checked by hand and recorded below with a checksum. A Python licence check will be added with the AI worker (M3). Until then the only Python package, Pillow, is a developer tool that CI never installs.

**Allowed:** MIT, ISC, 0BSD, BSD-2/3-Clause, Apache-2.0, Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0, Zlib. MPL-2.0 is also allowed: it is "file-level copyleft", meaning we would only have to publish changes made to those files.

**Forbidden:** GPL, AGPL, SSPL, BUSL, any "non-commercial" / "research-only" licence (e.g. CC BY-NC), and any unknown licence.

## In use now (M0–M2)

| Component | Version | Licence | Where it runs | Source |
|---|---|---|---|---|
| React, React DOM | 19.3.0 | MIT | Web apps | npmjs.com/package/react |
| i18next | 26.4.2 | MIT | Web apps (FR/EN) | npmjs.com/package/i18next |
| react-i18next | 17.0.15 | MIT | Web apps | npmjs.com/package/react-i18next |
| @supabase/supabase-js | 2.117.2 | MIT | Web apps; Edge Functions (as `npm:@supabase/supabase-js@2.117.2`) | npmjs.com/package/@supabase/supabase-js |
| uqr | 0.1.3 | MIT | Dashboard (QR codes of the rider test link and its debug link) | npmjs.com/package/uqr |
| **tesseract.js** | 7.0.0 (exact pin) | Apache-2.0 | Rider site: reads the MRZ ("code lines"). Loaded only when a document with code lines is chosen. Its worker script is served from our own site (`/ocr/7.0.0/worker.min.js`), never from a CDN. Also used in Node by the real-reading test. | npmjs.com/package/tesseract.js · github.com/naptha/tesseract.js |
| **tesseract.js-core** | 7.0.0 (exact pin: npm's `latest` tag for it still points to 6.1.2) | Apache-2.0 | Rider site: the Tesseract OCR engine compiled to WebAssembly (`/ocr/7.0.0/tesseract-core*-lstm.wasm.js`) | npmjs.com/package/tesseract.js-core · github.com/naptha/tesseract.js-core |
| **MRZ reading model** (DoubangoTelecom) | see "MRZ reading" below | BSD-3-Clause | Rider site | see below |
| Vite | 8.3.1 | MIT | Build only | npmjs.com/package/vite |
| @vitejs/plugin-react | 6.1.1 | MIT | Build only | npmjs.com/package/@vitejs/plugin-react |
| TypeScript | 6.0.3 | Apache-2.0 | Build only | npmjs.com/package/typescript |
| Vitest | 5.0.2 | MIT | Tests only | npmjs.com/package/vitest |
| Deno (`deno` npm package and its `@deno/*` platform binaries) | 2.9.6 | MIT | Development and CI only (type check and lint of the Edge Functions) | npmjs.com/package/deno |
| @playwright/test (with playwright, playwright-core) | 1.63.0 | Apache-2.0 | Tests only; the browsers it downloads are never shipped | npmjs.com/package/@playwright/test |
| lightningcss (dependency of Vite) | (lockfile) | MPL-2.0 | Build only; never shipped to users | npmjs.com/package/lightningcss |
| gitleaks | 8.29.1 | MIT | CI secret scan only | github.com/gitleaks/gitleaks |
| PostgreSQL | 16 (CI) / 17 (Supabase) | PostgreSQL Licence | Database | postgresql.org |
| pgcrypto (PostgreSQL extension, ships with PostgreSQL) | as PostgreSQL | PostgreSQL Licence | Database: encrypts the MRZ lines in `extracted_document_data` (M2) | postgresql.org/docs/current/pgcrypto.html |
| Supabase platform | hosted | Apache-2.0 (open source; also self-hostable) | Backend | github.com/supabase/supabase |
| Supabase Vault | hosted | Apache-2.0 | Database: keeps the encryption key of `extracted_document_data` (M2) | github.com/supabase/vault |
| Supabase Edge Runtime (Deno-based) | hosted | MIT | Backend: the `flow` and `admin` Edge Functions | github.com/supabase/edge-runtime |
| Pillow | 12.3.0 (the version tested) | MIT-CMU (the historical PIL licence, a variant of HPND) | **Developer tool only**: `scripts/make-mrz-fixtures.py` draws the MRZ test images. Not needed at runtime or in CI. | pypi.org/project/pillow |
| Confiance logo (`packages/shared/assets/*.svg`) | — | Confiance property | Web apps | Confiance Kiosk console |

The capture quality engine (`packages/capture`: blur, glare, framing and document detection, and since M2 finding and preparing the code lines for reading) is our own code. It is built on textbook image maths (luma, Laplacian variance, Sobel gradients, Otsu and local-mean thresholds) and uses no third-party image library. The MRZ parser and check digits (`supabase/functions/_shared/mrz.ts`) and the look-alike correction (`apps/rider/src/mrz/correct.ts`) are also our own, written from the ICAO 9303 standard.

The full list of every indirect npm package and its licence is in `package-lock.json`, and is checked on every CI run.

## MRZ reading (M2): engine, model and test material

### Inside the OCR engine files
The rider site serves these files under `/ocr/`, so every rider's phone receives the libraries below. `apps/rider/public/ocr/NOTICE.txt`, served at `/ocr/NOTICE.txt`, reproduces what their licences ask us to pass on: each copyright notice, the licence texts (MIT, BSD, Apache-2.0, libpng, libtiff, zlib, Leptonica, openlibm) and the sentence the IJG licence requires ("this software is based in part on the work of the Independent JPEG Group"). The copyright banners of the minified `worker.min.js` are also served next to it, as `worker.min.js.LICENSE.txt` (emitted by `apps/rider/vite.config.ts`). `apps/rider/src/mrz/model.test.ts` checks that every library in this table is in the notice, that the notice carries the full Apache-2.0 text, and that the licence file the worker points to is served.

The C libraries' versions are those tesseract.js-core 7.0.0 builds (its `third_party` git submodules), read from their sources at those commits.

| Library | Version | Licence | Inside |
|---|---|---|---|
| tesseract.js | 7.0.0 | Apache-2.0 | `worker.min.js` |
| buffer | 6 | MIT | `worker.min.js` (Node's Buffer for the browser) |
| base64-js | 1 | MIT | `worker.min.js` (used by buffer) |
| ieee754 | 1.2 | BSD-3-Clause | `worker.min.js` (used by buffer) |
| regenerator-runtime | 0.13.11 | MIT | `worker.min.js` |
| zlib.js | 0.3.1 (npm package zlibjs) | MIT | `worker.min.js` (unzips the model) |
| bmp-js | 0.1.0 | MIT | `worker.min.js` |
| is-url | 1.2.4 | MIT | `worker.min.js` |
| idb-keyval | 6.3.0 | Apache-2.0 | `worker.min.js` (keeps the model in the browser's IndexedDB) |
| wasm-feature-detect | 1.9.0 | Apache-2.0 | `worker.min.js` (picks the engine build the browser supports) |
| tesseract.js-core | 7.0.0 | Apache-2.0 | `tesseract-core*-lstm.wasm.js` |
| Tesseract OCR | 5 (tesseract.js-core's fork, commit 2a9c1c4) | Apache-2.0 | `tesseract-core*-lstm.wasm.js` |
| Leptonica | 1.83 | BSD-2-Clause-style Leptonica licence | `tesseract-core*-lstm.wasm.js` |
| libjpeg | 9a | IJG licence | `tesseract-core*-lstm.wasm.js` |
| libpng | 1.6.38 | libpng licence (PNG Reference Library License) | `tesseract-core*-lstm.wasm.js` |
| libtiff | 4.3.0 | libtiff licence | `tesseract-core*-lstm.wasm.js` |
| libwebp | 1.2.2 | BSD-3-Clause | `tesseract-core*-lstm.wasm.js` |
| giflib | 5.1.4 | MIT | `tesseract-core*-lstm.wasm.js` |
| zlib | 1.2.12 | Zlib | `tesseract-core*-lstm.wasm.js` |
| openlibm | commit ae2d916 | MIT, ISC, BSD-2-Clause and the FDLIBM notice (its LGPL test files are not built) | `tesseract-core*-lstm.wasm.js` |

Other indirect npm dependencies of tesseract.js, from the lockfile, used only in Node: node-fetch 2.7.0 (with whatwg-url 5.0.0, tr46 0.0.3 and webidl-conversions 3.0.1) and opencollective-postinstall 2.0.3. All are MIT, except webidl-conversions (BSD-2-Clause). **opencollective-postinstall** is tesseract.js's install script: it runs once during `npm ci` and only prints a message.

### The reading model
| | |
|---|---|
| What | `mrz.traineddata`, a Tesseract LSTM model ("tessdata_fast") trained to read MRZ characters, by DoubangoTelecom |
| Source | github.com/DoubangoTelecom/tesseractMRZ, file `tessdata_fast/mrz.traineddata` |
| Licence | BSD-3-Clause (commercial use allowed; the copyright notice must be kept). Checked 2026-10-13. Full text in `apps/rider/public/ocr/NOTICE.txt`. |
| Our copy | `apps/rider/public/ocr/mrz-1/mrz.traineddata.gz`, served gzipped (1.31 MB) |
| SHA-256 of the raw (uncompressed) file | `ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01` |
| SHA-256 of the gzipped file | `dbbd4add162b8d28ed82b4a384c5f16dff274c63ddcd80b63e0315fd130a3909` |
| Pinned by | `apps/rider/src/mrz/model.test.ts` (both checksums, and the licence in `NOTICE.txt`) |
| **Provenance caveat** | Its authors trained it on MRZ images collected from the web, which may include real people's documents. The licence covers the model file, not that training data. **We replace it with our own model in M3**, trained only on images we have the right to use (synthetic, or consented). |

The generic English Tesseract model was tried and is not used: it misread about 45% of MRZ characters.

### Test material (never shipped to riders)
| Component | Licence | Use |
|---|---|---|
| **OCR-B font** `scripts/fonts/ocr-b/OCRB.otf`, version 0.3.1 of Matthew Skala's "OCR fonts" package (tsukurimashou.org/ocr.php.en, file `ocr-0.3.1.zip`), based on Norbert Schwarz's METAFONT OCR-B. SHA-256 `87c8d5bfd541d28023d2ba3383169c49f565e10d487ebb027ea0d735ef558707`. | Free use without limitation. Schwarz's notice: "You may freely use, modify and/or distribute this file, without limitation." Skala: "I make no copyright claim on these fonts myself." | **Tests only**: draws the MRZ test images. Details in `scripts/fonts/ocr-b/README.md`. |
| MRZ test images, `e2e/fixtures/mrz/` | Ours, generated by `scripts/make-mrz-fixtures.py` (Pillow, dev only) | Fictitious SPECIMEN documents of ICAO's made-up state "UTO", with obviously fake names, drawn in Skala's OCR-B. Nothing in them is a real person or document. |
| ICAO 9303 specimen lines ("Utopia" passport `L898902C3`, ID card `D23145890`) | Published examples from the ICAO standard; fictitious | Unit tests, database tests and dashboard previews |

**Deliberately left out:** the OCR-A font from the same package, because its licence restricts commercial use. The MRZ is printed in OCR-B, so OCR-A is not needed.

## Planned (to be verified and recorded when added)

| Component | Milestone | Expected licence | Status / caveat |
|---|---|---|---|
| Our own MRZ reading model (replaces Doubango's) | M3 | Ours | Trained only on images we have the right to use (synthetic, or consented) |
| Python 3.12, OpenCV, NumPy, Pillow, ONNX Runtime | M3 | PSF, Apache-2.0, BSD-3, MIT-CMU (HPND), MIT | — |
| RapidOCR + PP-OCR models | M3 | Apache-2.0 (code and models) | — |
| OpenCV YuNet face detector | M5 | MIT | — |
| MediaPipe Face Landmarker | M5 | Apache-2.0 | — |
| MiniVision Silent-Face-Anti-Spoofing | M6 | Apache-2.0 | — |
| OpenCV SFace / dlib ResNet face recognition | M7 | Apache-2.0 / public domain (CC0) | **The lawyer must review the provenance of the training data.** Benchmark on Cameroonian faces before use. |
| scikit-learn | Phase 2 | BSD-3-Clause | — |

## Rejected on purpose

| Component | Licence | Why rejected |
|---|---|---|
| Ultralytics YOLO (v5/v8/v11…) | AGPL-3.0 | Copyleft would force us to publish our service code, or buy an enterprise licence |
| InsightFace / ArcFace pretrained models (buffalo_l etc.) | Non-commercial | Not allowed for commercial use |
| `mrz` (Python) | GPL-3.0 | We write our own ICAO 9303 MRZ parser instead |
| OCR-A font from Skala's "OCR fonts" package | Non-commercial restriction | Not needed: the MRZ uses OCR-B |
| MinIO | AGPL-3.0 | Supabase Storage is used instead |
| Redis ≥ 7.4 | RSAL/SSPL (AGPL option from 8.0) | Not needed: the job queue runs inside Postgres (Supabase Queues) |
| HashiCorp Vault | BUSL-1.1 | Supabase Vault is used instead (OpenBao if we self-host) |

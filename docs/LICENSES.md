# Licence register

**Rule:** every library, model, font and asset used by Confiance Verify must allow **commercial use**. Software released "for research / non-commercial use only" is never allowed.

**Automatic checks:**
- **npm:** CI runs `npm run licenses` (`scripts/check-licenses.mjs`). It fails the build if *any* npm package, direct or indirect, has a licence outside the allowlist.
- **Python (AI worker, M3):** the worker's packages are pinned with hashes in `worker/uv.lock`. `pip-licenses` reads their declared licences, but it cannot see the native libraries bundled *inside* a wheel, nor code linked statically into one, and several wheels declare only "BSD" or "MIT" while they carry LGPL or GCC-runtime parts. Those parts are therefore listed by hand below, wheel by wheel, and reviewed whenever a version changes. The CI Python job (M3) runs the worker's tests, `uv lock --check` and this licence check.
- **Everything else:** models, fonts and other files we copy into the repository are checked by hand and recorded below with a checksum.

**Allowed:** MIT, ISC, 0BSD, BSD-2/3-Clause, Apache-2.0, Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0 / PSF-2.0, Zlib. Since M3, also MIT-0, MIT-CMU (Pillow's historical PIL licence) and BSL-1.0 (the Boost licence, used by the Clipper code inside pyclipper); all permissive. MPL-2.0 is also allowed: it is "file-level copyleft", meaning we would only have to publish changes made to those files.

**Allowed only as documented exceptions** (PM decision, 2026-10-14; each one is listed where it occurs):
- **LGPL libraries**, only unmodified and dynamically linked (separate `.so` files that could be replaced): FFmpeg, libquadmath and GEOS inside the worker's wheels.
- **GCC runtime libraries** (libgfortran) under GPL-3.0+ **with the GCC Runtime Library Exception**, which lets programs use them under any licence.
- **Intel IPP ICV** inside OpenCV, under the **Intel Simplified Software License**: proprietary, binary-only, redistribution and commercial use allowed, no modification or reverse engineering. Until the slim OpenCV build removes it.
- **GPL build tools used only on the model-training machine** (never shipped; see "MRZ model training").

**Forbidden:** GPL, AGPL, SSPL, BUSL, any "non-commercial" / "research-only" licence (e.g. CC BY-NC), and any unknown licence.

## In use now (M0–M4)

| Component | Version | Licence | Where it runs | Source |
|---|---|---|---|---|
| React, React DOM | 19.3.0 | MIT | Web apps | npmjs.com/package/react |
| i18next | 26.4.2 | MIT | Web apps (FR/EN) | npmjs.com/package/i18next |
| react-i18next | 17.0.15 | MIT | Web apps | npmjs.com/package/react-i18next |
| @supabase/supabase-js | 2.117.2 | MIT | Web apps; Edge Functions (as `npm:@supabase/supabase-js@2.117.2`) | npmjs.com/package/@supabase/supabase-js |
| uqr | 0.1.3 | MIT | Dashboard (QR codes of the rider test link and its debug link) | npmjs.com/package/uqr |
| **tesseract.js** | 7.0.0 (exact pin) | Apache-2.0 | Rider site: reads the MRZ ("code lines"). Loaded only when a document with code lines is chosen. Its worker script is served from our own site (`/ocr/7.0.0/worker.min.js`), never from a CDN. Also used in Node by the real-reading test and by the MRZ model's gates. | npmjs.com/package/tesseract.js · github.com/naptha/tesseract.js |
| **tesseract.js-core** | 7.0.0 (exact pin: npm's `latest` tag for it still points to 6.1.2) | Apache-2.0 | Rider site: the Tesseract OCR engine compiled to WebAssembly (`/ocr/7.0.0/tesseract-core*-lstm.wasm.js`) | npmjs.com/package/tesseract.js-core · github.com/naptha/tesseract.js-core |
| **MRZ reading model** (DoubangoTelecom), `mrz-1` | see "MRZ reading" below | BSD-3-Clause | Rider site, every session except test sessions | see below |
| **Our own MRZ reading model**, `mrz-2` (M4) | see "MRZ reading" below | Apache-2.0 (fine-tuned from Google's `eng`) | Rider site, **test sessions only** | see below |
| Vite | 8.3.1 | MIT | Build only (also runs the training scripts' TypeScript, `training/mrz/node/run.mjs`) | npmjs.com/package/vite |
| @vitejs/plugin-react | 6.1.1 | MIT | Build only | npmjs.com/package/@vitejs/plugin-react |
| TypeScript | 6.0.3 | Apache-2.0 | Build only | npmjs.com/package/typescript |
| Vitest | 5.0.2 | MIT | Tests only | npmjs.com/package/vitest |
| Deno (`deno` npm package and its `@deno/*` platform binaries) | 2.9.6 | MIT | Development and CI only (type check and lint of the Edge Functions; the worker's cross-check of the server's MRZ corrector) | npmjs.com/package/deno |
| @playwright/test (with playwright, playwright-core) | 1.63.0 | Apache-2.0 | Tests only; the browsers it downloads are never shipped | npmjs.com/package/@playwright/test |
| lightningcss (dependency of Vite) | (lockfile) | MPL-2.0 | Build only; never shipped to users | npmjs.com/package/lightningcss |
| gitleaks | 8.29.1 | MIT | CI secret scan only | github.com/gitleaks/gitleaks |
| PostgreSQL | 16 (CI) / 17 (Supabase) | PostgreSQL Licence | Database | postgresql.org |
| pgcrypto (PostgreSQL extension, ships with PostgreSQL) | as PostgreSQL | PostgreSQL Licence | Database: encrypts the data read from documents in `extracted_document_data` (since M2) | postgresql.org/docs/current/pgcrypto.html |
| **pg_net** (Supabase extension) | hosted | Apache-2.0 | Database (M3): the sweep rings the AI worker's doorbell over HTTP | github.com/supabase/pg_net |
| **pg_cron** (extension) | hosted | PostgreSQL Licence | Database (M3): runs the sweep every minute | github.com/citusdata/pg_cron |
| Supabase platform | hosted | Apache-2.0 (open source; also self-hostable) | Backend | github.com/supabase/supabase |
| Supabase Vault | hosted | Apache-2.0 | Database: keeps the encryption key of `extracted_document_data` (M2) and the worker's doorbell address (M3) | github.com/supabase/vault |
| Supabase Edge Runtime (Deno-based) | hosted | MIT | Backend: the `flow`, `admin` and (M3) `worker` Edge Functions | github.com/supabase/edge-runtime |
| **Vercel Functions, Python runtime** (a hosting service, not a library) | hosted | Commercial service. **Hobby plan terms: non-commercial personal use only**, no DPA | AI worker (M3), **test sessions only** until Vercel Pro and its DPA (see `THREAT_MODEL.md`) | vercel.com |
| **vercel-runtime** (injected by Vercel into every Python function) | 0.23.2 | Apache-2.0 | AI worker: Vercel's own request handler around `api/process.py`. Not in our lockfile. | pypi.org/project/vercel-runtime |
| **Python** | 3.12 (Vercel's runtime; `uv`-managed locally) | PSF-2.0 | AI worker; developer and training tool | python.org |
| **uv** | 0.11+ (local); Vercel's builder brings its own | MIT OR Apache-2.0 | Build tool: installs the worker and training environments from their lockfiles | github.com/astral-sh/uv |
| Pillow | 12.3.0 | MIT-CMU (the historical PIL licence, a variant of HPND) | AI worker (M3: decodes the photos, JPEG only); developer and training tool (draws test images and training data) | pypi.org/project/pillow |
| Confiance logo (`packages/shared/assets/*.svg`) | — | Confiance property | Web apps | Confiance Kiosk console |

The capture quality engine (`packages/capture`: blur, glare, framing and document detection, and since M2 finding and preparing the code lines for reading) is our own code. It is built on textbook image maths (luma, Laplacian variance, Sobel gradients, Otsu and local-mean thresholds) and uses no third-party image library; the worker's `quality.py` is our own port of it. The MRZ parser and check digits (`supabase/functions/_shared/mrz.ts`) and the look-alike correction (`supabase/functions/_shared/mrzCorrect.ts`, moved there from the rider app in M3 so that the phone and the server share it) are also our own, written from the ICAO 9303 standard. The worker's signing, field reading and classification code are ours too.

The full list of every indirect npm package and its licence is in `package-lock.json`, and is checked on every CI run. M3 adds no npm package; M4 adds no npm or Python package (only our own model file, below).

## AI worker (M3): Python packages, native parts and models

The worker (`worker/`) runs as our own service on Vercel; its code is never given to anyone else. Licence notices are still recorded here, and shipped with the code, as for anything we ship. Most wheels carry their licence and notice files in their `.dist-info` or package folders, and those are deployed with them. **Three runtime wheels contain no licence file at all:**
- **rapidocr 3.9.2** (Apache-2.0), including the three PP-OCR models inside it (Apache-2.0, PaddlePaddle Authors / Baidu); the wheel has no `MODEL_LICENSES.md` either;
- **flatbuffers 25.12.19** (Apache-2.0, Google): its files only point to the licence's URL;
- **antlr4-python3-runtime 4.9.3** (BSD-3-Clause, The ANTLR Project): its files refer to a `LICENSE.txt` that is not installed.

Apache-2.0 asks for a copy of the licence with the software, and BSD-3-Clause for the copyright notice and licence text with a binary. **`worker/NOTICE`** therefore holds the attributions (RapidAI/RapidOCR with the PaddlePaddle and PytorchOCR notices in its code, the PP-OCR models, Google FlatBuffers), the full Apache-2.0 text, and ANTLR's copyright and BSD-3-Clause text, checked against ANTLR's own `LICENSE.txt` at tag 4.9.3. It is deployed with the function (neither `.vercelignore` nor `excludeFiles` drops it). `worker/tests/test_deploy_config.py` fails when a runtime package installs no licence file and is not named, with its version, in `worker/NOTICE`.

### Python packages (`worker/uv.lock`, exact versions, nothing published after 2026-10-01)

| Package | Version | Licence | Why it is there |
|---|---|---|---|
| **rapidocr** | 3.9.2 | Apache-2.0 (the wheel ships no licence text: in `worker/NOTICE`) | OCR pipeline; its wheel carries the PP-OCR models we load |
| **onnxruntime** | 1.30.0 | MIT (its `ThirdPartyNotices.txt` lists the libraries compiled in, among them Eigen, MPL-2.0) | Runs the OCR models |
| **opencv-python-headless** | 4.14.0.94 | Apache-2.0 (OpenCV) and MIT (the packaging scripts); **bundled parts below** | Image operations RapidOCR needs; QR code *detection* (never decoding) |
| **numpy** | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0; **bundled parts below** | Arrays; our quality maths |
| **pillow** | 12.3.0 | MIT-CMU; bundled parts below | Decodes the photo (JPEG only) |
| **cryptography** | 50.0.2 | Apache-2.0 OR BSD-3-Clause; statically links OpenSSL 4.0.3 (Apache-2.0) and Rust crates (MIT / Apache-2.0) | Ed25519 signing of the worker's requests |
| cffi | 2.1.1 | MIT-0 | Dependency of cryptography |
| pycparser | 3.0 | BSD-3-Clause | Dependency of cffi |
| shapely | 2.1.2 | BSD-3-Clause; **bundles GEOS (LGPL-2.1)**, below | RapidOCR's text-box geometry (one area/length call) |
| pyclipper | 1.4.0 | MIT; compiles in Clipper 6.4.2 (BSL-1.0) | RapidOCR's text-box expansion |
| omegaconf | 2.3.1 | BSD-3-Clause (its metadata says only "BSD License") | RapidOCR's configuration |
| antlr4-python3-runtime | 4.9.3 | BSD-3-Clause (its metadata says only "BSD"; no licence file installed: in `worker/NOTICE`) | Dependency of omegaconf. Published as source only, so it is built at install time with **setuptools 84.0.0 (MIT)**, pinned by `build-constraint-dependencies`; that build dependency's hash is not in `uv.lock`. omegaconf 2.4.0 drops it (adoptable after 2026-10-23). |
| PyYAML | 6.0.3 | MIT | Dependency of omegaconf |
| protobuf | 7.36.2 | BSD-3-Clause | Dependency of onnxruntime |
| flatbuffers | 25.12.19 | Apache-2.0 (the wheel ships no licence text: in `worker/NOTICE`) | Dependency of onnxruntime |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause | Dependency of onnxruntime |
| colorlog | 6.12.0 | MIT | RapidOCR's logger (set to ERROR) |
| tqdm | 4.70.1 | MPL-2.0 AND MIT | Dependency of RapidOCR (progress bars for downloads we never make) |
| six | 1.17.0 | MIT | Dependency of RapidOCR |
| requests | 2.34.2 | Apache-2.0 | Dependency of RapidOCR (model downloads, which our explicit model paths disable). The worker's own HTTP calls use the standard library. |
| urllib3 | 2.8.0 | MIT | Dependency of requests |
| idna | 3.20 | BSD-3-Clause | Dependency of requests |
| certifi | 2026.7.22 | MPL-2.0 | Dependency of requests (certificate list) |
| charset-normalizer | 3.5.2 | MIT | Dependency of requests |

**Development only** (the `dev` group; never on Vercel): pytest 9.1.1 (MIT), pluggy 1.6.0 (MIT), iniconfig 2.3.0 (MIT), Pygments 2.21.0 (BSD-2-Clause), pip-licenses 5.5.5 (MIT), prettytable 3.18.0 (BSD-3-Clause), wcwidth 0.9.1 (MIT), and colorama 0.4.6 (BSD-3-Clause, Windows only).

**In the lockfile but never installed:** opencv-python 5.0.0.93, the GUI build that rapidocr 3.9.2 asks for. It bundles Qt 5 (LGPL-3.0) and needs libGL. The override `opencv-python; sys_platform == 'never'` in `worker/pyproject.toml` keeps it out; the headless build provides the same `cv2` module.

### Native libraries inside the wheels
Taken from each wheel's `.libs` folder, its extension modules and its notices (checked 2026-10-14). "Shared" means a separate `.so` file, loaded at run time (dynamic linking); "static" means compiled into the module.

| Wheel | Component | Version | Licence | Linking | Note |
|---|---|---|---|---|---|
| numpy | OpenBLAS (`libscipy_openblas64`) | as built | BSD-3-Clause | shared | |
| numpy | libgfortran | 5 | GPL-3.0+ **with the GCC Runtime Library Exception 3.1** | shared | exception: see the top of this file |
| numpy | libquadmath | as built | **LGPL-2.1+** | shared, unmodified | exception: see the top of this file |
| opencv-python-headless | FFmpeg: libavcodec, libavformat, libavutil, libswresample, libswscale | 8.1.x | **LGPL-2.1+** | shared, unmodified | Video code we never call: photos are decoded by Pillow only |
| opencv-python-headless | **OpenSSL** (libcrypto, libssl) | **1.1.1k** | OpenSSL / SSLeay (old dual licence, with advertising clauses) | shared | **Out of support since 2023.** Used only by FFmpeg's network code, which we never call. Removed by the slim build. |
| opencv-python-headless | libaom | 3.14.1 | BSD-2-Clause, plus the AOMedia Patent License 1.0 (a patent grant with defensive termination) | shared | |
| opencv-python-headless | libavif / libdav1d / libvpx | as built | BSD-2-Clause / BSD-2-Clause / BSD-3-Clause | shared | |
| opencv-python-headless | libpng16, libdrm | as built | libpng licence, MIT | shared | |
| opencv-python-headless | OpenBLAS (`libopenblasp`) | 0.3.15 | BSD-3-Clause | shared | not in the wheel's own notice file |
| opencv-python-headless | libgfortran, libquadmath | 8.5.0 | GPL-3.0+ with the GCC exception; **LGPL-2.1+** | shared, unmodified | not in the wheel's own notice file |
| opencv-python-headless | **Intel IPP ICV** (in `cv2.abi3.so`, 68 MB) | 2026.0.0 (the notice says 2021 Update 10) | **Intel Simplified Software License** (proprietary; binary-only; redistribution and commercial use allowed; no modification or reverse engineering) | static | exception: see the top of this file. x86-64 wheels only. Removed by the slim build (`-DWITH_IPP=OFF`). |
| opencv-python-headless | Intel ITT (ittnotify) | 3.25.4 | GPL-2.0 OR BSD-3-Clause: **we use it under BSD-3-Clause** | static | not in the wheel's own notice file |
| opencv-python-headless | protobuf, libjpeg-turbo, libtiff, OpenJPEG, OpenEXR, quirc, flatbuffers | as built | BSD-3-Clause, IJG + BSD-3-Clause + Zlib, libtiff licence, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0 | static | |
| pillow | libjpeg-turbo, libpng16, libtiff, libwebp (and demux, mux, sharpyuv), libavif, libopenjp2, liblzma, libbrotli, libzstd, libxcb, libXau | as built | IJG + BSD-3-Clause + Zlib, libpng, libtiff, BSD-3-Clause, BSD-2-Clause, BSD-2-Clause, 0BSD / public domain, MIT, BSD-3-Clause, MIT, MIT | shared | |
| pillow | FreeType | as built | FreeType Licence (FTL), chosen over its GPL-2.0 option | shared | |
| pillow | HarfBuzz, lcms2 | as built | MIT, MIT | shared | |
| pillow | Aileron Regular font (Pillow's default font, embedded in `ImageFont`) | — | CC0-1.0 (dot-colon) | data | used by the training renderer for headings |
| shapely | **GEOS** (libgeos, libgeos_c) | 3.13.1 | **LGPL-2.1** | shared, unmodified | exception: see the top of this file. Used for one area/length call; replaceable by a few lines of numpy. |
| onnxruntime | onnxruntime itself (`onnxruntime_pybind11_state`, 30 MB; `libonnxruntime_providers_shared`) | 1.30.0 | MIT | — | |
| onnxruntime | Eigen and the other libraries in `ThirdPartyNotices.txt` (abseil, protobuf, …) | as built | Eigen: **MPL-2.0**; others permissive | static, unmodified | MPL-2.0 is file-level: unmodified Eigen files compiled into a larger program are allowed (MPL-2.0 §3.3); its source is public. Recorded because our general rule prefers dynamic linking. |
| cryptography | OpenSSL (in `_rust.abi3.so`) | 4.0.3 | Apache-2.0 | static | current, supported |
| pyclipper | Clipper | 6.4.2 | BSL-1.0 | static | |

**The slim OpenCV build** (planned before the pilot: `-DWITH_FFMPEG=OFF -DWITH_IPP=OFF -DWITH_ITT=OFF`, only the core, imgproc and imgcodecs modules) removes FFmpeg, OpenSSL 1.1.1k, Intel IPP, ittnotify, OpenBLAS, libgfortran and libquadmath, and brings the bundle under Vercel's 225 MB standard size.

### OCR models (inside the rapidocr 3.9.2 wheel)
| File | SHA-256 | Licence | Use |
|---|---|---|---|
| `PP-OCRv6_det_small.onnx` (text detection) | `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f` | Apache-2.0 (copyright Baidu / PaddleOCR; RapidOCR's `MODEL_LICENSES.md`, which the wheel does not include: attribution in `worker/NOTICE`) | Finds the text lines |
| `PP-OCRv6_rec_small.onnx` (text recognition, 50 languages, French accents) | `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884` | Apache-2.0 (same) | Reads them |
| `ch_ppocr_mobile_v2.0_cls_mobile.onnx` (line orientation) | `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c` | Apache-2.0 (same) | Loaded by RapidOCR's constructor, **never run** (it flips code lines on degraded photos) |

- **Pinned by** `worker/verify_worker/ocr.py`: each file's SHA-256 is checked when the models load, and the paths are set explicitly so that RapidOCR never downloads a model (by default it would fetch missing ones from modelscope.cn).
- **Provenance caveat (for the lawyer):** Baidu does not publish the training data of the PP-OCR models, as with Doubango's MRZ model. The risk is lower for printed text than for faces, but it is recorded here.

### Test material of the worker (never deployed)
| Component | Licence | Use |
|---|---|---|
| **Inter font** 4.0 (`scripts/fonts/inter/Inter-Regular.ttf`, `Inter-Bold.ttf`), The Inter Project Authors, release `v4.0` (`Inter-4.0.zip`, SHA-256 `ff970a5d4561a04f102a7cb781adbd6ac4e9b6c460914c7a101f15acb7f7d1a4`) | SIL Open Font License 1.1, no Reserved Font Name (`OFL.txt`) | Prints the fictitious specimen documents. Details and file checksums in `scripts/fonts/inter/README.md`. |
| Specimen photos, `e2e/fixtures/specimens/` (29 photos and `manifest.json`; M4 added an expired passport and one whose print disagrees with its code lines) | Ours, generated by `scripts/make-specimens.py` | Fictitious SPECIMEN documents with obviously fake data, drawn in Inter and OCR-B. Nothing in them is a real person or document. |

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
| **Provenance caveat** | Its authors trained it on MRZ images collected from the web, which may include real people's documents. The licence covers the model file, not that training data. **It stays for every session but test sessions until our own model also passes G4** (the PM's photos; see below and `M4_SPEC.md`). |

### Our own reading model (`mrz-2`, since M4: test sessions only)
| | |
|---|---|
| What | `mrz.traineddata`, a Tesseract LSTM integer model reading MRZ characters, made by us: run 2 of `training/mrz/` |
| Made from | Google's `eng` model from **tessdata_best** (commit `e12c65a`, SHA-256 `8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba`), Apache-2.0: its output layer cut down to our 37 characters, then trained further (best checkpoint at 18,300 of 30,000 iterations, learning rate 0.0001) on about 80,000 **fictitious** code lines we drew ourselves (OCR-B and Aileron, see "MRZ model training"). No real document was used. |
| Licence | Apache-2.0 (a derivative of `eng`). The served notice (`apps/rider/public/ocr/NOTICE.txt`, section 3b) carries the statement of our changes; the Apache-2.0 text is its section 5. |
| Our copy | `apps/rider/public/ocr/mrz-2/mrz.traineddata.gz`, served gzipped (1.30 MB), cache key `ocr-mrz-2` |
| SHA-256 of the raw (uncompressed) file | `575e55e501516f2a160d556ef7d8fd481d0a843bbab9ccbfd5b5110a2a25747b` |
| SHA-256 of the gzipped file | `bbcd6a33477ea4f1ed1bc42b0846ea764d5849c83653206b3544e8a5b7b6cc18` |
| Pinned by | `apps/rider/src/mrz/model.test.ts` (both checksums, and its notice section) |
| Provenance record | `training/mrz/results/run2-finetune-model.json` (run settings, repository commit, checksums), `run2-finetune-gates.md` (the automated gates, all passed), `run2-finetune-training-log.txt`; the inputs in `training/mrz/inputs.json` |
| **For the lawyer** | Google trained `eng` on synthetic renders in about 4,500 fonts; langdata_lstm's `eng/okfonts.txt` lists 4,567, mostly commercial (1,970 "Std" and 474 "MT" entries), and the training text is undocumented. The weights are Apache-2.0; whether a model derived from them may be used commercially without further question is on the lawyer's list. Run 1 (from zero, no such question) failed the gates. |
| Pending | **G4**, the PM's own test-session photos, before it becomes the default for every session. |

The generic English Tesseract model was tried and is not used: it misread about 45% of MRZ characters.

### Test material (never shipped to riders)
| Component | Licence | Use |
|---|---|---|
| **OCR-B font** `scripts/fonts/ocr-b/OCRB.otf`, version 0.3.1 of Matthew Skala's "OCR fonts" package (tsukurimashou.org/ocr.php.en, file `ocr-0.3.1.zip`), based on Norbert Schwarz's METAFONT OCR-B. SHA-256 `87c8d5bfd541d28023d2ba3383169c49f565e10d487ebb027ea0d735ef558707`. | Free use without limitation. Schwarz's notice: "You may freely use, modify and/or distribute this file, without limitation." Skala: "I make no copyright claim on these fonts myself." | **Tests and training renders; the font itself is never shipped.** Draws the MRZ test images (M2), the code lines of the worker's specimen documents and every code line of the MRZ model's training data and benchmarks (M3). Only the rendered images are used. Details in `scripts/fonts/ocr-b/README.md`. |
| MRZ test images, `e2e/fixtures/mrz/` | Ours, generated by `scripts/make-mrz-fixtures.py` (Pillow, dev only) | Fictitious SPECIMEN documents of ICAO's made-up state "UTO", with obviously fake names, drawn in Skala's OCR-B. Nothing in them is a real person or document. Since M3 the same script also draws the MRZ model's G2/G3 benchmark. |
| ICAO 9303 specimen lines ("Utopia" passport `L898902C3`, ID card `D23145890`) | Published examples from the ICAO standard; fictitious | Unit tests, database tests and dashboard previews |

**Deliberately left out:** the OCR-A font from the same package, because its licence restricts commercial use. The MRZ is printed in OCR-B, so OCR-A is not needed.

## MRZ model training (M3): tools and inputs (never shipped)

`training/mrz/` trains our own MRZ model (`M3_SPEC.md`, `training/mrz/README.md`). It runs on a training machine only, never in CI and never on a server. What we would ship is its **output**, a model file of our own; none of the code below ends up in it. Every download is pinned by commit and SHA-256 in `training/mrz/inputs.json`, and `bin/00-setup.sh` refuses a file that does not match.

| Input or tool | Version / pin | Licence | Use |
|---|---|---|---|
| tesstrain (Makefile and list helpers) | commit `405346a` (2025-04-18) | Apache-2.0 | Builds the unicharset, lists, proto model and `.lstmf` files. Its `requirements.txt` is **not** installed (python-bidi is LGPL and only for right-to-left scripts). |
| langdata_lstm `radical-stroke.txt`, `Latin.unicharset` | commit `07930fd`; SHA-256 `9b441331…1b89`, `2c534487…e128` | Apache-2.0 | Character property tables read by the training tools |
| tessdata_fast `eng.traineddata` | commit `8741641`; SHA-256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` | Apache-2.0 | Only lets native Tesseract find the text lines when cutting training lines; the text it reads is thrown away. Not a training input of the model. |
| tessdata_best `eng.traineddata` (Google) | commit `e12c65a`; SHA-256 `8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba` | Apache-2.0 | **Fallback run 2 only** (fine-tune), fetched only on request. **For the lawyer:** Google trained it on synthetic renders in about 4,500 fonts; langdata_lstm's `eng/okfonts.txt` lists 4,567, mostly commercial (1,970 "Std" and 474 "MT" entries), and the training text is undocumented. A fine-tuned model must carry the Apache-2.0 text and a statement that we changed Google's weights. |
| Pillow (with its bundled FreeType, used under the FreeType Licence, and the Aileron font, CC0) and NumPy | 12.3.0 and 2.5.3, PyPI wheels from `training/mrz/uv.lock` | MIT-CMU; BSD-3-Clause AND others (as in the worker) | Draw the fictitious training documents and lines. **Never Ubuntu's `python3-pil`**, which links libimagequant (GPL-3.0+) and libjbig (GPL-2+). |
| OCR-B font, Aileron Regular | as above | as above | Code lines; headings and fields of the training documents |
| **Build tools only:** Ubuntu 24.04 `tesseract-ocr` 5.3.4-1build5 and its training tools (`lstmtraining`, `lstmeval`, `combine_tessdata`, `combine_lang_model`, `unicharset_extractor`) | 5.3.4-1build5 | Apache-2.0, but through Leptonica and libtiff they load **libjbig0 (GPL-2+)**, LGPL libraries (pango, cairo, glib, fribidi, gnutls, nettle, libidn2 and others) and the GCC runtime (GPL-3 with its exception) | Run on the training machine; they produce data files and the model's weights. None of their code is in the model, and nothing reaches a rider. The phone runs the model in tesseract.js-core (table above). |
| **Build tools only:** GNU Make, bash | 4.2+; as installed | GPL-3.0+ | Run tesstrain's Makefile |
| Doubango `mrz.traineddata` | as above | BSD-3-Clause | The gates' baseline only; never a training input |

## Planned (to be verified and recorded when added)

| Component | Milestone | Expected licence | Status / caveat |
|---|---|---|---|
| Our own MRZ reading model for **every** session (replaces Doubango's) | After G4 | Apache-2.0 (run 2, derived from `eng`) | Shipped for test sessions since M4 (see "MRZ reading"); the lawyer's review of `eng`'s provenance is pending. |
| Slim OpenCV build (from source, no FFmpeg, IPP, ITT or OpenBLAS) | Before the pilot (M14) | Apache-2.0 | Removes every exception listed for the OpenCV wheel |
| omegaconf 2.4.0 (drops antlr4), rapidocr 3.10.0 (headless OpenCV by default) | When at least two weeks old (after 2026-10-23 and 2026-10-22) | BSD-3-Clause, Apache-2.0 | Never install `rapidocr[rtl]`: it pulls python-bidi (LGPL) |
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
| `fastmrz` (Python), `readmrz` | AGPL-3.0; depends on `mrz` | Same reason |
| **Tesseract on the server** (Debian/Ubuntu packages, or the `tesserocr` wheel) | Apache-2.0, but they bring **libjbig (GPL-2+)**; `tesserocr` also requires cysignals (LGPL-3.0+) | The server reads the code lines with RapidOCR instead |
| `opencv-python` (GUI build) | Apache-2.0, but bundles **Qt 5 (LGPL-3.0)** | The headless build is used; the override keeps the GUI build out |
| Ubuntu `python3-pil` | Links libimagequant (GPL-3.0+) and libjbig (GPL-2+) | The PyPI Pillow wheel is used |
| python-bidi (tesstrain's `requirements.txt`, `rapidocr[rtl]`) | LGPL | Only for right-to-left scripts |
| psycopg 3 | LGPL-3.0-only | Not needed: the worker never talks to the database |
| EasyOCR | Apache-2.0 code; its detector weights have no licence | Not used |
| OCR-A font from Skala's "OCR fonts" package | Non-commercial restriction | Not needed: the MRZ uses OCR-B |
| MinIO | AGPL-3.0 | Supabase Storage is used instead |
| Redis ≥ 7.4 | RSAL/SSPL (AGPL option from 8.0) | Not needed: the jobs live in Postgres |
| HashiCorp Vault | BUSL-1.1 | Supabase Vault is used instead (OpenBao if we self-host) |

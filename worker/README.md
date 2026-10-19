# AI worker (M3)

The server side of the photo checks. For each photo a rider uploads, the worker:

1. **re-checks the photo's quality**, with the same maths as the rider's phone (`packages/capture`, ported to numpy);
2. **re-reads the code lines (MRZ)** from the image, and sends the candidate lines to Supabase, where the same corrector and parser as on the phone check them;
3. **gathers evidence of the document type**: which way up the photo reads, keyword counts (kept with the job, never shown to staff: on a passport they would tell a Cameroonian one from a foreign one), whether a QR code is visible;
4. **reads a few printed fields**: names, the document number, and the birth, expiry and issue dates (since M4 on documents with code lines too, so that the server can compare them with the code lines).

The worker decides nothing: the Supabase Edge Function `worker` takes every decision from this evidence. The worker never stores anything. Photos stay in memory, and raw OCR text never leaves the process.

## How it runs

```
Supabase (flow function, or the pg_cron sweep) ── POST, empty body ──► Vercel: /api/process   ("the doorbell")
Vercel worker ── POST /claim  (signed) ──► Supabase worker function ── next job, or 204
              ── POST /image  (signed) ──►                          ── the JPEG bytes (410: gone)
              ── POST /result (signed) ──►                          ── recorded / already_done
```

- **A ring carries no authority and no data.** Anyone may ring. The worker then asks for work with requests signed by its own Ed25519 key, so nothing on the Vercel side can be replayed against Supabase. Vercel's firewall rate-limits rings (sized in `docs/M3_SPEC.md`, "Deploy notes"). A ring the firewall refuses (429) is not taken as reached: the `flow` function tries it once more after a short pause, then reports the photo unchecked.
- **The loop.** Each ring claims and processes jobs until there are none left (204) or about 50 s have passed, then answers `{"ok": true}`. It answers `{"ok": false}` with status 500 when the worker is misconfigured or something unexpected failed. Nothing else is ever in a response. The models load only after the first successful claim, so a ring with no work costs almost nothing. A job whose bytes are not the uploaded JPEG, or whose claim is malformed (for example a photo over 1,600 px), is skipped, not the whole ring: its lease runs out, the sweep retries it, and after the last attempt staff see it unchecked.
- **Signatures** (`verify_worker/signing.py`): Ed25519 over
  `v1|confiance-verify/worker|<kid>|POST|<path>|<unix seconds>|<32 hex nonce>|<sha256 hex of the body>`.
  The signature and the key id go in the `x-worker-*` headers (`contract.ts`). The same vectors as the Edge Function's are tested (`supabase/functions/worker/signature.vectors.json`).
- **Bytes are checked before decoding.** The size and SHA-256 must match the claim, and only Pillow's JPEG decoder may open the photo. The longest side must be at most 1,600 px (the rider app's maximum) and the size must match the upload.
- **Logs** hold only event codes, exception class names and numbers, never a message, a body or anything read from a photo (`verify_worker/log.py`). Third-party loggers are set to ERROR.

## Layout

| Path | What it does |
|---|---|
| `api/process.py` | Vercel entry point: a standard-library `BaseHTTPRequestHandler` named `handler`. POST rings; every other method gets 405. |
| `verify_worker/runner.py` | One ring: claim, image, analyse, result, until 204 or the 50 s window closes. |
| `verify_worker/client.py` | Signed HTTP calls (standard-library `urllib`): no redirects, response sizes capped, the claim validated field by field. |
| `verify_worker/pipeline.py` | One job, from bytes to the `WorkerResultRequest` evidence. |
| `verify_worker/imaging.py` | Byte checks, JPEG-only decoding, the phone's gray formula, rotations. |
| `verify_worker/quality.py` | Port of `packages/capture`: card detection and confidence, the noise-free focus score (reported as `sharpness`, the value the phone compares with 5), glare, brightness. `tests/test_quality_parity.py` checks it gives exactly the TypeScript's numbers. |
| `verify_worker/ocr.py` | RapidOCR with the PP-OCRv6 models from the rapidocr wheel (paths set, SHA-256 checked). It maps Greek and Cyrillic look-alike letters back to Latin. |
| `verify_worker/classify.py` | Keyword groups, QR presence (detection only, never decoded), and the choice of rotation. |
| `verify_worker/mrz.py` | Picks the candidate code lines. It does not correct them: the Edge Function does. Candidates leave the worker, so a printed row in capitals (a parent's name, a bilingual title, even with a letter misread as a digit) must not pass as one: a row needs fillers, the birth/expiry pattern, or the start of line 1 with a filler or the number's right check digit, or with a digit while sitting directly above line 2. |
| `verify_worker/fields.py` | Reads the allowed printed fields, finding each value next to its French/English label. It parses dates in several formats and returns values in ASCII. |
| `verify_worker/contract.py` | The constants of `supabase/functions/_shared/contract.ts` the worker uses (a test keeps them in sync). |
| `NOTICE` | Licences and attributions of the packages whose wheels ship no licence text (rapidocr and its models, flatbuffers, antlr4). Deployed with the function; `tests/test_deploy_config.py` fails when a runtime package without licence text is missing from it. |

## Configuration (environment)

| Variable | What it is |
|---|---|
| `SUPABASE_WORKER_URL` | `https://<project-ref>.supabase.co/functions/v1/worker` |
| `SUPABASE_PUBLISHABLE_KEY` | The project's publishable key. It is public, and is sent as `apikey` as the web apps do. |
| `WORKER_KEY_ID` | The key's id, as stored in `worker_key.kid`. |
| `WORKER_SIGNING_KEY` | **Secret.** The 32-byte Ed25519 seed, in base64url without padding. The matching public key (`Signer.public_key_b64url()`) goes in `worker_key.public_key`. |
| `WORKER_OCR_THREADS` | Optional: ONNX Runtime threads (default 1, for Vercel's single vCPU). |

## Develop and test

```sh
cd worker
uv sync            # Python 3.12 and the locked dependencies (uv.lock, with hashes)
uv run pytest      # everything, including the real-OCR run on the specimens (about 2 minutes)
uv run pytest -m "not ocr"   # without the real models (seconds)
uv lock --check    # the lock matches pyproject.toml
```

- **Specimens.** The test photos are our own fictitious documents, marked SPECIMEN, in `e2e/fixtures/specimens/`. They are made by `scripts/make-specimens.py`, which also writes their `manifest.json` (expected type, code lines, fields). To change them, run `uv run python ../scripts/make-specimens.py` and commit the result. They test the plumbing; they cannot prove accuracy on real cards, because we drew the keywords ourselves.
- **Quality parity.** After a change to `packages/capture`'s maths or to the specimens, run `uv run python tests/tools/make_quality_reference.py` (it needs Node and the repo's `node_modules`) and commit `tests/fixtures/quality_reference.json`.
- **Against the real Edge Function.** Two tests run TypeScript from `supabase/functions` in Deno (`npx deno`, from the repo's dev dependencies, after `npm ci` at the root):
  - `test_specimens_ocr.py` runs the shared MRZ corrector and parser on the worker's candidates, and (M4) the server's own consistency checks on whole documents (`tests/tools/server_consistency.ts`): the expired passport and the one whose print disagrees with its code lines are flagged, the others are not;
  - `test_edge_function.py` serves the real worker function (`tests/tools/server_worker.ts`, with in-memory stand-ins for the database and storage) and runs the worker's own client against it. The function verifies the Python signatures (the shared test key, at the current time) and refuses unsigned, replayed, tampered, mis-routed, stale and foreign-key requests. A full ring on real specimens must pass the function's strict validation and give back exactly the printed code lines and the `unreadable` / `no_document` verdicts.

  Without Deno these tests are skipped; CI sets `WORKER_REQUIRE_DENO=1`, which makes them fail instead.
- **Licences.** CI checks the production environment (`uv sync --no-dev`) against the reviewed table `scripts/python-licenses.toml`: every package at its version, and every native library, extension module and model file in it. Locally: `UV_PROJECT_ENVIRONMENT=/tmp/worker-prod uv sync --frozen --no-dev && uv run python ../scripts/check-python-licenses.py --prod-python /tmp/worker-prod/bin/python`. An upgrade fails the check until the table (and `docs/LICENSES.md`) is updated.
- **Timing** per image is printed at the end of a run and is never asserted.

## Deploy (Vercel project `confiance-verify-worker`)

`vercel.json` sets the Paris region (`cdg1`), a 120 s maximum duration, no Git deployments, bundling every package (below), and keeps tests out of the function bundle (`.vercelignore` also keeps them out of the upload). Vercel installs from `uv.lock` (`uv sync --frozen`). The override in `pyproject.toml` keeps the GUI OpenCV (Qt, LGPL-3.0) out, and the pinned setuptools builds the one source-only package (antlr4 4.9.3).

**Bundle size.** The installed runtime packages measure **about 377 MB (359 MiB)**, under Vercel's 500 MB Python limit. OpenCV alone is 160 MiB, ONNX Runtime 61 MiB, NumPy 52 MiB and the models 31 MiB. That is above Vercel's 225 MB standard function size, though. Above it, Vercel's Python builder would by default bundle only what fits and **install the remaining packages from PyPI on each cold start** (into `/tmp`), possibly including the rapidocr wheel that carries the models. `vercel.json` therefore sets `VERCEL_PYTHON_DISABLE_RUNTIME_INSTALL=1` as a build variable: everything is bundled, nothing is downloaded at run time (`tests/test_deploy_config.py` keeps it set). At deploy, check that it took effect: the build log must **not** say "Bundle size … exceeds the standard size; optimizing dependencies", and the function's files must not contain `_uv/_runtime_config.json`. If Vercel refuses a bundle that large on Hobby, do not remove the flag: bring the bundle under 225 MB first with the slim OpenCV build planned in `docs/PLAN.md`.

**Speed** (this development machine, one thread, 1,280 px specimen photos): about **3 s of CPU per photo** read the right way up first (median 3.1 s). It is **5–9 s** when a second rotation must be read (a portrait card turned the other way, an upside-down page, an old card declared as a new one). Loading the models takes under a second.

## Model choice

The rapidocr 3.9.2 wheel ships one detection/recognition pair: **PP-OCRv6 det small + rec small**. It also ships the legacy line-orientation classifier, which RapidOCR's constructor loads but which is never run. The faster "tiny" models are not in the wheel, and nothing is downloaded at run time, so the worker uses the small pair. Detection runs on the photo reduced to a 960 px longest side. Recognition reads from the full-resolution photo.

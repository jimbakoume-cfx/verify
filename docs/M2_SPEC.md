# M2 — MRZ reading: design spec

Goal (from `PLAN.md`): read the MRZ on the phone, parse the passport (TD3) and the new CNI (TD1), and verify the check digits on the phone and again on the server. The PM's test: scan a passport and see the fields with ✅/❌ for each check digit.

**Words used here:**
- **MRZ, or "code lines":** the 2 or 3 lines of capital letters, digits and `<<<` printed at the bottom of a passport's photo page or on the back of an ID card. Their layout is set by the international standard ICAO 9303.
- **TD1:** the ID-card layout, 3 lines of 30 characters. **TD3:** the passport layout, 2 lines of 44 characters.
- **Check digit:** a digit printed after a field (document number, birth date, expiry date), computed from that field's characters. If one character is misread, the check digit almost always stops matching. A last "composite" check digit covers most of the code lines at once.
- **OCR:** reading text from an image.

The HTTP contract (types, limits, error codes) is still `supabase/functions/_shared/contract.ts`, the single source of truth. Web apps import it via `@verify/shared`. The MRZ parser is `supabase/functions/_shared/mrz.ts`: the same file runs on the phone, in the Edge Functions and on the dashboard, so all three always agree.

## Decisions taken by the PM (2026-10-13)
1. **Two CNI choices.** "New CNI (2025)" has code lines; "Old CNI" (2017 model) has none, so nothing is read for it.
2. **Unreadable code lines.** The rider gets tips and retakes the photo. After 3 failed tries, a "Continue anyway" button appears and the case is flagged for staff.
3. **The rider sees only "Code lines read ✓".** The fields and the ✅/❌ for each check digit appear only in the debug view (`?debug=1`) and on the dashboard.
4. **Reading model.** DoubangoTelecom's `mrz.traineddata` (BSD-3-Clause) for now. It was trained by its authors on MRZ images collected from the web; we replace it with our own model in M3 (see `LICENSES.md`).

## End-to-end test flow (what the PM does)
1. On the dashboard, press **New test session**. Two QR codes appear: the rider link and the **Debug link** (the same link with `?debug=1`).
2. Scan the **Debug link** with the phone. Consent, then choose **Passport** or **New national ID card (2025)**.
3. Photograph the side that carries the code lines (the passport's photo page; the new CNI's back). A screen says "Reading the code lines…" for a few seconds. If the reader is still getting ready, it shows that progress instead: the first time, this downloads about 2.8 MB, then kept on the phone.
4. The review screen says **Code lines read ✓**. In debug mode, a panel below lists every check digit with ✅/❌ and the fields read.
5. Send the photos. On the dashboard, open the case: the **Code lines (MRZ)** section shows the server's own ✅/❌. **Show data read** reveals the fields for 60 seconds, and the view is written to the audit log.

## Which documents carry code lines
`MRZ_EXPECTATION` in `contract.ts`:

| Document | Side | Format | Required |
|---|---|---|---|
| Passport | front (photo page) | TD3 | yes |
| New CNI (`cni_biometric`) | back | TD1 | yes |
| Residence permit | back | TD1 | **no**: read if present, never asks for a retake |
| Old CNI (`cni_legacy`), driving licence, voter card | — | — | no code lines; nothing is read |

**Assumption to confirm with a real card:** the new CNI carries a standard 3-line TD1 MRZ on its back. If it does not, this is a one-line change in `MRZ_EXPECTATION`.

`DECLARED_DOCUMENTS` replaces M1's `cni` with `cni_biometric` and `cni_legacy` (the names of the existing `document_type` enum). `MRZ_TRIES_BEFORE_OVERRIDE = 3`.

## Rider app (`apps/rider`)

### Document choice
Two CNI entries: **Nouvelle CNI (2025)** with the hint "3 lignes de <<< au verso", and **Ancienne CNI** with "pas de lignes <<< au verso". In English: "New national ID card (2025)" ("3 lines of <<< on the back") and "Old national ID card" ("no <<< lines on the back").

### Loading the reader
- The reader is downloaded only when it is needed, so the first page stays the same size and riders with another document never fetch it:
  - the reader code (`src/mrz/lazyReader.ts` loads `reader.ts`, a 15 KB chunk) when a document with code lines is chosen;
  - then tesseract.js (its own chunk), its worker script, the WebAssembly engine (about 1.46 MB compressed) and the model (1.31 MB). That makes about 2.8 MB the first time.
- `warmUp()` starts this download in the background as soon as such a document is chosen, and again when that side's camera opens in case it failed.
- Every file comes from our own site, under `/ocr/` (never from a CDN):
  - `/ocr/7.0.0/worker.min.js` and the three `tesseract-core*-lstm.wasm.js` engine variants. A small Vite plugin (`apps/rider/vite.config.ts`) copies them from `node_modules` at build time and serves them in development. The build fails if the installed tesseract.js version does not match the folder name in `OCR_ASSETS`.
  - `/ocr/mrz-1/mrz.traineddata.gz`, the model, committed in `apps/rider/public/ocr/`. A test pins its SHA-256 (`src/mrz/model.test.ts`).
- The model is kept in the browser's IndexedDB under the key prefix `ocr-mrz-1`. The engine files are kept by the browser's normal cache.
- **If the reader cannot run, the rider is never blocked.** This covers an old browser without WebAssembly, iOS Lockdown Mode, a blocked file, a failed download or a timeout. The result is then "unavailable": no tick, no warning, and the server is told why.
  - Before starting the engine, the app compiles a tiny 8-byte WebAssembly module. Where WebAssembly is forbidden this fails at once, instead of after the 60-second start-up timeout.
  - Timeouts: 30 s for the reader code (a stalled download of the chunk is then tried again on the next warm-up or read), 60 s to download and start the engine, 20 s per read. On a timeout or a cancel the engine is stopped and a fresh one starts on the next read. After 2 failed starts the app stops trying for that visit.
  - A read cancelled with Retake or Back returns at once, even while the reader code is still downloading.

### Reading pipeline
1. **Full-quality input.** For the side that carries the code lines, the camera (`src/capture/still.ts`) keeps a full-resolution grayscale copy of the photo, made before JPEG compression. On a passport held upright the characters are only about 15 pixels tall, and compression artefacts at that size cost characters. The copy is dropped as soon as it has been read. If the phone cannot spare the memory, there is no copy and the read counts as "unavailable".
2. **Find the code lines** (`packages/capture/src/mrz/locate.ts`, pure TypeScript):
   - mark ink with a local threshold (darker than the paper around it), which survives shadows and uneven light;
   - keep only short ink strokes with paper on both sides, which drops card edges and shadow borders;
   - find the tilt (up to 6°);
   - pick the lowest group of 3 (TD1) or 2 (TD3) evenly spaced lines that start and end at the same place;
   - if nothing fits, fall back to a fixed crop of the bottom of the photo.
3. **Prepare** (`prepare.ts`):
   - straighten the band and stretch its contrast;
   - scale it so characters are 32 px tall (at most 2200 px wide);
   - turn it into pure black and white (local threshold);
   - add a 16 px white border;
   - hand it to the engine as a PGM image, a simple uncompressed grayscale format that Node and the browser encode byte for byte the same way.
4. **OCR** (`src/mrz/ocrEngine.ts`):
   - tesseract.js 7.0.0, engine mode 1 (the neural-network reader), with the MRZ model;
   - no dictionaries;
   - only the characters `A–Z`, `0–9` and `<` allowed;
   - page segmentation mode 6 ("one block of text").
5. **Correct** (`src/mrz/correct.ts`):
   - clean the lines (spaces out, `«` to `<`);
   - turn a K or X back into `<` inside runs of fillers (at least two real `<` on each side, so the unspecified nationality `XXX<<<` stays whole), except one that may be a name: right after a word of letters, or after one or two `<` (an initial, `ANNA<K`, or a one-letter given name, `DOE<<K`). No check digit covers the names, so the correction must not drop a real letter there;
   - fix lines that are 1 or 2 characters too long or short at their longest filler run;
   - then, with the fields known, turn every K or X in the run of fillers that ends an optional-data field (the TD3 personal number, the two TD1 optional-data fields) back into `<`, even at the very start of an empty field. No names live there. This matters most for K: it counts 0 in every check digit, like `<`, so a K left there would pass as data that is not on the document. A K or X written right after other data (`ZE184226BK<<<`) is left alone;
   - swap look-alike characters only where the field type decides: dates and check digits are digits, names and country codes are letters (O/0, I/1, B/8, S/5, Z/2, G/6, D/0, Q/0);
   - repair the document number only with evidence (see "Changes from the approved plan").

   Corrections are counted (at most 90).
6. **Parse and check** with `parseMrz` from `@verify/shared`.
7. **Up to three passes.**
   - Pass 1: the band as located.
   - Pass 2: if no code lines came out, the photo turned 180° (a card held upside down).
   - Pass 3: if the result is still not valid, the same band with a single global threshold (Otsu) instead of the local one.

   Each pass only counts when its own check digits say so, so extra passes cannot make wrong lines look valid. The two readings of the same band serve as evidence for each other's document-number repair.

Result (`MrzReadResult` in `src/mrz/types.ts`):

| Status | Meaning |
|---|---|
| `valid` | complete code lines of the expected format, every check digit right |
| `invalid` | complete code lines, but a check digit is wrong |
| `not_found` | no complete code lines of the expected format |
| `unavailable` | the reader could not run. Never blocks. |

Speed measured in desktop Chromium against the built site: the first read takes 1.2–1.9 s including the engine start, later passes about 0.4 s each. Phones are slower.

### Screens and rules (`src/flow/machine.ts`)
- **Reading screen** (`{name: "reading", side}`). It comes after the photo of the side that carries the code lines and says "Reading the code lines…". While the engine's first start-up on the page is still running, it shows "Getting the reader ready" instead, with "the first time, this can take up to a minute" (the first time it downloads the files; later visits read them from the cache), a progress bar and its percent. The text is a polite live region, so screen readers announce it once; the percent, which changes several times a second, is only in the progress bar (`aria-valuenow`) and in a figure beside it hidden from screen readers (`Reading.test.ts`). tesseract.js reports only the start and end of each download, so between those the bar moves on with time, slowing down, and never completes a stage by itself. A restart after a cancelled or timed-out read shows no progress: its files are cached. Its Retake button, like the phone's Back button, stops reading and reopens the camera.
- **Stale results are ignored.** Each result is tied to its photo, so a result for a photo that was retaken or abandoned in the meantime changes nothing.
- **Review screen:**
  - Valid: **Code lines read ✓**. That is all the rider learns.
  - Required code lines not read (`invalid` or `not_found`): a warning with three tips (all the `<<<` lines whole and sharp; no glare on them; closer and steady). **Retake** becomes the main button.
  - After **3 failed tries** on that side, **Continue anyway** appears. The server will flag the case.
  - Optional code lines (residence permit) that were not read, and an "unavailable" reader: nothing is shown, and the photo can be used.
- **Two independent gates.** A photo can be used only when both the M1 blur/glare check and the code-line check allow it. A photo below the server's minimum resolution is not read, does not count as a try, and can only be retaken.
- **Counters belong to the document.** The tries are counted per side. Choosing another document resets them; choosing the same one again keeps them.

### Debug panel (`?debug=1`, `src/screens/MrzDebug.tsx`)
For the side with code lines it shows:
- the status and format;
- the character height measured on the photo (to calibrate the reader from real phones);
- the reading time, the number of characters corrected, whether the photo was turned, and the try number;
- ✅/❌ for each check digit, and whether the document code fits;
- the parsed fields;
- the corrected lines and the raw OCR text, in monospace.

Nothing from it is uploaded or logged. The panel is marked `translate="no"` (and `notranslate`), so the browser's page translation never sends it to an online service: a test session made from a French dashboard and opened on an English phone would otherwise invite Chrome to translate the page.

### Report to the server (`src/flow/upload.ts`)
- After the photo of that side is confirmed (`POST /flow/captures` returns its `captureId`), the phone sends `POST /flow/mrz` once:
  - `result: "read"` with the lines, the corrections and the time, whenever complete lines were read, **even with a wrong check digit**, so staff can compare them with the photo;
  - otherwise `result: "unreadable"` with the reason `not_found` or `reader_unavailable`.

  The try number goes as `attempts`, and the engine name as `engine` (`tesseract.js-7.0.0/mrz-1`). Numbers are rounded and clamped to `MRZ_REPORT_LIMITS`. The phone's own verdict is never sent.
- **The report is best effort. It never fails the upload and never holds back the submit.**
  - On a network error or a server error (5xx) it is tried up to 3 times with backoff, and once more before the submit on the next "Try again".
  - A lasting refusal (4xx) is dropped and noted in the browser console with its error code only.
  - A report still missing when the submit succeeds is dropped; staff then see "Not received".
- The upload progress counts the report as one more step for that photo.

### Hosting (`public/_headers`, `public/_redirects`, `vercel.json`)
- **Content Security Policy** (CSP, the browser rule that says what the page may run): `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`.
  - `'wasm-unsafe-eval'` allows compiling WebAssembly only. Running JavaScript from text (`eval`) stays blocked.
  - The worker script is loaded from its URL (`workerBlobURL: false`), so no `blob:` workers are needed.
  - The dashboard's CSP is unchanged.
- **`/ocr/*`** is sent with `Cache-Control: public, max-age=31536000, immutable`. The folders carry a version (`7.0.0`, `mrz-1`), so a new engine or model gets a new path and phones fetch it fresh.
- **A missing `/ocr/` file is a real 404, never the app page.** Otherwise the app's HTML would be cached for a year in place of a script.
  - Vercel: the rewrite to `index.html` skips `assets/` and `ocr/`.
  - Netlify: `/ocr/* /404.html 404` comes before the app rule.
- `src/hosting.test.ts` checks that the Netlify and Vercel files give the same headers on 10 sample paths, and pins the rewrite and the order of the 404 rules.
- The preview server (`vite preview`, used by the browser tests) applies the `_headers` rules path by path and the `_redirects` 404 rules, so the tests run under the real CSP.

## Edge Functions

### flow: `POST /flow/mrz` (`MrzReportRequest` → `{recorded: true}`)
Checks, in this order:
1. **Session:** the usual rules (`401 invalid_session`, `410 session_expired`, `409 already_submitted`).
2. **Declared document:** none declared → `409 document_type_required`. A document without code lines → `422 invalid_mrz`.
3. **Body** (at most 16 KB, as every route), `400 bad_request` for:
   - `captureId` not a UUID;
   - `result` not `read` or `unreadable`;
   - `attempts` not an integer from 1 to 20;
   - `engine` not 1–40 characters of letters, digits, `.`, `_`, `/` or `-`;
   - for `unreadable`: `reason` not `not_found` or `reader_unavailable`;
   - for `read`: `corrections` not an integer from 0 to 90, `ms` not an integer from 0 to 600 000, or `lines` not an array of strings.
4. **Lines** that are not exactly the expected format (3 × 30 or 2 × 44 characters, only `A–Z`, `0–9`, `<`) → `422 invalid_mrz`.
5. **Capture:** `404 not_found` when it is not a live (not erased) capture of this session. Another session's capture gets the same answer as a missing one.
6. **Side:** a capture of the wrong side → `422 invalid_mrz`.
7. **The server's own verdict.** The lines are parsed again with `parseMrz` and every check digit is recomputed.

   The outcome is **`pass`** only when all of these hold:
   - lines of the expected format were read;
   - every check digit is right (document number, birth date, expiry date, the personal number on a passport, and the composite);
   - both dates are real calendar dates;
   - the document code fits the declared document: `P` for a passport; `I`, `A` or `C` for a TD1 card.

   Anything else is **`flag`**, an unreadable MRZ included.
8. **Recording.** `flow_record_mrz` stores everything in one transaction (below) and answers `200 {recorded: true}`. A repeated report for the same photo also gets 200 and changes nothing. If the capture was erased in between, the answer is `404 not_found`.

The details stored with the check (`MrzCheckDetails` in `contract.ts`) are copied field by field, so nothing read from the document can slip in. They hold:
- the source and parser version (`mrz-v1`), and the capture id;
- `read` or `unreadable`, and the reason;
- the expected and received format;
- true/false for each check digit, the document code fit and the dates;
- the tries, corrections, engine name and reading time.

Messages never repeat a value sent, and the function never logs the lines.

### admin: `POST /admin/document-data {verificationId}` → `{items, expiresIn}`
Same access rules as `POST /admin/captures/view`:
- staff sign-in required (`401 unauthorized`, `403 forbidden` without an active staff profile);
- **admins get `403 forbidden_role`**: they have no routine access to ID data;
- `verificationId` not a UUID → `400 bad_request`;
- unknown case → `404 not_found`, and a reviewer who is not assigned to the case gets the same answer;
- the database writes the audit entry `document_data.view` **before** it decrypts anything, in the same transaction. Any failure there → `500 audit_failed`, and no data;
- the response is `no-store` (no browser or proxy keeps a copy).

`items` holds, latest first: `captureId`, `source: "mrz_phone"`, `format`, `lines` (the raw code lines) and `recordedAt`. `expiresIn` is 60 seconds, the same as photo links. A case with no stored lines returns an empty list, and that view is audited too.

## Database changes (migration `supabase/migrations/20261015000000_m2_mrz.sql`)
- **`verification.declared_document`** now allows `cni_biometric` and `cni_legacy` instead of `cni`. Rows declared `cni` before M2 (test sessions only) become `cni_legacy`, which has the same two sides. A rider tab still open on the M1 version gets `400` when it sends `cni`; that is acceptable in the test environment.
- **pgcrypto** (PostgreSQL's built-in encryption extension), installed in the `extensions` schema.
- **Encryption key** `document_data_key_v1`:
  - 32 random bytes generated by the database itself, kept in Supabase Vault (Supabase's store for secrets, which keeps them encrypted);
  - created only if missing;
  - nobody ever sees or handles the value: it never appears in code, chat, CI or a function's settings.
- **`extracted_document_data`:**
  - columns: `id`, `verification_id` and `capture_id` (both deleted with their parent), `source` (`mrz_phone`), `format` (`TD1`/`TD3`), `ciphertext`, `key_name`, `created_at`;
  - one row per photo and source;
  - `ciphertext` = `pgp_sym_encrypt` of the lines joined with a newline, under the Vault key, with the option `cipher-algo=aes256`: AES-256, salted, so the same lines never give the same bytes twice. (The option sits in a named constant in the migration: written right after the key's name, the CI secret scan would take it for a leaked key.)
  - `key_name` records which key encrypted the row, so a later key can be added without touching old rows;
  - Row Level Security on, **no policies**, and every right revoked from the `anon` and `authenticated` roles. Only the service role (the Edge Functions) can reach the table, and the dashboard roles cannot even see the ciphertext.
- **`check_result.capture_id`** (new, nullable, deleted with the photo), with a unique index on `(capture_id, check_name)`: one MRZ check per photo. `details` hold outcomes and counts only, because supervisors and admins can read this table.
- **`flow_record_mrz(p_verification, p_capture, p_lines, p_format, p_outcome, p_details)`:**
  - service role only; `SECURITY DEFINER` (runs with the owner's rights, to read the key), `search_path` empty.
  - Refuses lines that are not an MRZ of the given format; the handler has already checked them.
  - Locks the capture and returns `not_found` unless it is a live capture of this verification.
  - Returns `exists` when the photo already has its MRZ check, so a retried report changes nothing.
  - Otherwise, in one transaction: stores the encrypted lines (when some were read), writes the `check_result` row `mrz`, and writes the audit entry `mrz.record` with `{captureId, outcome, result}` only.
  - Fails loudly when the key is missing.
- **`staff_read_document_data(p_verification, p_actor, p_role)`:**
  - service role only, `SECURITY DEFINER`;
  - re-checks the access rule itself: active staff whose role matches, reviewer or supervisor only (never admin), and a reviewer only while the case is assigned to them. A mistake in the admin function therefore cannot reveal data;
  - fails loudly when a row's key is missing;
  - writes the audit entry `document_data.view` with `{role, items}` (the number of rows), then returns the decrypted rows, latest first, in the same transaction.
- **CI stub** (`supabase/tests/00_supabase_stub.sql`): the `extensions` schema, pgcrypto, and a minimal Vault with Supabase's names and signatures. It keeps secrets in plain text, which is acceptable only in a throwaway test database.

## Dashboard (`apps/dashboard`)
- **"Code lines (MRZ)" section** on the case page, between the summary and the photos.
  - It reads the `mrz` rows of `check_result` directly (Row Level Security decides who sees them), separately from the rest of the page. If that read fails, the section offers Retry and the rest of the case stays readable.
  - It says on which side the declared document carries its code lines, and that they are optional on a residence permit.
  - For each photo it shows:
    - a badge: Passed or To check;
    - ✅/❌ for: format as expected, each check digit (the personal number on passports only), document code fits, dates valid;
    - the format read and the format expected;
    - tries, corrections, reading time, reading engine and server check version.
  - It shows "Not readable on the phone" with the reason, or **"Not received"** when the latest photo of that side has no result.
  - A result for an older photo of the same side is marked "Earlier photo".
- **"Show data read"** (supervisors and the assigned reviewer):
  - calls `POST /admin/document-data`, then shows the fields (parsed in the browser with the shared `parseMrz`) and the raw lines in monospace;
  - the data lives in the page's memory only, with the same lifecycle as photos: it disappears after 60 s, on **Hide**, when leaving the case and on sign-out;
  - the block is marked `translate="no"`, so the browser's page translation never sends it to an online service;
  - admins see an explanation instead of the button.
- **Labels:** "Nouvelle CNI (2025)" / "New national ID card (2025)" and "Ancienne CNI" / "Old national ID card".
- **Test-session panel:** a second QR code, **Debug link** ("Lien de débogage"), with a copy button. It is the rider link with `?debug=1` added before the `#`.
- **Dev preview screens** (`/?screen=<name>`, add `&lang=en` for English): `case-data`, `case-flag`, `case-unreadable`, `case-not-received`, `case-no-mrz`, `case-reviewer`. The preview data uses only the ICAO "Utopia" specimens.

## Where MRZ data may appear (privacy rules)
| Place | MRZ lines or fields? |
|---|---|
| Rider's phone | In memory during the visit. The fields only in `?debug=1`, marked `translate="no"`. Never in Web Storage, never logged. |
| `POST /flow/mrz` request | Yes (HTTPS), on its way to the database |
| `flow` and `admin` Edge Function logs | Never: errors carry codes only |
| Database statement logs | Never: the project does not log query parameters (`log_statement=ddl`, `log_min_duration_statement=-1`, `log_parameter_max_length_on_error=0`, checked 2026-10-13) |
| `extracted_document_data` | Encrypted only |
| `check_result.details` | Never: outcomes and counts only |
| `audit_event` | Never: `mrz.record` holds `{captureId, outcome, result}`, `document_data.view` holds `{role, items}` |
| `POST /admin/document-data` response | Yes, `no-store`, after the audit entry is written |
| Dashboard | In memory for at most 60 s, `translate="no"` |
| OCR model cached on the phone (IndexedDB) | Never: it is the public model file only |

## Tests
- **Shared parser** (`_shared/mrz.test.ts`):
  - the ICAO 9303 Utopia specimens (TD3 `L898902C3`, TD1 `D23145890`);
  - the TD1 long-document-number rule;
  - a `<` as the check digit of an empty field;
  - impossible dates;
  - wrong lengths and characters.
- **Edge Functions** (vitest, in-memory fakes):
  - every rule of `POST /flow/mrz` in its order;
  - the pass/flag rule, and that the details carry no personal data;
  - repeated reports, erased and foreign captures, the wrong side;
  - `POST /admin/document-data` for every role, audit-then-read, `500 audit_failed` without data, and `no-store`;
  - a fixed message for every error code.

  A mutation check (rules broken on purpose, then restored) confirmed the tests catch such mistakes.
- **Database** (`supabase/tests/30_m2_test.sql`, over 100 assertions):
  - the `cni` conversion, by replaying the migration;
  - the ciphertext does not contain the plaintext, decrypts back to it, and does not decrypt with another key;
  - repeated, foreign, erased and unreadable reports, and a missing key;
  - nobody but the service role can read the table or call the functions;
  - staff refusals, and no data when the audit entry fails;
  - a report landing during a read: the audit entry counts exactly the rows returned (the read takes its rows once, for the count and the decryption);
  - audit order, deletions cascading, and the audit hash chain intact.

  `20_m1_test.sql` now also pins both new functions and the `check_result` columns the dashboard uses.
- **Pixel side** (`packages/capture/src/mrz/*.test.ts`): finding, preparing, thresholds and PGM on synthetic images, including tilt, shadows, blur, JPEG, dim light and faint ink.
- **Rider:**
  - correction, including a property test that a misread which is not a look-alike is never made valid, the unspecified nationality `XXX` kept whole, and K/X restored at every cell of empty optional data;
  - the engine's timeouts, restarts, start-up failures and start-up progress, including a start-up that times out while the engine code is still downloading (it never starts a second engine afterwards);
  - the reader's passes, with a fake engine;
  - lazy loading, including a stalled download of the reader code and a read cancelled during it;
  - the reading screen, tries, "Continue anyway" and stale results (`machine.test.ts`), and the reading screen's live text, which does not change with the percent (`Reading.test.ts`);
  - the report body, limits, retries and never blocking the submit (`upload.test.ts`);
  - the model's checksum, and the licence notices of every `/ocr/` file: every library of the licence register named in `NOTICE.txt`, the full Apache-2.0 text, the IJG sentence, and the worker's own licence file emitted next to it (`model.test.ts`);
  - the hosting rules (`hosting.test.ts`).
- **Real reading in Node** (`src/mrz/reader.fixtures.test.ts`, part of `npm test`, about 5 s): the real tesseract.js and the committed model read the committed test images through the same path the phone uses. The clean and degraded passport and card images must read as valid, the smudged card must not, and an upside-down card must still read.
- **Test images** (`scripts/make-mrz-fixtures.py`, dev only, needs Pillow):
  - fictitious SPECIMEN documents of ICAO's made-up state "UTO", drawn in the OCR-B font at realistic phone resolution, some blurred, noisy and JPEG-compressed;
  - 8 PGM images plus `manifest.json` in `e2e/fixtures/mrz` (2.2 MB). The script gives identical bytes every run.
- **Browser tests** (Playwright, `e2e/`), as planned:
  - the M1 card scenarios move to the old CNI;
  - new scenarios: new CNI (reading, ✓, `/flow/mrz` with valid lines); passport with every check digit ✅ in the debug panel; old CNI without a reading step; a smudged MRZ (tips, 3 failed tries, then Continue anyway; the report, `unreadable` or lines failing their check digits, is flagged); the engine file blocked (the rider goes on and `reader_unavailable` is sent).

  The fake camera pastes the test images' code lines onto the fake card and passport. `e2e/README.md` lists the exact scenarios.

## Changes from the approved plan
- **Document-number repair needs evidence.** The plan said: search the document number guided by its check digit. That alone is too weak:
  - one check digit lets about 1 wrong candidate in 10 through;
  - the composite check digit adds nothing here, because it starts with the document number, so a swap that fixes one also fixes the other;
  - in a simulation, a blind search turned about 24% of other misreads into a wrong number that passed both checks.

  So a look-alike swap in the number is accepted only when the reader's other pass actually read that character at that position. It must also be the only such swap and make both check digits right (at most 8 candidates; never G/6, which the check digit cannot tell apart). Without that evidence the check stays failed and the rider retakes. The server never trusts the phone's corrections anyway.
- **Finding the lines uses a local threshold, not Otsu.** On 32 rendered photos, the local threshold read 31–32, Otsu 24–27 and plain gray 22–25; Otsu loses characters under a shadow. Otsu stays as the reader's third pass.
- **A third reading pass** (the Otsu threshold) when the first result is not valid.
- **The reader's start-up progress is partly estimated, and does not say "first time only".** tesseract.js reports only the start and the end of each download, so the bar moves on with time in between, by stages weighted by their download size. The app cannot tell a first download from a start-up that reads cached files, so the text says that the first time can take up to a minute. A restart within the visit shows no progress at all.
- **The database functions re-check more than asked:**
  - `staff_read_document_data` re-checks the staff member's role and assignment;
  - `flow_record_mrz` refuses lines that are not an MRZ of the given format.
- **Test images** are slightly smaller than suggested, to stay near 2 MB in total.
- **Consent placeholder text** now mentions "the details read from its code lines (name, number, dates)". `CONSENT_VERSION` is now `placeholder-v1`, so each recorded consent names the wording shown; the lawyer's final text must cover this.

## Known limits
- **Not tested on real cards yet.** All test images are synthetic. Real cards add laminate glare, patterns printed behind the code lines and curved passport pages. The PM's phone test calibrates this; the debug panel shows the character height.
- **The server cannot see the image until M3.** It checks only that the lines are consistent: a forged MRZ with correct check digits passes M2's check. In Phase 1 every case is reviewed by a person anyway.
- **Finding and preparing the lines runs on the main thread:** about 20–60 ms per pass on a desktop, several times that on a low-end phone. The app pauses between steps so the reading screen can draw.
- **Worst case is slow:** a read that is not valid at once makes up to 3 passes, each with its own 20-second limit. Back cancels at any time.
- **Debug mode works on any session,** not only test sessions. It shows riders only what was read from the document they are holding, and the check-digit rules are public, so it tells a forger nothing new. Consider limiting it to test sessions before real riders.
- A rare race: a reviewer unassigned between the admin function's check and the database's re-check gets `500` instead of `404`.

## Deploy notes
1. Apply the migration **before** publishing the new dashboard: the dashboard reads `check_result.capture_id`. Until then its MRZ section shows an error with Retry, and the rest of the case page works.
2. Confirm the key exists **by name only**: `select name from vault.secrets;`. Never select the value.
3. The Supabase security advisor will report "RLS enabled, no policy" (INFO) for `extracted_document_data`. This is intended.
4. The functions were tested only against the CI Vault stub. Check on the live project that the migration owner (`postgres`) can read `vault.decrypted_secrets` and that a test report is stored and read back.
5. Redeploy the `flow` and `admin` Edge Functions (they include `_shared/mrz.ts`). Both call the database functions with supabase-js `.rpc()`, a POST, so the database runs them read-write. Keep it that way: the read function writes an audit row.
6. Build the rider app with `vite build`, which emits `/ocr/7.0.0/`. On the published site, check:
   - the CSP;
   - the `/ocr/*` cache header and content types;
   - that the engine file is served compressed (otherwise the first download is about 5.3 MB instead of 2.8 MB);
   - a 404 for a missing `/ocr/` file, and whether the host also sends the year-long cache header on that 404;
   - that the notices are served: `/ocr/NOTICE.txt` and the worker's `/ocr/7.0.0/worker.min.js.LICENSE.txt`;
   - that reading works in a real browser.

## Out of scope for M2
- **The server re-reads the code lines from the image itself:** M3 (AI worker).
- **Our own reading model,** trained on our data, replacing Doubango's: M3.
- **The signed QR code on the new CNI** (it could prove the printed data is genuine): an idea for M3/M4.
- **Expiry, age, and code lines vs printed text:** M4. M2 checks only that the dates are real dates.
- **Deciding the document type** from the image (the declared document is the rider's word): M3.
- **Key rotation and holding the key outside the database:** see the open items in `THREAT_MODEL.md`.
- **Duplicate ID numbers across riders:** question Q4 in `PLAN.md`.

# @verify/rider: rider verification flow (M1: ID capture, M2: MRZ reading, M3: server checks, M4: expired documents)

The page a rider opens from the Confiance app: consent → choose the document → photograph the
front (and back) → read the code lines (MRZ), for documents that have them → review → upload →
"Checking your photos…" (the server looks at them; a photo it cannot use is retaken) → done.
Riders never sign in; the session token arrives in the
link's fragment (`https://<site>/#s=<token>`), is kept for this tab only (`sessionStorage`,
`verify.session`), removed from the address bar at once, and sent only in the `x-session-token`
header. French is the default; every text is in `src/locales/{fr,en}.json`.

## Layout

| Path | What it does |
|------|--------------|
| `src/main.tsx` | Configures Supabase (no auth session), i18n, reads the token, renders the app. |
| `src/flow/machine.ts` | The flow as a pure reducer: screens, photos, MRZ tries, upload state, server retakes. |
| `src/flow/useFlow.ts` | Runs the reducer's side effects: API calls, reading the MRZ, uploads, waiting for the server's checks. |
| `src/flow/api.ts`, `errors.ts` | Typed client for the `flow` Edge Function (`contract.ts`); error codes with FR/EN text. |
| `src/flow/upload.ts`, `storage.ts`, `retry.ts`, `timeoutFetch.ts` | `uploadSides()`: upload per side (upload link, direct upload to the private bucket, confirmation, then the MRZ report for the side that has one); `submit()`, once the server has checked the photos. 3 tries with backoff, resumable; a stalled storage upload is aborted after 2 minutes and retried. |
| `src/flow/checks.ts` | Waits for the server's checks (`GET /flow/checks`): every 2 s, for at most 20 s; a slow or failing server never holds the rider up. |
| `src/mrz/` | Reading the MRZ on the phone. `types.ts`: the reader as the flow sees it. `lazyReader.ts`: loads the reader on first use (a failed or stalled download reads as "unavailable"). `reader.ts`, `ocrEngine.ts`: the pipeline (find the lines, prepare them, tesseract.js, fix look-alike characters with the shared `mrzCorrect.ts`, which the server runs too, parse). |
| `src/flow/history.ts`, `token.ts` | The phone's Back button steps back through the photos (camera ↔ review ↔ turn over) instead of leaving the page; a new `#s=` link opened in the same tab reloads with it. |
| `src/ErrorBoundary.tsx` | No blank page: a camera chunk that fails to load offers "Try again", any other render error a reload. |
| `src/capture/` | The camera screen (lazy-loaded chunk) and `analyzer.worker.ts` (separate worker chunk). |
| `src/screens/` | The other screens, including `Reading.tsx` ("Reading the code lines…"), `Checking.tsx` ("Checking your photos…") and `MrzDebug.tsx` (`?debug=1` only). |
| `src/dev/Preview.tsx` | Dev-only screen preview (removed from production builds). |

## Camera and quality checks

The quality engine is `packages/capture` (see its README for every check and threshold). The
camera screen draws the guide area of the video into a 480 px image about 8 times per second and
analyses it in a Web Worker (main thread if workers are unavailable). After 5 good frames in a row
the photo is taken automatically; a manual shutter appears after 8 s. The photo is cut from the
video (guide + 4%), at most 1600 px long, compressed under 300 KB with `canvas.toBlob` (no EXIF or
GPS), then re-checked: a blurry or glary manual photo is refused (after two refusals the rider may
keep it anyway, until thresholds are tuned on real phones). The camera is released on leaving the
screen, while the page is hidden, and right after each photo.

The photo must be at least 720 px on its long side (`CAPTURE_LIMITS.minLongSide`), or the server refuses it. When the camera
cannot give that for the guide (a phone held sideways, or a camera limited to 720p), the camera
screen says so before any photo ("hold your phone upright" / "use another phone") and does not
take the photo by itself; a photo taken anyway cannot be sent (the review offers only Retake).

## Code lines (MRZ)

Documents with code lines (`MRZ_EXPECTATION` in `contract.ts`): the passport (photo page, 2 lines
of 44, TD3), the new CNI (2025; 3 lines of 30 on the back, TD1) and the residence permit (back,
TD1, optional; the option reads "Residence permit or refugee card", and the server works out
which card it is). The old CNI has none, so it is never read; the document list tells the two CNIs
apart ("3 lines of <<< on the back").

- When such a document is chosen, the reader starts downloading in the background (about 2.8 MB
  the first time, then cached by the browser); it is loaded again on that side's camera if it failed.
- For that side, the camera keeps a full-resolution grayscale copy of the photo, made before JPEG
  compression (the characters are only about 15 px tall on a passport held upright). The copy is
  dropped as soon as it has been read.
- After the photo, "Reading the code lines…" shows for a few seconds (with the reader's start-up
  progress if it is still getting ready, which downloads it the first time). Back stops reading and opens the camera again; a result for a photo that was
  retaken meanwhile is ignored.
- The review says only "Code lines read ✓". When a required MRZ was not read (not found, or a
  check digit wrong), it shows tips and Retake comes first; after 3 failed tries on that side,
  "Continue anyway" appears and the server flags the case. Both this and the blur/glare refusal
  must allow a photo. An optional MRZ (residence permit) never asks for a retake, and a reader that
  cannot run on the phone (no WebAssembly, files not loaded, timeout) never blocks.
- After the photo is confirmed, the lines (or why none were read) go to `POST /flow/mrz`, once, with
  the number of tries. This is best effort: network and server errors are retried, also on the next
  "Try again", a lasting refusal is dropped, and it never holds back the submit (staff then see
  "not received"). The server re-checks every check digit itself.
- The lines are never logged or stored on the phone; the raw OCR text is shown only in `?debug=1`.
- **Two reading models (M4).** Test sessions (`FlowSession.isTest`) read with our own model,
  `mrz-2` (`public/ocr/mrz-2/`, cache key `ocr-mrz-2`); every other session with Doubango's `mrz-1`
  (`MRZ_MODELS` and `mrzModelFor` in `src/mrz/types.ts`). Only the chosen model is downloaded. The
  report's `engine` names the model that read (`tesseract.js-7.0.0/mrz-2`), and `?debug=1` shows it
  ("Model"). Both models are pinned by `src/mrz/model.test.ts` and read every fixture in
  `reader.fixtures.test.ts`.

## Server checks (M3)

After the photos are sent (and the MRZ report), the server's AI worker looks at each photo again.
The upload is split for this: `uploadSides()` sends the photos, then the "Checking your photos…"
screen waits, and `submit()` runs only after it.

- The screen asks `GET /flow/checks` at once, then every `CHECKS_POLL_MS` (2 s), for at most
  `CHECKS_WAIT_MS` (20 s). Each side is `pending`, `ok`, `retake` (with a reason) or `unchecked`.
- Every side `ok` or `unchecked`: the case is submitted. Out of time, an error, or an answer that
  makes no sense: the case is submitted too, with nothing shown to the rider (staff review it). A
  network or server error is asked again while there is time.
- `retake`: the photo of that side is dropped (from the phone and from what counts as sent) and its
  camera opens again at once, even while another side is still pending. The front's camera opens
  directly; the back goes through the turn-over step, which then says "Back: please take this photo
  again" and why. The camera shows the same message. The reasons reuse the camera's hint ("Place
  your ID straight inside the frame") for `no_document`, and say "Text unreadable: avoid blur and
  glare" for `unreadable`. Only the new photo is sent, then the screen checks again.
- A retake is asked at most `SERVER_RETAKES_PER_SIDE` (1) time per side, and never when the rider
  kept that photo despite a warning ("Use it anyway" for blur or glare, "Continue anyway" for code
  lines not read), or when the phone read its code lines with every check digit right. In those
  cases a `retake` counts as `ok`: the photo goes as it is, and staff see the server's verdict.
- Retaking the side with the code lines reads them again on the phone and sends a new report; a
  report still missing for the old photo is dropped (the server erases that photo).
- Back does nothing on this screen, and leaving the page asks first, as during the upload. A submit
  that fails is retried on its own ("Try again"), without checking again.

### An expired document (M4)

`GET /flow/checks` also says `expired: true` when the server's code lines (every check digit right)
give an expiry date before today. The screen then stops asking, keeps the photos without the scan
line, and shows "This document has expired / Please use another, valid ID document." with:

- **"Use another document"** (`expired/another`): back to the document list. Every photo of this
  document is forgotten on the phone, so whatever is chosen next, the same type included, starts
  with new photos; they replace the old ones on the server. The server's retakes stay counted.
- **"Continue anyway"** (`expired/continue`): the wait starts again as usual (a retake may still be
  asked), then the case is submitted; staff see the hard flag. The rider is not asked again.

The message comes before any retake. An answer without `expired` (a server not yet updated) counts
as `false`. Dev preview: `?screen=checking-expired`.

## Testing on a phone

- Debug panel: add `?debug=1` before the fragment, e.g. `https://<site>/?debug=1#s=<token>`. It
  shows live sharpness, focus, glare, brightness, framing, motion, fps and the video size, and on the
  review screen the file size, JPEG quality and scale. For the side with code lines it also shows
  the reading: result, format, character height (to calibrate), time, corrections, whether the
  photo was turned, ✅/❌ for each check digit, the fields read, the corrected lines and the raw OCR
  text. Staff dashboard test sessions offer a "Debug link" QR code that adds it.
- Tuning without a redeploy (debug mode only): any threshold of `packages/capture` can be set in the
  URL, e.g. `?debug=1&minSharpness=120&maxMotion=9#s=<token>`. So can the wait for the server's
  checks: `checksWaitMs` (0 to 120000) and `checksPollMs` (250 to 30000), e.g.
  `?debug=1&checksWaitMs=3000#s=<token>` to see what happens when the server is too slow.

## Development

```sh
npm run dev -w @verify/rider              # needs apps/rider/.env.local (see .env.example) for a backend
npx vitest run apps/rider                 # unit tests
npm run typecheck -w @verify/rider
npm run build -w @verify/rider
```

Screen preview without camera or backend (dev server only): open `/?screen=<name>` (add
`&lang=en` for English). Names: `welcome`, `welcome-loading`, `welcome-nosession`, `welcome-failed`,
`consent`, `consent-error`, `declined`, `document`, `document-busy`, `capture`, `capture-searching`,
`capture-ready`, `capture-shutter`, `capture-rejected`, `capture-denied`, `capture-debug`,
`capture-retake` (the server asked for this side again), `turnover`, `turnover-retake` (the server
asked for the back again), `reading`, `reading-download`, `review`, `review-refused`,
`review-override`, `review-lowres`, `review-mrz` (passport read, debug panel), `review-mrz-retry`
(lines not found), `review-mrz-override` (third failed try: "Continue anyway"), `upload`,
`upload-retrying`, `upload-failed`, `checking` (both sides of a card), `checking-passport`,
`upload-submit` (after the checks), `done`, `expired`, `invalid`, `submitted`. An unknown name lists
them all.

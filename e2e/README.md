# End-to-end tests: rider capture flow

The production build of the rider app runs in Chromium at phone size (390×844), with the real
security headers (CSP included). A synthetic video plays as the camera, and the Supabase backend is
emulated inside the page. The code lines (MRZ) on the fake documents are read by the real OCR engine
in the browser. No server, account or real document is involved.

```sh
npm run e2e                       # CI: after `npx playwright install --with-deps chromium`
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run e2e   # local, when the installed
                                  # browsers do not match the @playwright/test version
npx playwright show-report e2e/out/report
```

Requirements: Node 22 and `python3` (standard library only).

## How it works

- **Build and server.** `playwright.config.ts` builds `apps/rider` with
  `VITE_SUPABASE_URL=https://e2e.supabase.co` and `VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_e2e`,
  then serves the build with `vite preview` on port 4317. Output goes to `e2e/out/`, which git
  ignores. The preview server sends the `public/_headers` rules path by path and answers 404 for a
  missing `/assets/` or `/ocr/` file, as the real hosts do (plugin in `apps/rider/vite.config.ts`).
  The real CSP therefore applies: the Supabase address is a `*.supabase.co` one so that
  `connect-src` allows it, and the OCR engine must run under `'wasm-unsafe-eval'` and
  `worker-src 'self'`. The OCR files are served from the build like on the real site.
- **Camera.** `global-setup.ts` runs `scripts/make-fake-camera-video.py`. The script draws a
  clearly fake card ("SPECIMEN", made-up fields, a portrait box) on a dark textured table, with
  slight hand jitter, at 30 fps for 4 s. Its code lines are real: the script reads the OCR-B strips
  in `e2e/fixtures/mrz` (fictitious specimens of the state "UTO" with valid check digits, made by
  `scripts/make-mrz-fixtures.py`) and prints them at their physical size and place, as listed in
  `manifest.json`: TD1 (3 lines) on the ID-1 card, TD3 (2 lines) on the passport page. Each test
  project starts Chromium with `--use-file-for-fake-video-capture` pointing at one of these videos:

  | Project | Video | Stream |
  |---|---|---|
  | `card` | sharp ID-1 card | 1080×1920, a Full HD phone held upright |
  | `passport` | sharp passport data page | 1080×1920 |
  | `blurred` | the card, heavily out of focus | 1080×1920 |
  | `smudged` | the card in focus, its code lines smudged | 1080×1920 |
  | `no-card` | the table only | 1080×1920 |
  | `low-res` | sharp ID-1 card | 720×1280, a camera limited to 720p held upright |
  | `camera-denied` | none: `--deny-permission-prompts` answers "Block" | none |

  The card is placed where the app's guide falls in the video. That position comes from the guide
  on screen (`GUIDES` in `support/camera.ts`) mapped into the video with the `object-fit: cover`
  rule. The blurred and no-card tests check the live guide and the `?debug=1` metrics against it.

  The videos (about 2 GB together) go to the OS temp dir, or to `E2E_CAMERA_DIR` if set. They
  are reused while the script, its arguments and the MRZ fixtures stay the same.
- **Portrait stream.** The app asks for an ideal 1920×1080. A phone held upright rotates its sensor
  and delivers 1080×1920; desktop Chromium does not, and would crop a portrait file to 1080×1080.
  For the portrait cameras, `support/fixtures.ts` therefore swaps the requested width and height
  before they reach the fake device. The tests still check the app's own request.
  A 720p stream at this screen size gives a photo about 566 px long, which the server refuses (the
  minimum long side is 720 px): the `low-res` scenario checks that the app says so and never
  uploads it.
- **Backend.** `support/backend.ts` answers with `page.route` for:
  - every `flow` route, following the rules in `docs/M1_SPEC.md` and `docs/M2_SPEC.md` and the
    types in `contract.ts`. `POST /mrz` runs the real handler's own validation and verdict
    (`validateMrzReport`, `assessMrzReport`), so a test sees each report judged "pass" or "flag"
    exactly as the server would judge it;
  - the signed storage upload;
  - the health check.

  It records every request and every MRZ report, and can expire the session or fail uploads. Each
  test also fails on any of these:
  - a request the real backend would refuse;
  - an unknown request;
  - an uncaught page error;
  - a Content Security Policy violation (in the page, or reported by a worker).
- **Screens.** `support/fixtures.ts` logs every screen title as it appears, so a test can check a
  screen that shows only briefly (the reading screen takes about half a second once the OCR engine
  is warm).

## Scenarios

| File | What it proves |
|---|---|
| `capture-card.spec.ts` | Happy path (old CNI, no code lines, so nothing is read): the token leaves the address bar; consent; both sides auto-captured within 10 s; upload; submit. The uploaded JPEGs are under 300 KB, start with `FFD8`, have no APP1 (EXIF) segment and meet the minimum long side (720 px); `quality.source` is `auto`. Also: an upload failing three times, then a manual retry that reuses the signed upload; an expired link; a session expiring mid-flow; French by default, then switching to English mid-flow while keeping the state. |
| `capture-cni-biometric.spec.ts` | New CNI (2025): the back goes through the reading screen; the rider sees only "Code lines read ✓" (no fields); `POST /mrz` follows the back's capture with exactly the printed lines, and the server's verdict is "pass". Also: with the OCR engine's `worker.min.js` blocked, the rider goes on as usual and the report says `reader_unavailable` (flagged). |
| `capture-passport.spec.ts` | Passport: the photo page only, no "turn over" step; its code lines read, with ✅ for every check digit (personal number included) and the parsed fields in the `?debug=1` panel; the lines reach the server ("pass"). |
| `capture-mrz-smudged.spec.ts` | New CNI with smudged code lines: the warning with tips and Retake as the main button, three tries, then "Continue anyway"; the report (unreadable, or lines failing their check digits) is flagged. Retakes never reach the server. |
| `capture-blurred.spec.ts` | The "blurry" hint, no auto-capture, the shutter after about 8 s, a refused manual photo, and Retake. |
| `capture-no-card.spec.ts` | The "place your ID" hint, the surface tip after 5 s, no auto-capture. |
| `capture-low-resolution.spec.ts` | A 720p camera: the "too little detail" message at once, no auto-capture, and a manual photo that offers only Retake (no upload). |
| `camera-denied.spec.ts` | A clear "camera blocked" message in a focused dialog, Retry, and Back. |

## Settings

| Variable | Default | Use |
|---|---|---|
| `PW_CHROMIUM_PATH` | unset: Playwright's Chromium | Chromium binary to use instead |
| `E2E_CAMERA_DIR` | `<tmp>/confiance-verify-e2e-camera` | Where the videos are written |
| `E2E_WORKERS` | 2 | Parallel browsers |
| `E2E_PORT` | 4317 | Port of `vite preview` |
| `PYTHON` | `python3` | Interpreter for the video script |

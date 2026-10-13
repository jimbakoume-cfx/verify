# @verify/rider: rider verification flow (M1: ID capture)

The page a rider opens from the Confiance app: consent → choose the document → photograph the
front (and back) → review → upload → done. Riders never sign in; the session token arrives in the
link's fragment (`https://<site>/#s=<token>`), is kept for this tab only (`sessionStorage`,
`verify.session`), removed from the address bar at once, and sent only in the `x-session-token`
header. French is the default; every text is in `src/locales/{fr,en}.json`.

## Layout

| Path | What it does |
|------|--------------|
| `src/main.tsx` | Configures Supabase (no auth session), i18n, reads the token, renders the app. |
| `src/flow/machine.ts` | The flow as a pure reducer: screens, photos, upload state. |
| `src/flow/useFlow.ts` | Runs the reducer's side effects: API calls and uploads. |
| `src/flow/api.ts`, `errors.ts` | Typed client for the `flow` Edge Function (`contract.ts`); error codes with FR/EN text. |
| `src/flow/upload.ts`, `storage.ts`, `retry.ts`, `timeoutFetch.ts` | Upload per side (upload link, direct upload to the private bucket, confirmation), 3 tries with backoff, resumable; a stalled storage upload is aborted after 2 minutes and retried. |
| `src/flow/history.ts`, `token.ts` | The phone's Back button steps back through the photos (camera ↔ review ↔ turn over) instead of leaving the page; a new `#s=` link opened in the same tab reloads with it. |
| `src/ErrorBoundary.tsx` | No blank page: a camera chunk that fails to load offers "Try again", any other render error a reload. |
| `src/capture/` | The camera screen (lazy-loaded chunk) and `analyzer.worker.ts` (separate worker chunk). |
| `src/screens/` | The other screens. |
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

## Testing on a phone

- Debug panel: add `?debug=1` before the fragment, e.g. `https://<site>/?debug=1#s=<token>`. It
  shows live sharpness, focus, glare, brightness, framing, motion, fps and the video size, and on the
  review screen the file size, JPEG quality and scale.
- Tuning without a redeploy (debug mode only): any threshold of `packages/capture` can be set in the
  URL, e.g. `?debug=1&minSharpness=120&maxMotion=9#s=<token>`.

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
`turnover`, `review`, `review-refused`, `review-override`, `review-lowres`, `upload`,
`upload-retrying`, `upload-failed`, `done`, `expired`, `invalid`, `submitted`. An unknown name lists
them all.

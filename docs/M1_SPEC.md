# M1 — ID capture: design spec

Goal (from `PLAN.md`): live camera with a card frame, blur / glare / framing hints, auto-capture, crop and compression (target < 300 KB), upload straight to the private Supabase bucket, front and back. Testable on a phone; images visible in a temporary staff debug page.

The HTTP contract (types, limits, error codes) is `supabase/functions/_shared/contract.ts`. It is the single source of truth; web apps import it via `@verify/shared` (`packages/shared/src/flowApi.ts`). **Do not redefine these types elsewhere.**

## End-to-end test flow (what the PM does)
1. Signs in to the dashboard (`apps/dashboard`) with a magic link (Supabase Auth, email). Access requires a `staff_invite` for that email; the staff profile is created automatically once the email is confirmed.
2. Presses **New test session** → `POST /admin/test-sessions` → gets a rider link + QR code.
3. Opens the link on the phone → rider flow: consent (placeholder wording) → choose document → capture front (→ back) → review → upload → done.
4. Back on the dashboard, opens the case and views each photo through `POST /admin/captures/view` (audited, 60-second signed link).

Riders never sign in. Production sessions will be created by the Confiance backend with an API key in M10; the test-session endpoint stands in for that until then.

## Session token
- 32 random bytes, base64url. Only its SHA-256 (hex) is stored, in `verification.session_token_hash`.
- Lifetime 30 minutes (`session_expires_at`). An expired session returns `410 session_expired`.
- Delivered in the URL **fragment**: `https://<rider-site>/#s=<token>`. The rider app reads it, keeps it in `sessionStorage` (`verify.session`), and removes it from the address bar (`history.replaceState`). It is sent only in the `x-session-token` header.

## Database changes (migration `supabase/migrations/20261014000000_m1_capture.sql`)
- `verification`: add `declared_document text` (check in the 5 `DECLARED_DOCUMENTS`), `is_test boolean not null default false`, `upload_url_count integer not null default 0`.
  - `document_type` (enum) stays reserved for the classifier result in M3.
- `staff_invite(email text primary key — stored lower-case, role staff_role not null, full_name text not null, invited_by uuid null references auth.users, created_at, accepted_at)`. RLS enabled; only admins can read.
- Trigger on `auth.users` (after insert or update of `email_confirmed_at`): when `email_confirmed_at is not null` and an un-accepted invite matches `lower(email)`, insert `staff_profile` (role, full_name) if missing and set `accepted_at`. SECURITY DEFINER, `set search_path = ''`, function in schema `private`, execute revoked from public/anon/authenticated.
- Tests: `supabase/tests/20_m1_test.sql`. Update the stub (`00_supabase_stub.sql`) so `auth.users` has `email_confirmed_at timestamptz` and `raw_user_meta_data jsonb default '{}'`. Cover:
  - an invited user gets a profile only after confirmation, with a case-insensitive email match;
  - an uninvited user gets nothing;
  - an invite is used once;
  - the `staff_invite` RLS rules;
  - the new columns' constraints.

## Edge Functions (Deno, `supabase/functions/`)
Layout (pure logic is separated from Deno/Supabase glue so it can be unit-tested with vitest under Node 22):
```
_shared/contract.ts   (exists; types + constants)
_shared/http.ts       JSON/error responses, CORS (allowlist from env ALLOWED_ORIGINS, comma-separated), routing helpers
_shared/crypto.ts     sha256Hex(bytes|string), randomToken() — Web Crypto only
_shared/jpeg.ts       isJpeg(bytes), readJpegSize(bytes) -> {width,height} from the SOF marker (no decoding)
_shared/env.ts        Deno env access; service client via SUPABASE_SECRET_KEYS['default'] falling back to SUPABASE_SERVICE_ROLE_KEY
flow/handler.ts       createFlowHandler(deps) — routing + business rules, depends only on a FlowRepo/Storage interface
flow/repo.ts          Supabase implementation of that interface
flow/index.ts         Deno.serve(createFlowHandler(realDeps))
admin/handler.ts, admin/repo.ts, admin/index.ts   same pattern
deno.json             import map: "@supabase/supabase-js": "npm:@supabase/supabase-js@2.117.2"
```
- Relative imports use explicit `.ts` extensions (Deno requirement; Vite/vitest accept them too).
- Both functions are deployed with `verify_jwt = false`: `flow` authenticates with the session token, `admin` validates the staff access token itself (`auth.getUser(token)`, then an active `staff_profile`).
- Every non-2xx body is `{ error: { code, message } }` using `ERROR_CODES`. Never leak internal errors or stack traces; log them server-side.
- **CORS:** handle `OPTIONS` preflight. Allow only origins in `ALLOWED_ORIGINS`. Allowed headers: `content-type, authorization, apikey, x-session-token`. Methods: `GET, POST, OPTIONS`.

### flow (rider)
Route = path after `/flow` (Supabase passes the full path `/flow/...`; tolerate both with and without the prefix).
- **Session lookup:** sha256(token) → verification. Errors:
  - no token or no match → `401 invalid_session`;
  - `now >= session_expires_at` → `410 session_expired`;
  - status not `created` or `in_progress` → `409 already_submitted`. This applies to every route except `GET /session`, which always returns the session.
- `GET /session` → `FlowSession`. `captures` is the latest capture per side, excluding rows with `deleted_at`.
- `POST /consent {consentVersion, language}`:
  - `consentVersion` must equal `CONSENT_VERSION`, else `400 bad_request`;
  - inserts a `consent_record` (with the user agent), sets status `in_progress`, writes audit `consent.accept`;
  - idempotent if consent already exists (no duplicate row).
- `POST /document-type {declaredDocument}`:
  - requires consent (`403 consent_required`) and a valid document (`400 bad_request`);
  - may be changed until submit; audit `document.declare`.
- `POST /upload-url {kind}`:
  - requires consent and a declared document (`409 document_type_required`);
  - `kind` must be in `REQUIRED_SIDES[declared]` (`400 invalid_kind`);
  - atomically increments `upload_url_count` and fails with `429 too_many_uploads` once over `maxUploadUrlsPerSession`;
  - path = `<verification_id>/<kind>-<uuid>.jpg`; returns `createSignedUploadUrl(path)` data plus the bucket name `id-captures`.
- `POST /captures {path, kind, quality}`:
  - `path` must start with `<this verification id>/` and match `^[0-9a-f-]{36}/(document_front|document_back)-[0-9a-f-]{36}\.jpg$`, with the kind in the path equal to `kind`;
  - downloads the object (`404 upload_missing` if absent);
  - validates: byte size between `minBytes` and `maxBytes` (`422 image_too_small` / `image_too_large`), JPEG magic (`422 invalid_image`), SOF dimensions with long side ≥ `minLongSide` (`422 image_resolution_too_low`); on any failure the object is deleted;
  - computes sha256; `reusedElsewhere` = the same sha256 exists in another verification's capture;
  - inserts the `capture` row: `quality` = the client quality object (validated and clamped to finite numbers) plus `{"server": {"validated": true, "reusedElsewhere": bool}}`;
  - audit `capture.create` with actor `rider` and actor_id = the verification id.
- `POST /submit`:
  - every required side must have a capture (`409 missing_sides`);
  - sets status `submitted` and `submitted_at`, opens a `review_task` (Phase 1: everything goes to review), audit `verification.submit`;
  - returns `FlowSession`.

### admin (staff)
- Auth: `Authorization: Bearer <access_token>` → `auth.getUser(token)` → active `staff_profile`. Otherwise `401 unauthorized`, or `403 forbidden` when there is no staff profile.
- `POST /test-sessions {locale?}`:
  - role `supervisor` or `admin`;
  - ensures an `api_client` named `internal-test` exists (`api_key_hash` = `disabled:` + random hex, so it can never authenticate);
  - creates an applicant (`external_user_id` = `test-` + random) and a verification with `attempt_no` 1, `is_test` true, the token hash and an expiry of `now + TEST_SESSION_TTL_MINUTES` (env, default 30);
  - audit `test_session.create`;
  - returns `riderUrl` = `RIDER_APP_URL` (env) + `/#s=` + token.
- `POST /captures/view {captureId}`:
  - allowed for role `supervisor`, or for a reviewer with an `assigned` review_task on that verification. `admin` → `403 forbidden_role` (plan: admins have no routine image access);
  - capture missing or deleted → `404 not_found`;
  - writes audit `capture.view` (actor staff, target capture) **before** creating the link; if the audit insert fails → `500 audit_failed` and no link;
  - signed URL valid for 60 s.

### Tests
- vitest, `supabase/functions/**/*.test.ts`. Use in-memory fakes of the repo/storage interfaces. Cover every error code path above, CORS (preflight, disallowed origin), path validation, and JPEG parsing (build tiny valid JPEG byte arrays by hand: SOI + APP0 + SOF0 + EOI).
- `npx deno check supabase/functions/flow/index.ts supabase/functions/admin/index.ts` must pass.

## Capture engine (`packages/capture`, pure TypeScript, no React)
Public types are in `packages/capture/src/types.ts` (exists). Implement and export from `src/index.ts`:
- `toGray(rgba, width, height): GrayImage`: Rec. 601 luma.
- `laplacianVariance(img, roi?)`, `meanLuma(img, roi?)`, `glare(img, roi?, tiles=4): {ratio, maxTileRatio}`: saturated means luma ≥ 250.
- `detectDocumentBox(img, guide: Rect): {box: Rect | null, confidence}`:
  - search area = the guide expanded by 15%, clamped;
  - Sobel gradients; column profile of |Gx| and row profile of |Gy|; strongest edge pair left/right and top/bottom;
  - box = those 4 edges; confidence from edge strength vs the interior median;
  - must work for a light card on a darker plain background **and** a darker card on a lighter background.
- `frameMotion(prev, curr): number`: mean absolute difference (same size required).
- `analyzeFrame(gray, guide, prev | null, thresholds = DEFAULT_THRESHOLDS): FrameAnalysis`:
  - hint priority: `no_document`, `move_closer`, `move_back`, `center_document`, `too_dark`, `too_bright`, `glare`, `blurry`, `hold_still`;
  - framing = area(box ∩ guide) / area(guide); overshoot when the box exceeds the guide by more than `maxOvershoot`;
  - sharpness, glare and luma are measured inside the detected box, or inside the guide when there is no box.
- `class AutoCapture { constructor(required = thresholds.stableFramesRequired); push(analysis): AutoCaptureDecision; reset() }`: fires "capture" once after N consecutive ok frames, then stays quiet until `reset()`.
- Geometry:
  - `guideRect(viewW, viewH, aspect, maxWidthFraction = 0.9, maxHeightFraction = 0.6): Rect`: centred;
  - `mapViewRectToSource(rect, viewW, viewH, srcW, srcH): Rect`: for a `<video>` shown with `object-fit: cover`;
  - `expandRect(rect, fraction)`;
  - `clampRect(rect, w, h)`;
  - `scaleRect(rect, sx, sy)`.
- Compression:
  - `outputSize(cropW, cropH, maxLongSide = CAPTURE_LIMITS.maxLongSide)`;
  - `compressToTarget(encode: (quality, scale) => Promise<{size: number}>, target = CAPTURE_LIMITS.targetBytes)`: try qualities `[0.88, 0.8, 0.72, 0.64, 0.56]` at scale 1, then the same at scale 0.8. Return the first attempt under target, else the smallest; report `{blob, quality, scale, attempts}`. Generic over the blob type.
- `DEFAULT_THRESHOLDS`: calibrated on synthetic test images (document-like texture, Gaussian-blurred copies, white glare blobs, dark and bright exposure), with a comment explaining each value. Real-phone calibration happens during the PM's tests. Thresholds must be overridable.
- Tests (vitest), using synthetic images generated in code:
  - a sharp document-like card on a background vs a box-blurred copy;
  - glare blob vs none;
  - dark and bright frames;
  - a card filling 50% / 90% / 110% of the guide;
  - an off-centre card;
  - motion;
  - AutoCapture sequencing;
  - geometry for portrait and landscape video with cover;
  - the `compressToTarget` search.
- Performance: `analyzeFrame` on a 480×300 gray image should take under 15 ms in Node (add a smoke test with a generous bound).

## Rider app (`apps/rider`)
- Screens (state machine in `src/flow/`):
  - **Welcome**: Start is enabled when a session exists; without one, explain "open this page from the Confiance app" (test hint: "ask staff for a test link").
  - **Consent**: placeholder wording clearly marked as placeholder (FR/EN), an unticked checkbox and Continue. Decline shows an exit message.
  - **Document choice**: the 5 documents.
  - **Capture**: front, and back when needed. Before the back, a "turn the card over" step.
  - **Review**: "Use this photo" / "Retake".
  - **Upload**: progress, automatic retry with backoff (3 tries), then a manual retry button.
  - **Done**: "Photos received; next step: face check (coming in M5)".
  - **Session error**: expired, invalid or already submitted.
- **Camera** (`src/capture/`):
  - `getUserMedia({video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}}, audio: false})`;
  - `<video playsInline muted autoPlay>` with `object-fit: cover`; a dark overlay with a cut-out guide (aspect from `DOCUMENT_ASPECT`) and corner marks;
  - analysis loop at ~8 fps:
    - main thread: draw the expanded guide region of the video, scaled to 480 px wide, into an OffscreenCanvas (or canvas fallback);
    - send the ImageData buffer (transferable) to a Web Worker (`analyzer.worker.ts`, Vite `new Worker(new URL(...), {type: 'module'})`) that runs `toGray` + `analyzeFrame`;
    - fall back to the main thread if Workers/OffscreenCanvas are unavailable;
  - show the top hint as a large, high-contrast label (FR/EN), with the guide border colour reflecting readiness;
  - auto-capture via `AutoCapture`;
  - a manual shutter appears after 8 s;
  - stop all tracks on unmount and when the page is hidden.
- **Still capture:**
  - map the guide to video pixels (`mapViewRectToSource`), expand by 4%, clamp;
  - draw at `outputSize`, then `compressToTarget` with `canvas.toBlob('image/jpeg', q)`;
  - re-run `analyzeFrame` on a downscaled copy of the still. If a manual capture fails sharpness or glare, show the hint and ask the rider to retake;
  - canvas output carries no EXIF/GPS. Keep it that way: never upload the original camera file.
- **Errors:** handle permission denied, no camera, and insecure context, each with a clear FR/EN message and a retry.
- **Upload:**
  - `POST /flow/upload-url`;
  - `getSupabase().storage.from(bucket).uploadToSignedUrl(path, token, blob, {contentType: 'image/jpeg'})`;
  - `POST /flow/captures` with `ClientQuality`.
- **Flow client** (`src/flow/api.ts`):
  - base `${VITE_SUPABASE_URL}/functions/v1/flow`;
  - headers `x-session-token`, plus `apikey` = the publishable key;
  - typed errors carrying `ErrorCode`, mapped to FR/EN messages.
- **Debug panel** (`?debug=1`): live metrics (sharpness, glare, luma, framing, motion, fps), and the final file size, quality and scale.
- Every string FR + EN. Large tap targets; works at 360 px width; no layout shift when hints change.
- Unit tests for pure logic: session token parsing from the hash, the state machine reducer, error-to-message mapping, and FR/EN key parity.

## Dashboard (`apps/dashboard`)
- `getSupabase` gains options. The dashboard uses `auth: {persistSession: true, detectSessionInUrl: true, flowType: 'pkce'}`; the rider app uses `auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false}`.
- **Sign-in:**
  - email field → `signInWithOtp({email, options: {emailRedirectTo: window.location.origin, shouldCreateUser: true}})`;
  - "Check your email" state; sign-out;
  - note that the link must be opened in the same browser.
- **Access gate:** read your own `staff_profile`. If it is missing or inactive, show a "no staff access yet" screen.
- **Test sessions page** (supervisor or admin):
  - **New test session** → shows the rider link and a QR code (`uqr` `encode()` matrix rendered as React SVG rects, no innerHTML), a copy button and an expiry countdown;
  - list of the 20 most recent verifications (direct Supabase query; RLS decides what is visible) with status, declared document, test badge, capture count and created time.
- **Case view:**
  - capture list with kind, size, dimensions, source (auto/manual), client metrics and a reused flag;
  - **View photo** → `POST /admin/captures/view` → shows the image. Clear it from the page when the link expires;
  - a `403 forbidden_role` response for admins shows "admins have no routine image access".
- **Security headers:** `apps/dashboard/public/_headers` adds `https://*.supabase.co` to `img-src`.
- Every string FR + EN; tests for pure helpers and FR/EN key parity.

## Out of scope for M1
- Server-side pixel checks (blur, glare, classification, OCR): M3 AI worker.
- Liveness and selfie: M5.
- Production session API with API keys, webhooks and rider result screen: M10.
- Staff 2FA and a user-management UI: M9.
- Rate limiting by IP: noted for the security engineer.

# M5 — Active liveness capture: design spec

Goal (from `PLAN.md`): after the document photos, the rider does a short face check with the front camera. The server gives each attempt a **random challenge** (three actions and a one-time code), the phone takes a few still frames while the rider follows it, and the frames go to private storage. **M5 captures only.** Nothing judges yet whether the rider really did the actions: that is M6, which runs on the server from these frames and never trusts the phone.

The PM's test: a new challenge appears each time.

The HTTP contract stays in `supabase/functions/_shared/contract.ts` (section "Active liveness capture (M5)").

> **Since 2026-10-20 (fixes after the PM's first real test):** the face check comes **right after the photos** ("ID and face steps all at once", PM), the photos uploading meanwhile; the checks, a retake or an expired document come after it. Each action lasts **3.5 s** (frames at 0.7, 1.4, 2.1, 2.8 s) and the capture ends with a 1.2 s tail and one more frame of the last action: **14 frames**, about 13.2 s.

## Decisions taken for M5 (safest defaults; the PM reviews them, see `PLAN.md`)
1. **The face check is required before the submit.** The server refuses a submit without it (`409 liveness_required`), and the database checks it again inside `flow_submit`. A phone without a front camera gets whatever camera it has (`facingMode: ideal`), as for the document photos.
2. **Three actions per challenge**, drawn at random by the server from five (turn the head left, turn it right, look up, blink, smile), in a random order, plus a **6-digit one-time code** shown on screen during the capture. A challenge lasts **10 minutes** and can be recorded **once**; asking for a new one replaces any unused one. **At most 5 challenges per session**; then the rider must start again from the Confiance app.
3. **Still frames, not video.** 13 JPEG frames (1 while the rider looks at the camera, then 4 during each 3-second action), the **whole camera picture scaled to 480 px** on its long side, about 25–40 KB each, **under 600 KB in all** (server limits: 8–15 frames, 2–100 KB each, 240–640 px). Light on slow networks, decoded by any phone, and simpler to check than a video container.
4. **No face model on the phone.** The only detector we may use is **MediaPipe** (green in `docs/research/FACE_MODELS.md`; YuNet is amber). It is not cheap enough for M5: its WebAssembly engine is 13.5 MB (3.9 MB compressed) for every rider's first visit, on low-end Android over slow networks. The phone checks only **brightness and contrast inside the oval** (too dark, too bright, lit from behind, nothing to see). These hints never block: **Start** is offered once the picture has been fine for about a second, or after 6 seconds whatever it says, and the server records that the rider started despite a warning (`startedWithWarning`). Face detection and the action checks run on the server in M6, with MediaPipe.
5. **The server records a `liveness_capture` check**, decided as the frames arrive by a plain rule (no model, no AI worker, every session): "pass" when the frames are complete and their timings plausible, "flag" otherwise, with the problem codes. It says `evaluated: false` everywhere it appears. Nothing is shown to the rider.
6. **Retries.** A network or server failure keeps the frames: **"Try again"** sends the same frames for the same challenge. Anything else (challenge expired or used, frames refused, the page hidden during the capture) needs **"Start the face check again"**: a new challenge, new frames.
7. **Consent.** The placeholder wording now describes the face check (version `placeholder-v2`). **PM decision (2026-10-19):** a separate, **optional, unticked** box, "keep my face images to improve and tune Confiance's checks (deleted on request)", recorded in `consent_record.keep_face_images` with the version of its wording (`placeholder-keep-faces-v1`). Nothing depends on it yet. Both texts are placeholders for the lawyer.
8. **The face check is kept when the rider chooses another document** (M4's "Use another document"): the face has not changed. A newer face check replaces the older frames, as a newer photo replaces an older one.

## What the rider sees
After "Checking your photos…" (M3), instead of the submit:

1. **"Vérification du visage" / "Face check"**: the front camera, shown mirrored as in a selfie, with an oval guide and one large prompt: "Placez votre visage dans l'ovale" / "Place your face inside the oval", or a brightness hint. The oval turns green when the picture is fine. A tip says to hold the phone at eye level.
2. **"Commencer la vérification" / "Start the face check"**: the app asks the server for a challenge, then shows, for 1.5 s, "Look straight at the camera", then each action for 3 s ("Turn your head slowly to the left"…), with "Step 1 of 3" and **"Code 482 913"** at the top.
3. The camera goes off; **"Sending your face check…"** with a progress bar, then the submit ("Finishing…") and **"Photos received"**: "We have your document photos and your face check."

On failure, a panel says what happened, with "Try again" (same frames) or "Start the face check again" (new challenge). "Too many face checks" ends the flow there. Back does nothing on this screen; leaving the page asks first. Every string is FR/EN.

## Server

### Database (`supabase/migrations/20261018000000_m5_liveness.sql`; no removal statement in the text)
- **`liveness_challenge`**: `id`, `verification_id` (cascade), `actions text[]` (3 distinct known actions, checked by `private.liveness_actions_valid`), `code` (6 digits), `created_at`, `expires_at`, `superseded_at`, `used_at`. RLS on, **every right revoked from `anon` and `authenticated`**: only the service role (the `flow` function) reads or writes it. Staff see a challenge only through its `liveness_capture` check, once used.
- **`capture.liveness_challenge_id`** (cascade): frames are capture rows of kind `liveness_frame`, in the same private bucket, under the session's folder: `<verification id>/liveness-<challenge id>-<NN>.jpg`. They are erased with the session like the document photos (the rows cascade with the verification; the files share its folder for the retention job, M13). A check ties `kind = liveness_frame` to a challenge id and nothing else to one. Each frame's `quality` holds `{liveness: {index, step, atMs}, server: {validated: true}}`.
- **`consent_record.keep_face_images`** (default false) and **`keep_face_images_version`** (required when true).
- **`flow_issue_liveness_challenge(verification, actions, code, ttl, max)`** (SECURITY DEFINER, service role only): locks the session row; `closed` for a session no longer open, `too_many` past the limit; replaces an unused earlier challenge; audits `liveness.challenge` with the challenge number and the actions, **never the code**.
- **`flow_record_liveness(verification, challenge, code, frames, version, outcome, details)`** (SECURITY DEFINER, service role only): `not_found` (another session's), `used`, `expired` (late or replaced), `code_mismatch`, `closed`; refuses frames and details of the wrong shape (paths of this challenge's slots only, indexes 0..n-1, sizes and dimensions within the limits, details with the contract's keys and codes only, matching the challenge); inserts the frames, marks the frames of an earlier face check erased (`superseded_by`) and returns their paths, marks the challenge used, writes `liveness_capture` (one per case) and audits `liveness.capture` with counts, outcome and problem codes. All in one transaction.

### `flow` Edge Function
- **`POST /flow/liveness/challenge`** (body `{}` or empty): session open, consent given, document declared. Draws the challenge with `crypto.getRandomValues` (rejection sampling, `flow/liveness.ts`), records it, and returns it with **15 signed upload slots**.
- **`POST /flow/liveness/captures`**: strict validation (`validateLivenessCapture`: any unknown key, wrong type, out-of-range number, frame out of index order is `400`); each path must be this session's slot for this challenge and index. Then: `404 not_found`, `410 challenge_expired`, `422 invalid_liveness` (wrong code). Each file is downloaded and checked like a photo (`checkFrame`: size, JPEG signature, dimensions) and **against the phone's SHA-256**; the total is checked against 600 KB. Any refusal (`422 image_too_small`, `image_too_large`, `invalid_image`, `image_resolution_too_low`, `invalid_liveness`) **erases every frame of the request**; a missing file is `404 upload_missing` (the app retries). A frame whose SHA-256 is already in another verification sets the `frames_reused` problem. A retry of a recorded report (same paths) gets the same `200`; other frames for a used challenge get `409 challenge_used`. The older face check's files are removed after the record (best effort, logged).
- **`POST /flow/submit`**: `409 liveness_required` without live frames; the required kinds passed to `flow_submit` now include `liveness_frame`.
- **`POST /flow/consent`** accepts `keepFaceImages` (true or false; missing means false).

### The `liveness_capture` check (`supabase/functions/worker/liveness.ts`, pure, table-tested)
It lives with the worker's decisions because M6's evaluation will run there; in M5 the `flow` function calls it as the frames arrive. Details (contract `LivenessCaptureDetails`, the database refuses any other key):

```
{ evaluated: false, challengeId, actions, code, frames, framesPerStep, durationMs, serverElapsedMs,
  maxGapMs, startedWithWarning, problems }
```

Problems, each a named constant: `too_fast` (under 1 s per action), `longer_than_challenge` (the frames claim more time than the server saw pass since the challenge, plus 2 s), `gap_too_long` (over 4 s between frames), `out_of_order` (times or steps backwards, or a frame outside its step), `step_missing_frames` (none before the actions, or under 2 in an action), `duplicate_frames` (two identical files), `frames_reused` (a file seen in another verification). Outcome `pass` with none, `flag` otherwise.

## The rider app (`apps/rider`)
- **Flow** (`flow/machine.ts`): a `liveness` screen after the checks; `livenessDone` is kept for the visit (even when the document changes); actions `liveness/done`, `liveness/failed` (session errors only); a submit refused with `liveness_required` sends the rider back to the face check. The consent action carries the optional box.
- **`liveness/LivenessScreen.tsx`** (lazy chunk, about 5 KB compressed, fetched while the photos are checked): camera, presence sampling 4 times a second on a 96-pixel copy, the capture on timers from one start, frames grabbed synchronously and encoded in the background, SHA-256 with WebCrypto.
- `liveness/schedule.ts` (the plan, the byte target), `liveness/send.ts` (uploads 3 at a time with the usual retries, then the report; stops the other uploads at the first final failure), `liveness/frames.ts` (oval, sampler, encoding), `packages/capture/src/selfie.ts` (`analyzeSelfie`).
- Camera: `getUserMedia({video: {facingMode: {ideal: "user"}, width: {ideal: 640}, height: {ideal: 480}}, audio: false})`, stopped as soon as the frames are taken, when the page is hidden (the capture then counts as interrupted) and on unmount.
- Dev previews: `liveness`, `liveness-missing`.

## The dashboard (`apps/dashboard`)
A **"Face check" / "Vérification du visage"** section on the case page (`screens/CaseLiveness.tsx`, `lib/liveness.ts`): the challenge's steps in order with their frame counts, the code shown to the rider, capture length, server time, longest pause, whether the rider started despite a light warning, and each problem explained; a **"Not evaluated yet"** badge. Below, every frame (step, time, size) with **"View frame"** and **"View all frames"**, each through `POST /admin/captures/view`: audited, 60-second link, supervisors and the assigned reviewer, never admins, exactly as for the document photos. The photo list keeps the document photos only. Dev preview: the `case` screen has a fictitious face check.

## Tests
- `flow/liveness.test.ts` (draw, uniform randomness, paths, validation), `worker/liveness.test.ts` (every rule), `flow/handler.test.ts` (both routes, every error path, erasing refused frames, the retry, submit, the consent box).
- `supabase/tests/60_m5_test.sql`: the table's rules, issue and record (every result), refused shapes change nothing, replaced frames, the check and the audit (never the code), RLS and grants (no API role reads challenges; staff read frames and check as for photos; a reviewer only when assigned), cascade on delete, submit with frames, the consent column.
- Rider: reducer (`machine.liveness.test.ts`), schedule, sending and recovery (`liveness/liveness.test.ts`), `analyzeSelfie` (`packages/capture`), API routes.
- Dashboard: parsers and server-side rendering of the section (`CaseLiveness.test.ts`).
- Browser (`e2e/liveness.spec.ts`, new fake camera `face`: a drawn face, no real person): the prompts in the challenge's order and the code on screen; 13 frames to their slots, each a 480-pixel canvas JPEG without metadata, under the limits, judged "pass" by the real rule; a refused report then "Start again" with a different challenge (in English); a network failure then "Try again" with the same challenge. Every other complete scenario now goes through the face check (`Rider.passLiveness`).

## The PM test (after deploy)
Use a test session.
1. Photograph a document as before. After "Checking your photos…", the face check appears.
2. Follow the prompts. Note the code and the three actions. Do it again with a new test session (or "Start the face check again" after switching apps during the capture): the actions or their order and the code change.
3. On the dashboard, the case shows "Face check" with the same actions and code, "Not evaluated yet", and the 13 frames.
4. Try a dark room: the hint asks for more light; Start still comes after 6 seconds, and the dashboard says "Started despite a light warning: Yes".

## Deploy notes
1. Apply the migration (it creates a table, two functions, three columns; nothing is removed).
2. Deploy the `flow` Edge Function (it imports `worker/liveness.ts`: deploy the closure of `flow/index.ts`). The `admin` and `worker` functions are unchanged.
3. Publish the rider app and the dashboard **together with the `flow` function**: the M4 rider app cannot submit against the M5 server (`liveness_required`), and the M5 app needs the new routes. Test sessions only, so a short gap is acceptable.
4. Run `select * from private.superseded_files_left();`: expected empty (it now also lists replaced face-check frames whose file stayed).

## Known limits
- **Capture only.** A printed photo, a screen or a video replay of someone else passes M5; M6 evaluates the actions and adds passive anti-spoofing. In Phase 1 a person reviews every case.
- The phone's brightness check is not face detection; a rider may start with no face in the oval.
- A modified app can send any frames with plausible timings; the server only checks their shape, files, hashes and timings until M6.
- Frames uploaded but never reported (a rider who leaves during the upload) stay in the bucket until the retention job (M13), as unreported document uploads do.
- The fake camera in CI plays the same picture to both cameras; the drawn face is not a real face, so it says nothing about how M6 will judge real riders.

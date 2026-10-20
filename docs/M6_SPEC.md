# M6 — Server-side liveness evaluation and passive anti-spoofing: design spec

Goal (from `PLAN.md`): the server re-checks the face check (M5) itself, from the frames, and never trusts the phone. Did the rider do the three actions the server asked for, in the order it asked? Is it a real face in 3-D, or a flat picture? Is it the same face throughout? Plus passive cues of a screen or a print.

The PM's test: a printed photo or a phone screen held to the camera is flagged.

M6 and M7 (face match, `M7_SPEC.md`) run on the same new **face worker**. This spec describes the face worker, its database and its deploy; `M7_SPEC.md` adds the face match.

**Words used here:**
- **Face worker:** a second Vercel Python function (`worker-face/`, project `confiance-verify-face`, Paris). It measures; it decides nothing.
- **Landmarks:** the 478 points of MediaPipe's face mesh (eyes, nose, lips, face outline), with a depth estimate for each.
- **Reference frame:** the first frame taken before the actions (the rider looking straight at the camera) that shows exactly one face. Turns and tilts are measured from it.
- **Flat-plane test:** a printed photo or a screen, however it is moved, is one flat surface: its picture moves by a single *homography* (a perspective warp). A real head turning shows *parallax*: the nose moves against the cheeks and temples, which no homography explains.
- **Provisional:** a cut-off that is a first guess, not yet measured on real riders and real attacks (APCER/BPCER). Shown as such; can only send a case to a person.

The HTTP contract is still `supabase/functions/_shared/contract.ts` ("Face worker API").

## Decisions taken by the PM (2026-10-19)
1. **Liveness from landmarks** (MediaPipe Face Landmarker, Apache-2.0 weights, green): the M5 challenge re-checked on the server (head turn direction from the yaw, look up from the pitch, blink from the eye aspect ratio, smile), in the requested order across the frames; the **flat-plane** check; **frame-to-frame consistency** (the same face throughout, no cuts).
2. **Silent-Face-Anti-Spoofing** may be used only as a low-weight signal, on test sessions only (amber). **Not shipped** (see below).
3. **Our own screen and print detectors** need attack photos we do not have: the training pipeline stub and the data-collection notes are built (`training/antispoof/`), and **heuristic signals ship now, marked provisional** (moiré, screen glare, low detail).
4. **The result** is a `check_result` named exactly `liveness` (M8 counts this name), outcome `pass`, `flag` or `fail`, with generic scores and codes only.
5. **Consent:** face images are kept for training only when `consent_record.keep_face_images` is true (M5); otherwise nothing is kept beyond normal retention.
6. **Hosting:** the AI worker's bundle is about 377 MB of Vercel's 500 MB; the face models do not fit beside it. A **second Vercel Python project** with the same signed-claim protocol, its own key id (`f1`), Ed25519 signatures, nonces, bytes relayed, no Supabase credential on Vercel, a ring with no authority, a test-sessions-only switch and a daily cap.

## Decisions taken while building (safest defaults, for the PM's review)
1. **A separate job table** (`face_job`), not new kinds of `worker_job`: `worker_job` is one job per document photo, read by the M3 rules everywhere; a face job reads up to 15 frames and a document front. Its own claim, cap and sweep.
2. **Keys are scoped** (`worker_key.scope`: `documents` or `face`). A key signs for one function only, and each function's nonce check refuses the other scope. The face function also has its own **audience** in the signed line (`confiance-verify/face`), so a request signed for one function never verifies on the other.
3. **The face switch is separate** (`worker_settings.face_enabled_for_real_sessions`, default off; `face_daily_job_cap`, default 100), and turns on **liveness only**: the face match never runs on a real session (PM, M7), whatever the switch.
4. **Every action is judged in its own step** (the frames the phone took while that prompt was on screen): doing the right actions in the wrong order fails. A turn the other way than asked is `wrong_direction`.
5. **Outcome:** `fail` only when the landmarks saw the face and it did not do an action (or did it the wrong way). Everything else that needs a person's eye is `flag`: no face in an action's frames, no reference frame, a face missing or doubled, a jump between frames, and every provisional cue (flat plane, shape change, moiré, glare, low detail). For M8 both are the same provisional signal `liveness_flag`: **liveness never rejects a case, it only sends it to a person.**
6. **MediaPipe's models on LiteRT, not the `mediapipe` package:** its single native library is 112 MB; with AuraFace (M7) the function would be about 533 MB, over the limit. We run Face Landmarker's own three models (from Google's `face_landmarker.task`) with MediaPipe's pipeline written out in `verify_face/landmarks.py`; on a test portrait, landmarks within 0.5 px of the official package on average, blendshapes within 0.015.
7. **Silent-Face not shipped:** it is PyTorch only (a 2020 model to export to ONNX), its training data is undisclosed (possibly CelebA-Spoof, non-commercial), and it would add an amber model for one more provisional cue. The PM allowed it; we propose to decide with the first attack captures.
8. **No landmark leaves the worker:** only per-frame numbers (pose, blink, smile, sizes, the two geometry residuals, the cues). The measures are kept with the job (`face_job.evidence`, not readable by staff); `check_result.details` holds per-action results and codes.

## How it fits together
```
rider ── POST /flow/liveness/captures ─► flow ── records the frames (M5)
                                            │    trigger: face_job "liveness" (+ "face_match" when a front exists)
                                            └─ ring (FACE_RING_URL) ───────────────────────────────┐
pg_cron, every minute ─► private.face_sweep() ── ring via pg_net while a face job waits ──────────┤ POST, empty body
                                                                                                   ▼
     Vercel: confiance-verify-face /api/process (Python, cdg1)
        loop for up to ~50 s:  POST /face/claim   (signed, key f1) ─► a job and its inputs (frames, document)
                               POST /face/image   (signed) ─► one input's bytes, relayed, audited first
                               (landmarks, measures in memory)
                               POST /face/result  (signed) ─► the face Edge Function decides; the database
                                                              records check_result "liveness", audits
```

## The face worker API (`supabase/functions/face/`)
The AI worker's API (M3), unchanged in every security property:

| Route | Body | Answer |
|---|---|---|
| `/claim` | empty or `{}` | `200 FaceClaimResponse` (job, attempt, kind, test session or not, declared document, the challenge's actions, the inputs: each frame's capture id, index, step, time, SHA-256, size, dimensions; the document front for a face match), or `204` |
| `/image` | `{jobId, attempt, captureId}` | the JPEG bytes of **one input the claim handed out**; `404` for any other photo, another attempt or a lost lease; `410` when the photo was replaced or erased |
| `/result` | `FaceResultRequest` | `200 {status: "recorded" | "already_done"}`; `410`; `404` |

- **Signature:** `v1|confiance-verify/face|<kid>|POST|<route>|<Unix seconds>|<nonce>|<SHA-256 of the body>`, Ed25519, the same headers and the same checks in the same order: header shape, ±60 s, the body capped at 32 KB, the key (scope `face`, not revoked), the signature over the raw bytes (small-order keys refused), then the nonce once (`face_use_nonce`). No browser origin.
- **Bytes relayed, never a URL;** the audit entry `face.image` (`{jobId, attempt, verificationId, byteSize}`) is written before the bytes leave, or nothing leaves (`500 audit_failed`). A liveness job writes 13 entries (one per frame).
- **Strict validation** (`face/validation.ts`): exactly the contract's keys, every measure in range, `null` for every measure of a frame without a face, frame indexes once each, a reference that is one of the frames; the Edge Function refuses frames the job does not have.
- **The worker holds no Supabase credential** beyond the public publishable key, and its key `f1` opens only the face function.

## What the worker measures (per frame, `FaceFrameMeasure`)
| Measure | How |
|---|---|
| `faces` | faces found by BlazeFace and confirmed by the mesh (0, 1, or 2 for "two or more") |
| `yaw`, `pitch`, `roll` | the rotation that best aligns MediaPipe's canonical face (468 points) with the frame's mesh (Umeyama). Yaw positive = the nose to the image's right = **a turn to the rider's own left** (the frames are the camera's own picture; the app mirrors only its preview) |
| `blink` | MediaPipe's `eyeBlinkLeft/Right` blendshapes, averaged |
| `eyeOpenness` | eye aspect ratio from the mesh (Soukupová and Čech): eyelid opening over eye width |
| `smile`, `mouthWidth` | `mouthSmileLeft/Right` averaged; mouth corners' distance over the interocular distance |
| `faceSize`, `centerX`, `centerY` | interocular distance over the frame width; the face box's centre |
| `planarResidual` | flat-plane test against the reference frame: RMS error of the best homography of 35 rigid points (nose, forehead, cheekbones, temples, eye corners), over the interocular distance |
| `shapeDistance` | same-face test against the reference frame: RMS error of the best 3-D similarity of the rigid points, over the interocular distance |
| `moire`, `glare`, `detail` | provisional passive cues (`verify_face/spoof.py`): log10 of the strongest high-frequency peak over the band's 95th percentile (at the photo's own resolution); the share of blown-out pixels; Laplacian variance over brightness squared |

## What the Edge Function decides (`face/decide.ts`, check `liveness`, version `liveness-eval-v1`)
Every cut-off is a named constant and a **first guess**, set on drawn test faces (`worker-face/tests/synthface.py`) and simulated attacks only:

| Rule | Constant | Value |
|---|---|---|
| Turn left / right: from the reference, in the asked direction | `TURN_MIN_DEG` | 15° |
| Look up | `LOOK_UP_MIN_DEG` | 10° |
| Blink: blendshape score, or eye aspect ratio down to a share of the reference's | `BLINK_MIN_SCORE`, `BLINK_OPENNESS_RATIO` | 0.5, 0.6 |
| Smile: score and its rise over the reference, or a wider mouth | `SMILE_MIN_SCORE`, `SMILE_MIN_RISE`, `SMILE_WIDTH_RATIO` | 0.5, 0.2, 1.08 |
| Flat plane: median residual over frames turned ≥ 12° or tilted ≥ 8° from the reference | `FLAT_PLANE_MAX_RESIDUAL` | 0.025 (a real head at 12°: about 0.035; at 20°: about 0.06; a flat picture: under 0.02) |
| Shape change, on frames posed near the reference | `SHAPE_CHANGE_MAX` | 0.06 |
| Face jump between consecutive frames | `FACE_JUMP_CENTER`, `FACE_JUMP_SIZE_RATIO` | 25% of the frame, ×1.6 |
| Passive cues, on the median over the frames with one face | `MOIRE_MIN`, `SCREEN_GLARE_MIN`, `LOW_DETAIL_MAX` | 1.0, 0.04, 0.002 |

**Each action** is judged on the frames of its own step (`pass`, `fail` with `action_not_done` or `wrong_direction`, or `unclear` without a face), with its strongest measure (`peak`).

**Outcome:** `fail` when an action was not done or done the wrong way; `flag` for any other problem; `pass` when every action was seen and nothing else. `score` is the share of actions seen.

**Details** (`LivenessDetails`; the database refuses any other key): `evaluated: true`, `provisional: true`, the challenge id, the engine, per action `{action, result, framesWithFace, peak}`, the frame counts, `flatPlane` (`depth`, `flat`, `not_measured`) and its score, the problem codes, the timing. Never a landmark, never a value per frame.

What the drawn-face tests show with the real models (`worker-face/tests/test_models.py`, `test_edge_function.py`): a genuine sequence passes with depth seen; **a printed photo tilted in front of the camera does not even register as a turn** (the model sees yaw under 8° while the picture turns 25°; residual 0.003-0.005) and fails its actions; a turn the wrong way fails with `wrong_direction`; a filmed screen's pixel grid gives moiré 1.6-1.8 against 0.3-0.5.

## The database (`supabase/migrations/20261020000000_m6_m7_face.sql`)
No table removed, no removal statement in the text.
- **`worker_key.scope`** (`documents` by default, or `face`); `worker_use_nonce` now accepts `documents` keys only, the new `face_use_nonce` `face` keys only.
- **`worker_settings`**: `face_enabled_for_real_sessions` (false), `face_daily_job_cap` (100).
- **`face_job`**: kind (`liveness`, `face_match`), the face check (`challenge_id`), the document front (face match), status, attempts (3), lease, first claim (the cap), error code (`budget`, `ineligible`, `attempts`, `expired`), the inputs the last claim handed out, the evidence. RLS on, every right revoked; staff read `verification_id`, `kind` and `status` only (the photos' rule).
- **Jobs are created by triggers**: when a face check's challenge is marked used (its frames recorded) and when a new document front arrives. A newer face check or front **supersedes** the older jobs and **removes their results** (`liveness`, `face_match`), so a result always describes the current photos. A real session gets the jobs already failed (`ineligible`) unless allowed.
- **RPCs** (service role only): `face_claim` (one at a time, the cap exact, a busy case skipped, ineligible or exhausted jobs given up and audited `face.job_failed`, inputs gone → superseded), `face_image_lookup`, `face_job_context`, `face_record_result` (strict details, first result wins, `gone` when an input was erased, audit `face.result` with the outcome only), `flow_face_jobs_pending`.
- **`private.face_sweep()`** every minute (pg_cron `face-sweep`): requeues expired leases, gives up after 3 attempts or an hour, rings `face_ring_url` (Vault) while a job waits.
- **M8:** `private.risk_facts` counts the case-level `liveness` and `face_match` rows; a liveness result that is not `pass` adds the provisional signal `liveness_flag` (weight 0.5): review, never a reject. The face match is review-only (`M7_SPEC.md`).
- **`private.face_training_cases()`** (administrators, SQL editor): the cases whose latest consent ticked "keep my face images", the only ones a training export may take.

## The flow function
After recording a face check, `flow` asks the database whether a face job of the case waits (`flow_face_jobs_pending`) and, if so, rings the face worker (`FACE_RING_URL`, default the test environment's address) in the background. A failure is logged, never the rider's problem; the sweep rings within a minute anyway. **The rider app is unchanged**: the rider never waits for the face worker.

## The dashboard
A **"Server face checks" / "Contrôles du visage par le serveur"** section (`screens/CaseFace.tsx`): for liveness, the outcome with a **Provisional** badge, each action asked in order with Done / Not done / Cannot tell and its strongest measure (degrees or score), the depth result ("Real depth seen", "Moved like a flat picture", "Not measured") with its score and a Provisional badge, the frames with one face, the time, and each problem explained, the provisional ones marked. Without a result: "Waiting for the face worker" or "Not checked by the server" (from `face_job`'s status). The M5 "Face check" section now says "Capture only".

## Consent and retention
Nothing new is stored beyond what M5 stores: the frames stay where they are, with the session's retention (M13). The worker keeps nothing (memory only). Training uses only the cases listed by `private.face_training_cases()` (`training/antispoof/README.md`).

## Tests
- **Python** (`worker-face/`, `uv run pytest`): geometry on synthetic landmarks (pose signs, flat vs 3-D residuals with noise, shape distance), the detector decoding and crop without models, the passive cues on drawn pictures, signing (the shared vectors for the face audience), the claim validation and the ring against a stand-in function, the HTTP handler, the deploy settings and NOTICE, the model manifest and the fetch script (a local host, no network). **No real face in git**: the tests marked `models` draw a face (MediaPipe's canonical mesh, painted) and run the real models; they run when the models are fetched, locally (CI fetches no models).
- **The real face Edge Function in Deno** (`tests/test_edge_function.py`): signatures, the other audience and the other scope refused, replays, tampering; with the models, end to end: a genuine drawn sequence passes, a tilted print fails, a wrong-way turn fails.
- **Edge Functions** (vitest): `face/decide.test.ts` (every rule, by table), `face/handler.test.ts` (signatures, scope, audit before bytes, results, validation, the repo parsers), the flow's face ring, the contract's keys and codes found in the migration.
- **Database** (`supabase/tests/80_m6_m7_test.sql`): scoped keys and nonces, jobs created and superseded, test-only face match, claims (inputs, lease, cap, attempts, eligibility), the lookup (only the job's inputs), strict results, the sweep, M8 counting, RLS and grants, the training list, cascade, the audit chain. `70_m8_test.sql` now expects a clean case with a face match to be recommended for review.
- **Measured** (development machine, one thread; reported, never asserted): a liveness job of 13 frames about **0.35 s of CPU** (warm).

## The PM test (after deploy)
Use test sessions only, and your own face only.
1. Do a normal test session to the end, following the face check's prompts. On the dashboard, "Server face checks" → Liveness should say **Passed**, each action **Done**, depth "Real depth seen".
2. New test session: at the face check, hold a **printed photo** of your face to the front camera and move it while the prompts run. Expected: **Failed** (actions not done) or **To check**, and often "Moved like a flat picture" (when a turn is detected at all).
3. New test session: show a **photo of your face on another phone's screen**. Expected: **Failed**, possibly with "Screen pattern" (provisional).
4. New test session: turn your head the **other way** than asked. Expected: **Failed**, "Wrong way".
5. Report, per try: the outcome, each action's result and "strongest", the depth result and score, the problems. Screenshots of the section show no personal data. **If every head turn comes out "Wrong way" on your phone,** the camera mirrors its picture: tell us the phone model (one constant, `TURN_LEFT_YAW_SIGN`).

## Deploy notes (M6 and M7 together)
Order: the migration first (nothing reads the new tables before the functions), then the Edge Functions, then the face worker. Do **not** generate keys in a chat or a ticket.

1. **Database:** apply `20261020000000_m6_m7_face.sql` (see `docs/HANDOFF.md` for large migrations). It adds a column, a table, functions, a Vault secret `face_ring_url` (`https://confiance-verify-face.vercel.app/api/process`) and the pg_cron job `face-sweep`, and re-assesses the submitted cases (their assessment gains `reviewOnly`). Check: `select jobname from cron.job;` lists `face-sweep`.
2. **Edge Functions:** deploy `face` (new; `verify_jwt = false`, import map `deno.json`, the closure of `face/index.ts`), `worker` (its key lookup now filters the scope), `flow` (the face ring) and `admin` (unchanged code, but it imports `risk.ts`). Set `FACE_RING_URL` for `flow` in production (`https://confiance-verify-face.vercel.app/api/process`).
3. **Dashboard:** publish it (it reads `face_job` and the new checks).
4. **Face worker key pair** (`f1`), generated on a trusted machine with `umask 077`, never printed:
   ```sh
   cd worker-face && uv run python -c "import secrets,base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=').decode())" > /tmp/f1.seed
   uv run python -c "from verify_face.signing import Signer; print(Signer.from_seed('f1', open('/tmp/f1.seed').read().strip()).public_key_b64url())"
   ```
   The seed goes to Vercel as `FACE_WORKER_SIGNING_KEY` (sensitive, production only), then `shred -u /tmp/f1.seed`. The public key goes in the database:
   ```sql
   insert into public.worker_key (kid, public_key, scope) values ('f1', '<base64url public key>', 'face');
   ```
5. **Vercel project `confiance-verify-face`:** root `worker-face/`, region `cdg1`, no Git deployments (both in `vercel.json`), memory 2048 MB. Production variables: `SUPABASE_FACE_URL` (`https://<project-ref>.supabase.co/functions/v1/face`), `SUPABASE_PUBLISHABLE_KEY`, `FACE_WORKER_KEY_ID` = `f1`, `FACE_WORKER_SIGNING_KEY`. Deploy to production (`vercel deploy --prod --scope suivix` from `worker-face/`, with `NODE_USE_ENV_PROXY=1`; remove any `.env.local` the CLI writes).
   - The build command (`python3 scripts/fetch_models.py`) downloads the two models and checks their SHA-256; the build log must show both "ok (downloaded)". If the build command does not run for this project type, run it locally, then `vercel build --prod` and `vercel deploy --prebuilt --prod`.
   - **Check the bundle:** about 479 MB (214.5 MB of packages, 264.5 MB of models), under the 500 MB limit; no "exceeds the standard size; optimizing dependencies" in the log; the function's files contain `models/glintr100.onnx`, `models/face_landmarker.task` and `NOTICE`. If Vercel refuses the size, the fallback is Vercel's large functions (beta, `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`) or a container host.
   - **Firewall:** allow only `POST /api/process`, rate-limited per IP at no fewer than 30 requests a minute (as for the AI worker).
6. **Smoke test:** a test session through the face check; within a minute the case shows both results; `select status, error_code from face_job order by created_at desc limit 2;` says `done`. Also check that a request signed with the AI worker's key is refused by `face` (401) and vice versa.
7. Then the PM tests (above and in `M7_SPEC.md`).

**Operating (SQL, administrators):**
```sql
-- Real sessions' liveness: ONLY after Vercel Pro and its DPA (the face match stays test-only regardless)
update public.worker_settings set face_enabled_for_real_sessions = true, updated_at = now();
-- Daily cap of face jobs (Douala time)
update public.worker_settings set face_daily_job_cap = 100, updated_at = now();
-- Revoke the face key
update public.worker_key set revoked_at = now() where kid = 'f1';
```

## Known limits
- **Every cut-off is a guess** made on drawn faces. Real riders, real phones, dim light and dark skin may move every number: measure on the volunteer set (APCER/BPCER per group) before trusting any of it.
- **What landmarks cannot catch:** a realistic 3-D mask, a deepfake or a replayed video of the rider fed through a virtual camera (an injection attack), a live accomplice. A **video replay of someone else doing the same challenge** would need the challenge in advance (random, one-time code); a replay on a screen may show moiré. Injection needs device and stream signals (open item in `THREAT_MODEL.md`).
- **A curved or folded print** can show some parallax; it still has to do the actions.
- **Blink and smile on the drawn face** score lower on the blendshapes than real faces (0.4 instead of 0.8+); the eye-aspect-ratio and mouth-width rules cover that. Real faces may behave differently.
- **CPU budget:** Vercel Hobby's 4 CPU-hours a month are shared by both workers; a face check costs about 0.35 s (liveness) plus about 1.1 s (face match), 3-5 s with a cold start.
- **The sign convention** (rider's left = positive yaw) assumes the front camera's own, unmirrored picture, as browsers give it; checked on the drawn face, to confirm on real phones (PM test step 5).

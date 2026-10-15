# M3 — Server checks by the AI worker: design spec

Goal (from `PLAN.md`): the server looks at each photo itself. It re-checks the photo's quality, re-reads the code lines (MRZ) from the image, recognises the document type and reads a few printed fields. Until M3 the server only checked lines that the phone sent, so a modified app could send lines that never came from the photo. M3 also starts our own MRZ reading model, to replace the web-trained Doubango model on the phone.

The PM's test: scan each document type with a test session and see, on the dashboard, the right document type, the server's own reading of the code lines (agreeing with the phone), and the printed fields behind "Show data read".

**Words used here:**
- **AI worker, or "worker":** a Python program on Vercel (Paris region) that runs the OCR models. It measures and reads; it decides nothing.
- **Ring, or "doorbell":** an empty `POST` to the worker's address. It only wakes the worker up and carries no data and no authority.
- **Job:** one photo waiting to be checked (table `worker_job`). The worker **claims** a job, gets a **lease** on it for 120 seconds, fetches the photo, then posts its **result**.
- **Ed25519 signature:** the worker proves each request is its own with a private key that only it holds. The database keeps the matching public key.
- **Nonce:** a random one-time number in each signed request, so that a recorded request cannot be played again.
- **Firm vs provisional:** a result is **firm** when it comes from the code lines, whose check digits can be verified. Anything based on printed words, layout or quality thresholds is **provisional** until tuned on real photos: it is shown as provisional and never decides on its own.
- **Cold start:** the first request after a quiet period, when Vercel starts the function and the worker loads its models.
- **CPU-hour:** an hour of one processor's time. Vercel's free Hobby plan includes 4 a month.

The HTTP contract (types, limits, error codes) is still `supabase/functions/_shared/contract.ts`, the single source of truth. There is still exactly one MRZ corrector (`_shared/mrzCorrect.ts`) and one parser (`_shared/mrz.ts`): the phone, the server and the dashboard all use them.

## Decisions taken by the PM (2026-10-14)
1. **Host: Vercel, free Hobby plan, region Paris (`cdg1`), for testing only.**
   - The PM was told that Hobby's terms allow only non-commercial personal use, that Hobby comes with no data processing agreement (DPA), and that it includes 4 CPU-hours a month.
   - **Enforced in code:** the worker processes **test sessions only** until a database switch is turned on, which happens only after moving to Vercel Pro and signing its DPA. A **daily job cap** protects the CPU budget.
   - Vercel replaces the container host (Scaleway) considered earlier. The same code runs on Vercel Pro or any container host.
2. **M3 stays one milestone.**
3. **Accepted documents:**
   - passports of any country;
   - Cameroonian residence permits: carte de séjour and carte de résident, new and old models;
   - refugee cards (new grey, old red), for manual review;
   - voter card and driving licence: accepted, always manual review;
   - old CNI: manual review.

   The rider's option is now **"Titre de séjour ou carte de réfugié / Residence permit or refugee card"**; the server works out which card it is. An ID card issued by another state is flagged as not accepted.
4. **The rider waits for the server's check:** "Checking your photos…" for at most about 20 seconds. A photo the server finds unusable is retaken at once. If the server is slow or down, the rider continues and staff review the case.
5. **Our own MRZ model:** train from zero first. If that fails the gates, fine-tune Google's `eng` model (Apache-2.0; its list of about 4,500 mostly commercial training fonts goes to the lawyer). Doubango stays until one model passes. **M3 is complete even if none passes.**
6. **OpenCV's bundled parts** (LGPL FFmpeg and libquadmath, Intel IPP, GCC runtime with its exception, an old OpenSSL that we never use, and others) are documented in `LICENSES.md`. A slim OpenCV build comes later.

## End-to-end test flow (what the PM does)
Only **test sessions** are checked by the server while the switch is off (decision 1). The detailed test, and what counts as a pass, are in "The PM test" below.

1. On the dashboard, press **New test session** and scan the **Debug link** with the phone.
2. Consent, choose the document, photograph each side as in M2.
3. After the photos are sent, the phone shows **"Vérification de vos photos…" / "Checking your photos…"** for a few seconds, usually under 20.
   - If the server finds a photo unusable (no document on it, or no readable text), the camera for that side opens again with **"Recto : photo à reprendre" / "Front: please take this photo again"** and the reason. This happens at most once per side.
   - If the server is slow or unavailable, the phone continues after 20 seconds as if nothing happened.
4. The phone shows "Photos received", as before.
5. On the dashboard, open the case. The new **Server checks** section shows the document recognised, the reasons a person must decide, and, for each side, the server's photo check, its own reading of the code lines (compared with the phone's) and which printed fields it found. **Show data read** (now in its own section, **Data read from the document**) adds the server's code lines and the printed fields, for 60 seconds, audited.

## How it fits together
```
rider ── POST /flow/document-type ─► flow ── warm-up ring ───────────────────────────────┐
rider ── POST /flow/captures ──────► flow ── (trigger: new worker_job) ── ring ──────────┤  POST, empty body
pg_cron, every minute ─► private.worker_sweep() ── ring via pg_net while a job waits ────┤  (carries no authority)
                                                                                         ▼
     Vercel: confiance-verify-worker /api/process (Python, cdg1)
        loop for up to ~50 s:  POST /worker/claim  (signed) ─► next job, or 204 "nothing to do"
                               POST /worker/image  (signed) ─► the photo's bytes (relayed; no URL)
                               (OCR in memory)
                               POST /worker/result (signed) ─► the worker Edge Function decides,
                                                               the database encrypts, records, audits
        answers the ring with {"ok": true}
rider ── GET /flow/checks, every 2 s for at most 20 s ─► per side: pending | ok | retake (reason) | unchecked
```

- **The worker holds no Supabase credential** other than the public "publishable" key that the web pages also use. It cannot read the database or the storage bucket. It can only ask the `worker` Edge Function for the next job, fetch that job's photo while it holds the lease, and post that job's result.
- **No image URL ever leaves Supabase:** the Edge Function relays the photo's bytes.
- **The worker answers a ring only with `{"ok": true}`** (or `{"ok": false}` on a configuration error). Nothing else ever comes back.
- **Raw OCR text never leaves the worker.** It sends back only candidate code lines, a few selected fields, counts and measures.

## The worker API and its security (`supabase/functions/worker/`)
Three routes, all `POST`, all signed:

| Route | Body | Answer |
|---|---|---|
| `/claim` | empty, or `{}` | `200 WorkerClaimResponse` (job id, attempt number, photo id, side, declared document, where the code lines should be, and the photo's SHA-256, size and dimensions), or `204` when there is no job |
| `/image` | `{jobId, attempt}` | `200` with the JPEG bytes; `404 not_found` when this attempt does not hold the lease (it expired and was claimed again, or the job is done); `410 image_gone` when the photo was replaced or erased |
| `/result` | `WorkerResultRequest` | `200 {status: "recorded"}`, or `"already_done"` when an earlier result for this job was recorded first (the first result wins); `410 image_gone`; `404 not_found` |

**Signature.** The worker signs one line per request with its Ed25519 key:

`v1|confiance-verify/worker|<key id>|POST|<route>|<Unix seconds>|<32 hex nonce>|<SHA-256 hex of the body bytes>`

It sends the key id, timestamp, nonce and signature in the `x-worker-key-id`, `x-worker-timestamp`, `x-worker-nonce` and `x-worker-signature` headers. The TypeScript and Python sides are tested against the same fixed vectors (`supabase/functions/worker/signature.vectors.json`, built on the RFC 8032 test key).

**The function checks, cheapest first:**
1. the headers' shape;
2. the timestamp, within ±60 seconds of the server's clock;
3. the raw body, read up to 32 KB and no further;
4. the key: known and not revoked (one lookup in `worker_key`);
5. the signature over the raw bytes, before any JSON is parsed (WebCrypto Ed25519, no added library). Keys of "small order", for which anyone can forge a signature, are refused;
6. the nonce, recorded once (`worker_use_nonce`). It is written only after the signature is verified, so unsigned requests cannot fill the table.

Every failure is `401 invalid_signature` or `401 replayed_request`. A request carrying a browser `Origin` header is refused (`403`): no web page may call this function.

**Strict validation of the result** (`validation.ts`): any unknown key anywhere is refused (`400`), as are an attempt outside 1–3, a time over 300,000 ms, more than 8 candidate lines, and field values that are not printable ASCII or are longer than 80 characters. Messages name the field, never its value.

**The photo leaves Supabase only with a record of it.** Before relaying the bytes, the function writes the audit entry `worker.image` (`{jobId, attempt, verificationId, byteSize}`). If that fails, the answer is `500 audit_failed` and no bytes are sent.

## Jobs, rings and the sweep
**A job for every document photo.** A database trigger on each new front or back photo:
- marks the older live photos of the same side as erased and **replaced** (`capture.superseded_by`), and deletes the data read from them, as M1 does for a refused upload. The `flow` function then removes their files from storage;
- drops the unfinished jobs of that side (`superseded`);
- creates the new job. For a **real session while the switch is off**, the job is created already failed (`ineligible`), so the photo is reported "unchecked" at once and the worker is never rung for it.

Only the newest live photo of each side counts, everywhere: the rider's checks, the case-level checks, the dashboard and "Show data read".

**Rings.**
- The `flow` function rings when the rider chooses a document (a warm-up, so the worker starts while the rider frames the first photo; only for test sessions, or for every session once the switch is on), and after each accepted photo.
- Rings run in the background after the answer is sent (`EdgeRuntime.waitUntil`), and stop listening after 30 seconds. A timeout counts as "worker reached" (the worker answers only when its run ends).
- A `429` comes from Vercel's firewall (its rate limit), before the worker: it does **not** mean a worker is running, because a run stops as soon as no job is left while the firewall keeps counting. The ring is tried once more after 5 seconds (or after the firewall's `Retry-After`, when it is 10 seconds or less); refused again, it has failed. The firewall rule is sized so that our own rings never reach it (see "Deploy notes").
- A ring that fails marks the job, and `GET /flow/checks` then says `unchecked` at once instead of keeping the rider waiting. A job a worker has already claimed is never marked.
- The ring URL is `WORKER_RING_URL` (HTTPS only). The test environment defaults to the worker's production address.

**Claiming** (`worker_claim`), oldest job first:
- A job is handed out only for a test session, or any session once the switch is on; only while the session is open (in progress and not expired, or submitted) with a document declared.
- Each claim adds one attempt and a 120-second lease.
- Jobs that may not run are given up on the way, each audited (`worker.job_failed`, with a code only):
  - `attempts`: 3 attempts used;
  - `ineligible`: the session may not be processed;
  - `budget`: the daily cap is reached. The cap counts jobs claimed since midnight, Douala time; default 150.
- A case that another writer is updating at that moment is skipped, not waited for: the next claim picks it up.

**The worker's loop.** On each ring the worker claims and processes jobs until there are none (`204`) or about 50 seconds have passed, then answers. Its models load only after the first successful claim, so a ring with no work costs almost nothing. A `404` or `410` from `/image` or `/result` means "nothing to do for this job any more": it moves on. So does a claim it refuses as malformed (a field out of range, such as a photo over 1,600 px uploaded before the server refused them): that job keeps its lease, so the next claim hands out other work, and after its last attempt it is reported "unchecked". Any other error stops the ring.

**The sweep** (`private.worker_sweep()`, every minute through pg_cron):
- puts back jobs whose lease expired (the worker crashed or timed out);
- gives up on a job after 3 attempts, or after waiting more than an hour;
- rings the worker through pg_net while a job waits (URL kept in Vault as `worker_ring_url`; 60-second timeout; pg_net keeps the `{"ok":true}` answers for 6 hours);
- purges expired nonces and week-old pg_cron logs.

## What the server decides (`supabase/functions/worker/decide.ts`)
The worker only measures and reads. The `worker` Edge Function makes every decision, in TypeScript, from the worker's evidence. Each rule is a pure function tested with tables. Every check stores its version (`server-checks-v1`, or the parser's `mrz-v1`).

### Per photo
**Quality (`quality_server`, always provisional).** The worker measures with exactly the same maths as the phone (`packages/capture`, ported to Python; a test proves the numbers are identical): sharpness (the phone's noise-free focus score), glare, brightness, document found and its confidence, long side, and the number of text lines the OCR found.

| Verdict | When | What happens |
|---|---|---|
| `no_document` | fewer than 3 lines of text, no code lines read, and no document found | the rider is asked to retake (at most once per side) |
| `unreadable` | fewer than 3 lines of text and no code lines read, but a document was found | the rider is asked to retake (at most once per side) |
| `poor` | readable, but no document outline was found, or a measure is outside the phone's starting limits (document confidence under 0.5, sharpness under 5, glare over 2%, brightness outside 50–225) | shown to staff, never retaken |
| `ok` | otherwise | — |

Code lines read on the photo prove it readable, whatever the measures say. Only the two extreme verdicts can ask for a retake, until the limits are tuned on real photos.

**Code lines read by the server (`mrz_server`, firm).** On the side that should carry them, the server runs the shared corrector and parser on the worker's candidate lines: the expected format first, then the other one, so that a card shown for a declared passport is noticed. The outcome is `pass` only when lines of the expected format were read, every check digit is right, both dates are real dates, and the document code fits, as in M2. The details hold true/false per check digit, the format, the number of corrections, and **the comparison with the phone**:
- `agrees`: the phone sent the very same lines;
- `differs`: the server did not confirm the phone's lines. That includes the server reading nothing while the phone read lines;
- `missing`: no report from the phone (yet);
- `unreadable`: the phone read nothing.

The comparison is **exact equality of the lines**, made in the database, which can decrypt both. Whichever of the two writes lands second (the phone's report or the server's result) makes it.

**Printed fields (`ocr_fields`, provisional):** only the **names** of the fields found, never their values.

### Per case
From the newest live photo of each side:

**Classification (`classification`):**
- **Firm, from code lines.** A passport-format line with a code starting `P`: **passport**, from any country. A card-format line issued by Cameroon (`CMR`): the **new CNI** when the holder is Cameroonian, otherwise **residence permit or refugee card**. A card issued by another state: **not accepted**. Confidence 1 when every check digit is right, 0.8 otherwise.
- **Provisional, from printed words.** Without code lines, keyword groups decide: national ID, passport, residence (every foreigner card counted together), driving licence, voter card. Ties give "not recognised". A "national ID" with an upright front or a QR code counts as the new CNI, otherwise the old one. Confidence at most 0.5.
- The outcome is `pass` only when it is firm and matches the declared document.
- **No keyword counts are stored with it.** They stay in the job's evidence (`worker_job.evidence`, never readable by staff): on a passport, the "RÉPUBLIQUE DU CAMEROUN" header and the number of printed labels tell a Cameroonian passport from a foreign one, which is the holder's nationality. The database refuses classification details with any key outside the contract's list (`CLASSIFICATION_DETAIL_KEYS`).

**Reasons for a person to decide (`document_policy`), generic codes only:**

| Reason | Decided by | When |
|---|---|---|
| `manual_review_document` | function | the old CNI, a driving licence, a voter card, or **any** residence permit or refugee card (declared or detected) |
| `unsupported_document` | function | code lines of an ID card issued by another state |
| `unrecognised_document` | function | nothing recognised: no code lines, and no printed title of an accepted document (or two titles tied) |
| `type_mismatch` | function | firm classification that differs from the declared document |
| `mrz_invalid_server` | function | the server read code lines of the expected format on the side that carries them, but its `mrz_server` check failed: a check digit, a date or the document code is wrong (a damaged or altered document), even when the phone read the same lines |
| `provisional_classification` | function | the type comes from printed words only |
| `mrz_unreadable_server` | function | required code lines (passport, new CNI) not read by the server |
| `server_unchecked` | database | the newest photo of a side could not be checked (job failed: budget, ineligible, 3 attempts, or an hour waiting) |
| `phone_report_missing` | database | the server has checked the side that carries the code lines, and the phone's report for that photo is not there (it clears when a late report arrives) |
| `mrz_disagreement` | database | the server read code lines and they are not the phone's |

The reasons are stored sorted. Every residence permit goes to a person, including the new cards whose code lines check out, so that the reason never tells a refugee card from the others. A `poor` photo (provisional limits) is shown under the photo and never becomes a reason on its own, and its explanation says so.

**Two photos finishing at once.** The function decides the case-level checks from a snapshot of the case, and the database writes them only if the case's fingerprint has not changed since. Otherwise it answers `stale` and the function decides again from a fresh snapshot (up to 5 rounds). Every writer of a case's checks first takes one lock per case, then touches rows, so writers wait in line instead of blocking each other. The same refresh runs when a photo is replaced.

### Firm vs provisional
| Firm (based on code lines and check digits) | Provisional (shown as such; never decides on its own) |
|---|---|
| Passport, new CNI and new foreigner cards recognised from their code lines | Type recognised from printed words (old CNI, old permits, driving licence, voter card) |
| Each check digit, dates valid, document code fits | Quality verdicts and thresholds (only "no document" and "unreadable" ask for a retake, once) |
| Agreement with the phone's lines | Printed fields, date formats, which way up the photo reads, the card sub-type |
| ID card of another state = not accepted | The new CNI's document code (`I`, `A` or `C` accepted until a real card shows it) |

## Rider app (`apps/rider`)
- **The upload is split in two:** `uploadSides()` sends the photos and the MRZ report; `submit()` runs after the checks. The progress bar continues, so the final step reads "Finalisation… / Finishing…" at about 86%.
- **"Checking your photos…" screen** (`Checking.tsx`): it shows the photos with the scan line. It asks `GET /flow/checks` at once, then every 2 seconds (`CHECKS_POLL_MS`), for at most 20 seconds (`CHECKS_WAIT_MS`).
  - Every side `ok` or `unchecked`: the case is submitted.
  - Out of time, an error, or an answer that makes no sense: the case is submitted too, with nothing shown to the rider. Staff review it. A network or server error is asked again while there is time.
- **A server retake** (`retake` with a reason):
  - That side's photo is dropped and its camera opens again at once, even while another side is still pending. The front opens directly; the back goes through the turn-over step, whose title becomes "Verso : photo à reprendre / Back: please take this photo again", with the reason. When both sides need it, the front comes first.
  - The camera shows a red alert naming the side and the reason. `no_document` reuses the hint "Placez la pièce bien droite dans le cadre / Place your ID straight inside the frame"; `unreadable` says **"Texte illisible : évitez le flou et les reflets" / "Text unreadable: avoid blur and glare"**.
  - Only the new photo is sent, then the screen checks again.
- **When a retake is never asked** (it is treated as `ok`; staff see the server's verdict):
  - the side already had its one server retake (`SERVER_RETAKES_PER_SIDE`);
  - the rider kept that photo despite a warning ("Use it anyway" for blur or glare, "Continue anyway" for unread code lines);
  - the phone read that photo's code lines with every check digit right.

  The server applies the first and the last rules itself too.
- **Retaking the side with the code lines** reads them again on the phone and sends a new report. A report still pending for the old photo is dropped, because the server erases that photo.
- Back does nothing on this screen, and leaving the page asks first. A failed submit is retried on its own ("Try again"), without checking again.
- **Label:** the residence permit option is now "Titre de séjour ou carte de réfugié / Residence permit or refugee card".
- **Error texts** for the new codes `invalid_signature`, `replayed_request` and `image_gone` (riders never meet them; the locale test requires a text for every code).
- **Debug mode only:** `?debug=1&checksWaitMs=…&checksPollMs=…` changes the wait (0–120,000 ms) and the pause (250–30,000 ms), to try the timeout without waiting 20 seconds.
- **Dev previews:** `checking`, `checking-passport`, `turnover-retake`, `capture-retake`, `upload-submit`.

Full details: `apps/rider/README.md`, section "Server checks (M3)".

## Dashboard (`apps/dashboard`)
The case page now reads, top to bottom: summary, **Server checks**, **Code lines (MRZ)** (the phone's reading, as in M2), **Data read from the document**, Photos.

- **Server checks** (`CaseServer.tsx`, rules in `lib/serverChecks.ts`):
  - **Document recognised:** the type found against the type declared, with ✅/❌/— for the match; what it is based on ("the code lines (firm)" or "printed words (provisional)"); confidence; QR code seen; the outcome and the check version. **No keyword counts** (see "Per case"): a row that still carried them is read without them.
  - **For a person to decide:** each reason with a French/English label, an explanation and its generic code.
  - **Per side, the newest live photo only:**
    - the photo check: Usable / Poor quality / No document found / No readable text, a Provisional badge, an explanation when it is not "Usable", and the measures (text lines, document found and confidence, the focus score labelled with its threshold of 5, never "Sharpness" like the phone's raw Laplacian variance in Photos, glare, brightness, long side, processing time and whether the models had to load first, engine and version);
    - the code lines read by the server: found, format, each check digit, document code, dates, and the comparison with the phone ("Same lines as read on the phone ✅", "Not the lines read on the phone ❌", "Phone report missing —", "Not readable on the phone —");
    - printed fields found, **by name only**;
    - decided per photo, from its own job (staff may read a job's status, nothing else of it): "Waiting for the server" while the job is queued or being read; "Not checked" when the server gave up on that photo, or when the photo has no job because it was taken before M3 ("never sent to the server"). The case-wide `server_unchecked` reason never marks another side.
- The checks are read through a separate direct query on `check_result` (Row Level Security decides who sees them), so a failure there leaves the rest of the case readable. Each row is parsed field by field, and a test proves that extra keys, such as a name or a number, never get through.
- **Data read from the document:** "Show data read" moved here. It is offered once the phone read code lines or the server processed any photo. It shows the phone's lines, the server's lines (with the differing characters highlighted when both exist) and the printed fields, including the card sub-type, which appears nowhere else. Same rules as M2: audited before decryption, memory only, 60 seconds, "Hide", `translate="no"`, never for admins.
- **Photos:** a photo replaced by a newer one carries the badge "Replaced by a newer photo". Its file is erased.
- **Label:** "Titre de séjour ou carte de réfugié / Residence permit or refugee card", as on the rider's side.
- **Dev previews:** `case-data-differs`, `case-data-permit`, `case-data-licence`, `case-pending`, `case-unchecked`, `case-mismatch`; the existing case screens now include server checks.

## Edge Functions
### flow
- `POST /flow/document-type`: warm-up ring (test sessions, or every session once the switch is on).
- `POST /flow/captures`: after recording the photo, it removes the files of the photos it replaced, decides the case-level checks again without them, and rings the worker when the photo's job is waiting. The `capture.create` audit entry now also holds `replaced` (how many photos were replaced). A retried request finishes what the first one may not have done. It now also refuses a photo whose long side is over 1,600 px (`422 image_too_large`): the app never sends one, and the worker would refuse it.
- **New `GET /flow/checks`** → `FlowChecks`: `{done, sides: [{kind, captureId, state, reason}]}` for each required side.
  - `pending` while the job waits or runs.
  - `unchecked` at once when the job failed, or is still waiting after a failed ring.
  - `retake` only for `no_document` or `unreadable`, only if the side has not had its one server retake, and never when the phone read every check digit right.
  - `ok` otherwise.
  - `409 missing_sides` when a required side has no live photo, `409 already_submitted` after the submit. Nothing personal is ever returned.
- `POST /flow/submit` is unchanged.

### worker (new)
See "The worker API and its security" above. `verify_jwt = false` in `supabase/config.toml`, like the others: the function checks the signature itself.

### admin
`POST /admin/document-data` returns the new item kinds: `lines` for `mrz_phone` and `mrz_server`, `fields` for `ocr_server`. Only data from live photos is returned. The access rules and the audit-before-decrypt order are unchanged.

### Contract additions (`contract.ts`)
- `FlowChecks`, `FLOW_CHECK_STATES`, `RETAKE_REASONS`, `CHECKS_WAIT_MS` (20,000), `CHECKS_POLL_MS` (2,000), `SERVER_RETAKES_PER_SIDE` (1).
- The worker API: signature constants, headers, request and response types, `WORKER_LIMITS`, and `KEYWORD_GROUPS` (generic group names; the server refuses any other key).
- The details stored per server check: `SERVER_CHECK_NAMES`, `DETECTED_DOCUMENT_TYPES`, `POLICY_REASONS`.
- `DocumentDataItem` becomes a union: lines items (`mrz_phone`, `mrz_server`) and fields items (`ocr_server`).
- Error codes `invalid_signature` (401), `replayed_request` (401) and `image_gone` (410).

## Database changes (migration `supabase/migrations/20261016000000_m3_worker.sql`)
The migration needs PostgreSQL 16 or later (it uses `IS JSON OBJECT`).

- **New tables.** All have Row Level Security on and every right revoked from `anon` and `authenticated`: only the Edge Functions (service role) reach them. The one exception: signed-in staff may read three columns of `worker_job` (`capture_id`, `verification_id`, `status`), under the same rule as the photos (supervisors all cases, reviewers their assigned ones), so the case page can tell per photo whether the server is still working on it.

  | Table | What it holds |
  |---|---|
  | `worker_settings` | one row: `enabled_for_real_sessions` (default **false**) and `daily_job_cap` (default 150) |
  | `worker_key` | `kid`, `public_key` (base64url of the 32-byte Ed25519 key), `revoked_at` |
  | `worker_nonce` | each accepted nonce until it expires (its timestamp plus 2 minutes) |
  | `worker_job` | one per document photo: status (`pending`, `claimed`, `done`, `failed`, `superseded`), attempts (at most 3), lease, error code (`budget`, `ineligible`, `attempts`, `expired`), `ring_failed_at`, and `evidence` |

  `evidence` is what the case-level decision keeps from a result: generic codes, counts and flags, never a value read from the document. Staff cannot read it, nor the attempts, leases and error codes.
- **`capture.superseded_by`:** the newer photo that replaced this one. A replaced photo is always marked erased.
- **`check_result`:** new names `quality_server`, `mrz_server`, `ocr_fields` (per photo) and `classification`, `document_policy` (per case, at most one of each, by a unique index where `capture_id` is null). Replaced photos keep their old check rows; everything shown uses live photos only.
- **`extracted_document_data`:** new sources `mrz_server` (the server's code lines, after the shared corrector) and `ocr_server` (the printed fields as a JSON object, including the card sub-type). `format` is now required only for code lines. Both are encrypted exactly like the phone's lines (same Vault key, AES-256).
- **Functions** (service role only, `search_path` empty):

  | Function | Purpose |
  |---|---|
  | `worker_use_nonce` | accepts a nonce once, after the signature check |
  | `worker_claim` | hands out the next job (rules above) |
  | `worker_image_lookup` | where the leased photo is, or `gone` / `not_found` |
  | `worker_case_snapshot` | the case's inputs and fingerprint |
  | `worker_record_result` | everything from one result in one transaction: per-photo checks, encrypted rows, evidence, case-level checks, and the audit entry `worker.result` with outcomes only. First result wins; refused as `stale` if the case changed |
  | `worker_write_case` | rewrites the case-level checks after a photo was replaced |
  | `flow_check_state` | what `GET /flow/checks` needs |

  `flow_record_mrz` now also compares the phone's lines with the server's when the server was first. `staff_read_document_data` returns `lines` or `fields`, from live photos only, and still writes its audit entry before decrypting.

  `private.superseded_files_left()` (administrators only, in the SQL editor) lists the replaced photos whose file is still in the bucket; it is run after the deploy (see "Deploy notes") and should be empty.
- **Locking:** every writer of a case's server checks takes the same per-case advisory lock first, so writers queue instead of deadlocking.
- **pg_net and pg_cron** are enabled inside guarded blocks, so the migration still applies on plain PostgreSQL (CI). The migration stores the ring URL in Vault (`worker_ring_url`, the worker's production address; public) and schedules the job `worker-sweep` every minute when pg_cron is present.
- **CI stub** (`supabase/tests/00_supabase_stub.sql`): stand-ins for `net.http_post` (it records calls, so the sweep's ring is tested), `cron.schedule` and `storage.objects` (so the deploy check on replaced photos' files is tested).

### Operating the worker (SQL, run by an administrator)
```sql
-- Add a worker key (the public key printed by Signer.public_key_b64url() in worker/verify_worker/signing.py)
insert into public.worker_key (kid, public_key) values ('<kid>', '<base64url public key>');
-- Revoke a key (rotation: add the new key, deploy the worker with it, then revoke the old one)
update public.worker_key set revoked_at = now() where kid = '<kid>';
-- Real sessions: ONLY after Vercel Pro and its DPA are in place
update public.worker_settings set enabled_for_real_sessions = true, updated_at = now();
-- Daily cap (jobs claimed per day, Douala time)
update public.worker_settings set daily_job_cap = 150, updated_at = now();
```

## The Python worker (`worker/`)
Python 3.12, one Vercel function (`api/process.py`, project `confiance-verify-worker`, region `cdg1`, no Git deployments, 120-second maximum duration). Details: `worker/README.md`.

| Step | Module | What it does |
|---|---|---|
| Bytes | `imaging.py` | size and SHA-256 must match the claim; decoded only by Pillow's JPEG decoder; long side at most 1,600 px; in memory only |
| Quality | `quality.py` | the phone's maths, ported (identical numbers on 13 reference images) |
| OCR | `ocr.py` | RapidOCR 3.9.2 with PP-OCRv6 detection and recognition ("small" models, from the rapidocr wheel; SHA-256 checked at load; explicit paths, so nothing is ever downloaded); the line-orientation classifier is off; Greek and Cyrillic look-alike letters mapped back to Latin |
| Rotation and type evidence | `classify.py` | tries the likely rotation first (the new cards' upright front arrives sideways), another only when the first reads too little; keyword-group counts; QR code **detected, never decoded** |
| Code lines | `mrz.py` | picks the candidate lines; no correction (the Edge Function does that). A row in capitals is never a candidate on its look alone: it needs fillers, the birth/expiry pattern, or a TD1/TD3 header with a filler or the document number's check digit in place and right (exact arithmetic on the characters as read), or a header with a digit in the number while sitting directly above line 2 at code-line spacing. So parents' names and titles do not leave the worker, even with a letter misread as a digit (every single misread of the test names stays out; a name would need a digit exactly at the check digit's place, and the right one). On the server, candidates exist only inside the corrector: only the expected lines are kept (encrypted), the others are discarded unlogged |
| Fields | `fields.py` | documents with code lines: full names and issue date only. Others: names, document number, birth, expiry and issue dates. **Never** parents' names, address, height, place of birth, occupation, distinguishing marks, the 17-digit unique identifier or the passport's card access number. Values sent upper case without accents (HÉLÈNE → HELENE) |
| Logs | `log.py` | event codes, exception class names and numbers only; third-party loggers at ERROR |

**Configuration** (Vercel environment, production only): `SUPABASE_WORKER_URL`, `SUPABASE_PUBLISHABLE_KEY` (public), `WORKER_KEY_ID`, and `WORKER_SIGNING_KEY` (**secret**, marked sensitive: base64url of the 32-byte Ed25519 seed).

**Dependencies:** exact pins in `pyproject.toml` and `uv.lock` (with hashes; nothing newer than 2026-10-01). An override keeps OpenCV's GUI build (Qt, LGPL-3.0) out. The one package without a wheel (`antlr4-python3-runtime` 4.9.3) is built with a pinned setuptools. Licences, and the native libraries inside each wheel: `LICENSES.md`.

**Measured on the development machine** (1 thread, 1,280 px photos; reported by the tests, never asserted):
- about **3.1 s of CPU per photo** (median) when the first rotation tried is right;
- **5–9 s** when a second rotation must be read (an upside-down page, a card turned the other way, an old card declared as a new one);
- about 2 s for a photo with no text;
- 0.8 s to load and check the models; peak memory 467 MiB.

**Test documents** (`e2e/fixtures/specimens/`, 27 photos, 2.7 MB, `manifest.json`): our own fictitious SPECIMEN documents, drawn by `scripts/make-specimens.py` in Inter and OCR-B. They cover every accepted document, both sides, the upright new-card fronts in both directions, and degraded variants (glare, blur, JPEG, upside down, sideways), plus `blank-card.jpg` (a sharp card with no text: should give `unreadable`) and `no-document.jpg` (should give `no_document`). **They prove the plumbing, not accuracy on real cards:** we drew the keywords ourselves.

## Where data read from a document may appear (privacy rules)
| Place | Values read from the document? |
|---|---|
| The worker on Vercel | In memory during the job only: the photo, the OCR text. Never written to disk, never logged. Raw OCR text never leaves the process. |
| `POST /worker/result` | Candidate code lines and the selected fields only (HTTPS), on their way to the database |
| `worker` and `flow` Edge Function logs | Never: codes only |
| `extracted_document_data` | Encrypted only: phone lines, server lines, printed fields and the card sub-type |
| `check_result.details` | Never: outcomes, generic codes, measures (with the number of text lines), and field **names**. Never the card sub-type, a nationality, or keyword counts (which would tell a Cameroonian passport from a foreign one); the database refuses any other key in the classification. |
| `worker_job.evidence` | Never: generic family codes, keyword-group counts, flags; not readable by staff |
| `audit_event` | Never: `worker.image` `{jobId, attempt, verificationId, byteSize}`, `worker.result` `{jobId, captureId, attempt, checks: outcome per check}`, `worker.job_failed` `{jobId, captureId, code, attempts}`, `capture.create` adds `replaced` |
| `GET /flow/checks` | Never: states and generic reasons |
| pg_net's response table | Never: `{"ok":true}`, kept 6 hours |
| Vercel's request log | Never: "POST /api/process" and the status |
| Dashboard | Field names in "Server checks"; values only through "Show data read" (audited, 60 s, memory only) |

The recognised family says whether the card is a new CNI (Cameroonian holder) or a residence card (foreign holder), as the rider's own choice of document already does. The nationality itself, and which residence card it is (séjour, résident, refugee), are stored only encrypted.

## Our own MRZ model (`training/mrz/`)
**Status: the training pipeline is built and smoke-tested from start to finish. The full run (about 6.5 hours) has not been launched yet, so no candidate model exists. Doubango stays on the phone.**

- **Recipe** (`training/mrz/README.md`, one command per stage, resumable): Tesseract's own training tools (tesstrain), the same engine the phone already runs, so a new model is just a new file under a new path (`/ocr/mrz-2/`). Every input is pinned with its SHA-256 (`inputs.json`).
- **Training data, all fictitious:** 80,000 lines.
  - Half come from whole document photos we draw, passed through the rider's own locate and prepare steps, then cut where Tesseract itself cuts each line. This targets the research's main failure (the first character of a line).
  - The other half are single lines with the research's distortions.
  - No real document image is ever used for training.
- **Run 1, from zero** (cleanest provenance): 150,000 iterations, about 4.5 hours on 4 processors. **Run 2, fallback:** fine-tune Google's `eng`, 30,000 iterations, about 2 hours.
- **Gates** (`gates.json`; `bin/60-gates.sh` writes a report and exits 0 only on a full pass):

  | Gate | Pass |
  |---|---|
  | G1, line error rate on held-out lines | clean ≤ 0.5% and ≥ 98% lines exact; low resolution ≤ 1.0%; degraded ≤ 10%; never worse than Doubango |
  | G2, wrong reads that pass every check digit, on 1,000 documents from another renderer, through the real rider pipeline | **exactly 0** |
  | G3, the same 1,000 documents | valid and exact ≥ 97% and ≥ Doubango; names line exact ≥ 99% |
  | Repository fixtures | 6/6 |
  | Size | ≤ 1.5 MB gzipped |
  | G4, the PM's own test-session photos, offline | at least Doubango's valid rate, zero wrong-but-valid (manual) |

- **Doubango's baseline** (`results/baseline-doubango.json`): G1 clean 0.014%, low resolution 0.922%, degraded 5.457%. On the first 200 benchmark documents: 196 valid and exact, 3 invalid, **1 wrong but valid**.
- **A decision is needed before G2 can pass.** Doubango's one wrong-but-valid read was caused by the shared corrector, not the model: the OCR read the line exactly, then the corrector turned a real `K` in an optional-data field into `<`. No check digit can tell `K` from `<` (both count 0 modulo 10 in every weight), so this will happen a few times per 1,000 documents whatever the model. Either change the corrector, or judge the model alone (`G2.countCorrectionCaused: false`). The gate report already lists these reads separately.
- **Shipping a model that passes:** the integer model under `/ocr/mrz-2/` (cache key `ocr-mrz-2`), its notice, its row in `LICENSES.md`, the fixture test, then G4 on the PM's photos. If none passes, Doubango stays and this section records it.

## Tests
- **Edge Functions** (vitest, in-memory fakes):
  - every refusal of the worker API in its order: headers, window, body cap, unknown or revoked key, small-order key, bad signature, replayed nonce, `Origin`;
  - strict validation;
  - the decision tables (quality, code lines, classification, reasons);
  - the stale-and-retry path;
  - `GET /flow/checks` states and retake rules;
  - rings (timeout; a 429 tried once more, then a failure; failure);
  - replaced photos;
  - a fixed message for every new error code.
- **Signatures:** fixed vectors (RFC 8032 test key), produced identically by Node's WebCrypto and the worker's Python `cryptography`.
- **Database** (`supabase/tests/40_m3_test.sql`):
  - no access for the API roles, except staff reading each job's status (three columns, same rule as the photos);
  - claim, lease, attempts, the switch and the cap;
  - supersession;
  - first result wins, and stale refusals;
  - erased photos;
  - nothing personal in `details`, and no key outside the contract's in the classification (keyword counts refused);
  - the phone comparison in both orders;
  - the sweep (requeue, give up, ring through the pg_net stand-in);
  - audit order and the hash chain;
  - the "names the code relies on" checks.
- **Worker** (`cd worker && uv run pytest`; without the models: `-m "not ocr"`):
  - signing;
  - byte checks;
  - quality parity with the TypeScript;
  - text normalisation;
  - code-line candidates, including that parents' names and bilingual titles in capitals are never candidates, even with any one letter misread as a digit;
  - classification;
  - fields, including that a never-read field's value never comes out, neither as a field nor as a candidate;
  - the ring loop against a fake API;
  - the HTTP handler;
  - log hygiene;
  - the deploy settings, and that every runtime package without licence text is in `worker/NOTICE`.

  The real-OCR run reads all 27 test photos. An integration test runs the server's own corrector and parser (in Deno) on the worker's candidates: on every readable test document they give exactly the printed lines, with every check digit right.
- **Rider:** the reducer (retakes, limits, overrides, both sides, the code-lines side), polling, timeouts, the split uploader. The hook that wires them (`useFlow.ts`) needs the browser tests.
- **Dashboard:** the parsers (extra keys never get through), the server-check rules, the data viewer's comparison.
- **Browser tests (Playwright),** as planned: all checks fine; a retake of the front, of the back, of both, and of the code-lines side; the retake limit; the timeout; `unchecked`. The fake backend answers `GET /flow/checks`. See `e2e/README.md`.
- **CI,** as planned: a Python job (`uv sync --frozen`, `uv lock --check`, `pytest`, and the Python licence check with the reviewed list of native libraries) and the move of the database job to PostgreSQL 17.

## The PM test (after deploy)
**Use test sessions only** (dashboard → **New test session** → **Debug link**). Real sessions are not checked while the switch is off. Use only your own documents, or those of colleagues who agree. **Never paste data read from a document into a chat or a ticket:** say which field was wrong, not what it said.

**Documents to try**, one test session each:
1. Passport (Cameroonian, and a foreign one if you can).
2. New CNI (2025).
3. Old CNI.
4. Driving licence.
5. Voter card.
6. Residence permit or refugee card, only if a consenting colleague holds one.
7. **Retake test:** choose "Old national ID card" and, for the front, photograph a blank plastic card (no printing at all) on a dark table. If the phone accepts it, you should get "Recto : photo à reprendre" with "Texte illisible…". Retake with the same blank card: the second time it is kept, and the dashboard shows "No readable text". If the phone refuses the blank card itself, skip this test (the browser tests cover it).
8. **Timeout test:** open a debug link with `&checksWaitMs=3000` added after `?debug=1` (before the `#`). The phone should continue after 3 seconds as if nothing happened.

**What counts as a pass for M3:**

| Check | Pass |
|---|---|
| Every photo gets a server result | Within about 20 s on the phone, or later on the dashboard (refresh). The first photo after a quiet period may be slow (cold start); "Not checked" must come with its reason. |
| Passport and new CNI (firm) | "Document recognised" = the declared document, from the code lines, ✅. Server code lines found, every check digit ✅, **"Same lines as read on the phone ✅"**. "For a person to decide" says "The server checks flagged nothing". |
| Residence permit or refugee card, new model | Recognised from the code lines; "Always checked by a person" (expected for every residence card). |
| No false retake | A good, sharp photo is never sent back to the camera. |
| Retake test | Exactly one retake, then the photo is kept and flagged. |
| Show data read | The server's code lines identical to the phone's; names and issue date right (accents dropped). Each view appears in the audit log. |
| Privacy | Nothing read from the document appears anywhere but "Show data read". |

**Measured, not passed or failed** (provisional, to be tuned with your photos): the type of the old CNI, driving licence and voter card (expect "Type recognised provisionally", or "Document not recognised" when the printed title was missed, and "Always checked by a person"), and which printed fields were found and right on those documents. Please report, per document: the type shown, which fields were wrong or missing, the processing time shown per side ("models loaded first" marks a cold start), and screenshots of the "Server checks" section. The screenshots show no values.

**Specimen photos (next step, tuning).** With the lawyer's consent form, volunteers' own documents only, front and back, sharp and without glare, on 2–3 phones (Tecno, Itel, Samsung A) in good and dim light:
- the new CNI (at least 8 people);
- the old CNI (at least 8);
- the Cameroonian passport (at least 5), and foreign ones if possible;
- the new carte de séjour and carte de résident (at least 3 each), the old blue permits, refugee cards;
- driving licences of every model in circulation;
- voter cards from different periods.

Staff type the true values in the test project only. The same photos serve G4 for our MRZ model (never for training).

## Changes from the approved plan
- **"Small" OCR models instead of "tiny" detection.** The rapidocr 3.9.2 wheel ships only the small detection and recognition pair, and nothing is downloaded at run time. A photo costs about 3 s of CPU, not 2 s; 5–9 s when a second rotation is read.
- **The bundle is about 377 MB, all of it bundled.** It is under Vercel's 500 MB limit, but over its 225 MB standard size. By default Vercel would then install part of the packages from PyPI **on every cold start** (possibly the rapidocr wheel with the models): slower cold starts, extra CPU, a dependence on PyPI. `worker/vercel.json` sets `VERCEL_PYTHON_DISABLE_RUNTIME_INSTALL=1` at build time, so everything is bundled and nothing is downloaded at run time. Whether Hobby accepts a bundle that large is checked at deploy (below); if not, the slim OpenCV build (OpenCV alone is 160 MiB) comes first.
- **120-second maximum duration** for the function (Hobby allows 300). The worker stops claiming after about 50 seconds; a lease lasts 120.
- **Field values in ASCII without accents** (HÉLÈNE → HELENE): the server accepts printable ASCII only. Widening it to accented letters is a one-line change on each side if staff need accents.
- **Every residence permit goes to a person**, not only refugee cards, so that the reason never reveals a refugee card. The card sub-type is visible only through "Show data read".
- **Any newer photo of a side replaces the older one**, not only after a server retake. The replaced photo is erased and the data read from it deleted. Its check rows stay, and the dashboard shows only live photos.
- **Claims are serialised by one lock, and a busy case is skipped** (instead of `FOR UPDATE SKIP LOCKED` alone), so the daily cap is exact.
- **The nonce is recorded by its own function** after the signature is verified, not by the claim, so that every signed route has the replay guard.
- **Small-order public keys are refused**, because WebCrypto accepts them and anyone could then forge a signature.
- **Case-level checks are written only if the case has not changed since the snapshot** they were decided from (two photos finishing at the same moment). The database itself maintains `server_unchecked`, `phone_report_missing` and `mrz_disagreement`.
- **`KEYWORD_GROUPS`** was added to the contract (additive), so the server can refuse any other key.
- **`WorkerQuality.sharpness` is the phone's noise-free focus score**, the value the phone compares with 5, not the raw Laplacian variance.
- **A ring still running after 30 s counts as reached; a ring answered `429` is tried once more, then fails.** The firewall's rate limit is sized so that our own rings never meet it.
- **Two more generic reasons:** `mrz_invalid_server` (the server read the expected code lines and they fail their checks) and `unrecognised_document` (nothing recognised; `provisional_classification` now means "recognised from printed words" only).
- **No keyword counts on the dashboard or in `check_result`:** they stay in the job's evidence (see "Per case").
- **`GET /flow/checks` also answers `409 missing_sides`** when a required side has no live photo.
- **Staff read each job's status** (`capture_id`, `verification_id`, `status` of `worker_job`, nothing else), so the dashboard decides "waiting" or "not checked" per photo instead of from the case-wide `server_unchecked` reason, and shows photos taken before M3 as never sent.
- **The rider also skips a retake after an override** ("Use it anyway", "Continue anyway"); the server alone could not know about overrides.
- **The model's G2 gate counts reads made wrong by the corrector.** A decision is needed (see "Our own MRZ model").

## Known limits
- **Not tested on real documents yet.** Classification by printed words, field reading, date formats, rotation and the quality limits were tuned only on our own renders. All are shown as provisional; the PM's photos tune them.
- **Vercel Hobby, testing only.**
  - Its terms allow only non-commercial personal use, and it comes with no DPA. Vercel Inc. is a US company, even though the function runs in Paris.
  - The switch stays off until Vercel Pro and its DPA are in place, and the lawyer has agreed. See `THREAT_MODEL.md`.
- **CPU budget: 4 CPU-hours a month.**
  - At the measured speed that is roughly **3,000–4,000 photos**, fewer with many cold starts (each loads the models).
  - At the full daily cap every day (150 jobs, about 3 s each), the cap alone would use about 3.9 CPU-hours over 30 days. The cap is therefore a ceiling for testing, not a target.
  - What Vercel does once the allowance is used must be checked on the Usage page. The flow already copes with a worker that does not answer: photos become "unchecked" and staff review them.
- **Cold starts are likely** (Hobby cannot keep the function warm): the first photo after a quiet period may miss the 20-second wait. The rider then continues; the result arrives on the dashboard later.
- **A forged document still passes the check digits:** they are public arithmetic. M3 closes a narrower gap: lines that never came from the photo (a modified app) now show "Not the lines read on the phone". In Phase 1 a person reviews every case.
- **Exact comparison:** a single different character between the phone's and the server's reading gives "differs", and `mrz_disagreement` when the server read lines. Staff then compare in "Show data read".
- **Old documents** (old CNI, old permits, driving licence, voter card) carry nothing a machine can check; they always go to a person.
- **Not yet checked on the real platforms:**
  - Ed25519 on Supabase's Edge Runtime: a smoke test after deploy, with `@noble/ed25519` (MIT) as the fallback;
  - pg_net and pg_cron, tested only against stand-ins;
  - the "skip a busy case" paths of the claim and the sweep (a single-session SQL test cannot exercise them).
- **Best effort after a replaced photo:**
  - if removing the old file fails, the file stays, with its row marked erased (logged). `private.superseded_files_left()` lists such files; nothing removes them automatically yet: the retention job (M13) must (open item in `THREAT_MODEL.md`);
  - if re-deciding the case fails, it is logged, and the next result for that case corrects it.
- **A late result from an earlier attempt is accepted** while the job is pending, claimed or failed (the first result wins). A job given up as `ineligible` after one attempt can therefore still record that attempt's result.
- **The QR code on the new cards is only detected**, never read; its signature cannot be checked without the issuer's certificate.
- **Storage egress:** each photo the worker checks leaves Supabase once more (the worker function downloads it and relays it). On the Supabase Free plan this counts against the monthly egress allowance; at about 300 KB per photo it is small for testing.
- **The dashboard has no browser tests** (as in M2): its logic is unit-tested, its layout was checked by screenshots.

## Deploy notes
The order matters. From the moment the migration is applied, its trigger marks the older photo of a side as erased and replaced whenever a newer one arrives, but only the M3 `flow` function removes the replaced photo's file. The M2 `flow` never does: every photo a rider replaced while it still served would keep its file for good, with its row saying it is erased. So the migration and the three Edge Functions go out together, before anything else. The M3 functions do not need the worker to be ready: until Vercel answers, every ring fails, so each photo is reported "unchecked" at once and riders are never held up.

1. **Database and Edge Functions, in one sitting:**
   - apply the migration. It enables pg_net and pg_cron, stores `worker_ring_url` in Vault and schedules `worker-sweep`;
   - **straight away**, deploy `flow`, `admin` and `worker` (with its `[functions.worker]` settings), and set `WORKER_RING_URL` for `flow` explicitly in production (the test environment defaults to the Vercel address);
   - check on the live project: `net.http_post` has the expected signature, and `select jobname, schedule from cron.job;` lists the sweep. The security advisor will report "RLS enabled, no policy" (INFO) for the four new tables. This is intended;
   - **check that no replaced photo kept its file:** `select * from private.superseded_files_left();` (SQL editor, as an administrator) must return no row. If it lists any (photos replaced in the minutes between the migration and the functions), remove those files from the `id-captures` bucket through the Storage API or the dashboard's Storage page, never by SQL on `storage.objects`, then run it again.
2. **Publish the dashboard and the rider app.** The dashboard reads `capture.superseded_by` and the new check names; the rider app shows "Checking your photos…" and is needed for the live runs.
3. **Worker key pair**, generated with `umask 077` and never printed:
   - the private seed goes to Vercel as a sensitive production variable, then the file is shredded;
   - the public key goes into `worker_key` (SQL above).
4. **Vercel project `confiance-verify-worker`:**
   - root `worker/`, region `cdg1`, no Git deployments;
   - set the four variables (above), deploy to production, and use the production address (it must be the `WORKER_RING_URL` set in step 1 and the `worker_ring_url` in Vault);
   - **check that everything was bundled:** the build log must not say "Bundle size … exceeds the standard size; optimizing dependencies" (the install-on-cold-start mode), and the function's files must not contain `_uv/_runtime_config.json`. They must contain `NOTICE` (the licences of the wheels that ship none). Record the bundle size and the result. If Vercel refuses the bundle on Hobby, keep the flag and do the slim OpenCV build first;
   - **firewall:** allow only `POST /api/process`, and rate-limit it **per IP address, at no fewer than 30 requests per 60 seconds**. Our own rings come from a few Supabase addresses that every rider shares: one session sends at most five rings in a minute or two (the warm-up, two photos, two retakes) and the sweep one a minute while a job waits, so 30 leaves room for several testers at once. A stranger's address is held to 30 wake-ups a minute, each of which finds no job and stops (the models load only after a claim). Record the rule (key, threshold, window). A ring refused anyway (429) is tried once more after a short pause, then the photo is reported unchecked and the sweep rings again within a minute.
5. **Ed25519 smoke test** on the Edge Runtime: a ring with a job waiting must end with the job `done` (the `worker` function verified the worker's signatures).
6. **Live runs** in headless Chromium with the test photos: passport, new CNI, old CNI, driving licence, and the blank card (`unreadable`, one retake).
   - Each run is checked for: the checks screen, `check_result`, encrypted rows with no plaintext, and the audit chain.
   - Cold and warm times (median and 95th percentile) and the CPU used are measured.
   - Also checked: unsigned, replayed and wrong-audience requests are refused; the sweep rings a stuck job; a real session is not processed; `private.superseded_files_left()` is still empty after the retake run.
7. Then the PM test above.

## Out of scope for M3
- Expiry, age, and code lines compared with printed text: M4.
- Reading the new cards' signed QR code: needs the issuer's specification and certificate (to request from the DGSN).
- Tampering, screen and photocopy detection: M11. Face and liveness: M5–M7.
- Turning on real sessions: after Vercel Pro, its DPA and the lawyer's agreement.
- The slim OpenCV build (no FFmpeg, no old OpenSSL, no Intel IPP): before the pilot.
- Tuning on real photos: the step after the PM test.

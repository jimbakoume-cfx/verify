# Confiance Verify: Plan v2 (Supabase + Netlify), approved 2026-10-13

## Context
Confiance needs to verify rider identity (KYC) at signup, entirely in-house: no KYC vendors, and every ID image and biometric stays on systems we control. The `jimbakoume-cfx/verify` repository is empty, so we are starting from scratch.

**Decisions you have made:**
- Verify is a **standalone web platform**. The ride-hailing app connects to it through an API.
- The backend uses **Supabase** for now.
- Test sites go online on **Netlify**.
- Volume is **under 500 signups per day**.

This is the approved plan. Open questions are tracked in section 1.

---

## 1. Remaining questions (none block M0–M3)

| # | Question | Needed before |
|---|---|---|
| Q1 | Speed target (e.g. 99% decided in under 10 s) | M8 |
| Q2 | Maximum retries after a rejection (I suggest 3 per 24 h, then manual review only) | M10 |
| Q3 | Image retention period (lawyer). Also, can we keep a text record (name, ID number, decision) longer than the images? | M13 |
| Q4 | **Duplicate detection.** Should we flag the same ID number or the same face on two rider accounts? This catches a lot of fraud, but means storing a one-way fingerprint of the ID number and a face template. It is a privacy trade-off for the lawyer. | M8 |
| Q5 | ~~**Foreign riders.**~~ **Answered 2026-10-14:** passports of any country; Cameroonian residence permits (carte de séjour, carte de résident, new and old) and refugee cards, the latter two always reviewed by a person. See "Decisions for M3". | M3 |
| Q6 | ~~**Voter card and driving licence.**~~ **Answered 2026-10-14:** accepted, always manual review. | M3 |
| Q7 | Specimen images of each document version (old and new CNI, fronts and backs). Decree 2025/059 confirms that the new CNI (2025) carries 3 code lines (TD1) and a QR code on its back; still to see on a real card: the document code in the code lines, the number formats and the label wording. **Needed for the tuning step after M3** (list in `M3_SPEC.md`). | After M3 |
| Q8 | ~~**Where the "AI worker" runs.**~~ **Answered 2026-10-14:** Vercel (Python function, Paris region), free Hobby plan **for testing only**; Vercel Pro and its DPA before real riders. See "Decisions for M3". | M3 |
| Q9 | **Supabase region and plan.** I suggest Paris (`eu-west-3`) on the Pro plan (about $25/month). The free plan pauses after a week without activity and has no backups. **The lawyer must confirm that EU storage is acceptable before real riders use it.** | M0 (region), M14 (lawyer) |
| Q10 | Do you have a security engineer (staff or contractor) for the reviews in section 6? | M9 |

---

## 2. Architecture and tech stack

### What Supabase and Netlify each do
```
Confiance ride app/backend ──(API key)──► Supabase Edge Function "sessions" → session link
        │
        └─ opens link ─► Rider web flow (React PWA, FR/EN) ── hosted on Netlify (code only)
                           consent → ID capture → liveness → submit
                           │ images uploaded DIRECTLY to Supabase Storage (private bucket)
                           ▼
                Supabase: Postgres + Storage + Auth + Edge Functions + Queues
                           │  job placed in queue
                           ▼
                AI worker (Python container): OCR, face match, anti-spoofing, tampering
                           │  results written back to Postgres
                           ▼
           Edge Function "decide": risk score + thresholds → approve / reject / review
                  ├─► signed webhook to the Confiance backend
                  └─► Ops dashboard (React, on Netlify; staff log in via Supabase Auth + 2FA)
```

- **Netlify only hosts the web pages' code.** No ID image or personal data ever passes through Netlify; phones upload straight to Supabase. Each change gets its own Netlify preview link, which is ideal for testing on your phone.
- **Supabase replaces most of what I had planned to build:**
  - Database: Postgres.
  - File storage: Storage, with private buckets and short-lived links.
  - Staff login with 2FA: Auth.
  - Job queue: Queues.
  - Secrets: Vault.
  - API: Edge Functions, written in TypeScript.
  - Role-based access: enforced in the database with "Row Level Security" rules, which are hard to bypass by mistake.
- **One thing Supabase cannot do: run our AI models.** Edge Functions are limited to a couple of seconds of CPU and 256 MB of memory. OCR, face matching and anti-spoofing therefore run in **one small Python worker** (see Q8).
  - **As built in M3:** a Vercel Python function in Paris. Supabase rings its doorbell; the worker then claims jobs from a `worker_job` table through a signed Edge Function, fetches each photo through it, and sends its evidence back. The Edge Function decides and writes the results.
  - The worker holds no database credential. The same code runs on Vercel Pro or any container host.
- **Staying portable and standalone.** Supabase is open source (Apache-2.0) and can be self-hosted. If the lawyer later requires hosting in Cameroon, we move the same database, functions and worker to our own server without rewriting. Netlify pages are plain files that can be hosted anywhere. I will not use Netlify-specific features (Netlify Functions, Forms, Identity), so we are not locked in.
- **The rider never logs in to Verify.** The Confiance backend asks for a single-use session link that expires after 30 minutes. The app opens it in a Chrome Custom Tab or WebView. The app then learns the result from a signed webhook. Drivers can be added later by using a different `subject_type`.

### Trade-offs to know about
1. **Data location.** In the test phase, real ID images will sit in Supabase's EU region. That is fine for consenting volunteers, but the lawyer must approve it before launch (Q9).
2. **Encryption.** Supabase encrypts all stored data on disk. I will *also* encrypt the most sensitive database columns (ID number, name, date of birth) inside the database; since M2 this covers the MRZ lines read on the phone, and since M3 the code lines and printed fields read by the server (see `THREAT_MODEL.md`). Per-image encryption with our own keys is extra work; I propose deciding on it with the security engineer before launch.
3. **Web flow vs native app.** A browser camera gives slightly less control than a native app. My mitigation: auto-capture, plus a server-side quality re-check that asks the rider to retake bad photos (in place since M3, for test sessions until the worker's switch is turned on).

### Stack and licences (all allow commercial use)
| Area | Choice | Licence |
|---|---|---|
| Backend platform | Supabase (Postgres 15+, Auth, Storage, Edge Functions on Deno, Queues/pgmq, Vault) | Apache-2.0 / PostgreSQL / MIT (open source, self-hostable) |
| Hosting of web pages | Netlify (a hosting service, not a library) | Commercial service; terms checked for production |
| Web pages | React, TypeScript, Vite, i18next, supabase-js | MIT, Apache-2.0, MIT, MIT, MIT |
| MRZ parsing and check digits | **Written by us** in TypeScript, following ICAO 9303. The same code runs on the phone (instant feedback) and on the server (the authoritative check). | Ours. The popular `mrz` library is GPL, so we avoid it |
| MRZ reading on the phone (since M2) | tesseract.js 7 with DoubangoTelecom's MRZ model; since M4, test sessions read with our own model (trained in M3 on fictitious renders only, fine-tuned from Google's `eng`), which passed its automated gates and awaits G4 | Apache-2.0 (engine); BSD-3-Clause (Doubango's model, checked 2026-10-13; trained by its authors on images collected from the web); Apache-2.0 (our model, derived from `eng`); see `LICENSES.md` |
| AI worker (M3) | Python 3.12 on Vercel, headless OpenCV, NumPy, Pillow, ONNX Runtime, cryptography (Ed25519) | PSF, Apache-2.0 (OpenCV; its wheel bundles LGPL and other parts, documented), BSD-3 and others, MIT-CMU, MIT, Apache-2.0 / BSD-3 |
| OCR, printed text FR/EN, and the server's re-read of the code lines (M3) | RapidOCR 3.9.2 with the PP-OCRv6 "small" models (no Tesseract on the server: its packages bring GPL code) | Apache-2.0 (code and models) |
| Face detection, landmarks and alignment (since M6, on the face worker) | MediaPipe Face Landmarker's three models (from Google's `face_landmarker.task`), run on LiteRT with MediaPipe's pipeline written out by us (the `mediapipe` package is too large for Vercel beside AuraFace). **Not YuNet, not SCRFD** (PM decision) | Apache-2.0 (models, LiteRT) |
| Live face guidance on the phone (blink, head turn) | MediaPipe Face Landmarker (the only face detector allowed: green in `docs/research/FACE_MODELS.md`). **Not on the phone in M5:** too heavy a download (see "Decisions for M5"); the phone checks brightness only, and M6 runs MediaPipe on the server | Apache-2.0 |
| Passive anti-spoofing | **Since M6: our own provisional cues** (moiré, screen glare, low detail; heuristics, no model) and the flat-plane check from the landmarks. Our own detectors later, trained on consented attack captures (`training/antispoof/`). Silent-Face-Anti-Spoofing allowed as a low-weight test-only signal, **not shipped** (see "Decisions for M6") | Ours |
| **Face matching** (since M7, **test sessions only**) | **AuraFace v1 `glintr100.onnx` only** on ONNX Runtime; uncalibrated threshold, review-only unless the threshold version lets it count (automatic approval, 2026-10-20). **Before the pilot: a paid licence, a vendor SDK or our own model** (see "Decisions for M7"). SFace and dlib were rejected by the research (`docs/research/FACE_MODELS.md`) | Apache-2.0 on the weights, amber (undisclosed training data); see `LICENSES.md` |
| Risk model (Phase 2) | scikit-learn | BSD-3 |

**Licence warnings:**
- **Ultralytics YOLO (AGPL) and InsightFace / ArcFace models (non-commercial) are excluded**, even though they are popular.
- **Face-recognition weights are the hardest area.** The code licences above allow commercial use, but nearly every public face model was *trained* on photos collected from the internet. Your lawyer should confirm they are comfortable with that.
- **Bias risk.** Public face models often perform worse on darker skin tones. We must measure accuracy on Cameroonian riders before trusting automatic face decisions.
- **Our long-term route** is to fine-tune on our own consented data.
- `docs/LICENSES.md` will record every library and model (version, licence, source, checksum). CI will block forbidden licences (GPL, AGPL or non-commercial).

### How each check works (first version)
- **Classification.** First version uses rules: the MRZ document code (`P`, `ID`, `I<`), OCR keywords ("RÉPUBLIQUE DU CAMEROUN", "CARTE NATIONALE D'IDENTITÉ", "PASSEPORT"…) and layout templates. A small classifier trained on our own data comes later.
- **Consistency.** MRZ vs printed fields, date logic (birth < issue < expiry, age ≥ 18), ID-number format, and expiry date.
- **Signed QR code on the new CNI (idea for M3/M4).** The new CNI (2025) also carries a signed QR code. If we can get the issuer's public key and the signature format, checking that signature would prove the card's data was issued by the State, which check digits cannot (anyone can compute them). To investigate in M3 or M4.
- **Tampering and replay.** Screen moiré patterns, photocopy signals, editing traces and metadata, checks on the portrait area, and the same image re-used across attempts (file hash).
- **Liveness.** The server picks a random 2–3 action challenge bound to a one-time code. **The worker re-checks the actions on the uploaded frames and never trusts the phone.** Passive anti-spoofing is an extra signal.
- **Face match.** Compare the best liveness frame with the ID portrait, producing a similarity score.
- **Risk score.** Phase 1: transparent weighted rules plus "hard flags". Thresholds live in a database table and are versioned, editable from the dashboard without a redeploy, and every decision records the threshold version it used.

---

## 3. Data model and APIs

### Main tables (Supabase Postgres, with Row Level Security on every table)
- `api_client`: the Confiance backend now, driver app later. API key hash, webhook URL and secret (the secret kept in Vault).
- `applicant`: `external_user_id`, `subject_type` (rider/driver), `verified_at`, status.
- `verification`: one attempt. Status, document type, risk score, decision, threshold version, attempt number.
- `consent_record`: consent text version, language, time, device. Since M5, the optional "keep my face images" answer with the version of its wording.
- `capture`: front/back/liveness, storage path, quality metrics, sha256. Since M5, the face check's frames (kind `liveness_frame`), tied to their challenge.
- `liveness_challenge` (since M5): actions, one-time code, expiry, used once. Only the Edge Functions can reach it.
- `check_result`: check name and version, score, pass/flag/fail, details (outcomes and counts only, never personal data). Since M2, tied to the photo it ran on. Since M4, a case-level `consistency` check (generic codes: which flags, which kinds of field disagree, never a value).
- `extracted_document_data`: sensitive fields encrypted; records whether each field came from MRZ or OCR. Since M2: the MRZ lines read on the phone (`source` = `mrz_phone`), encrypted inside the database with a key kept in Supabase Vault. Since M3: the code lines read by the server (`mrz_server`) and the printed fields it read, including the card sub-type (`ocr_server`), under the same key.
- Since M3: `worker_job` (one per document photo: the AI worker's queue), `worker_key` (the worker's public keys), `worker_nonce` (replay guard) and `worker_settings` (the test-only switch and the daily job cap). Only the Edge Functions can reach them.
- `review_task`: priority, assignee, status, timing.
- `decision`: system or reviewer, outcome, reason code, note.
- `reason_code`: FR/EN text shown to riders.
- `appeal`.
- `threshold_config`: versioned; who changed it and when. Since M8: append-only, the highest version is active, each with its reason; the case's assessment is stored on `verification` and each `decision` records the version, the recommendation shown and whether it agreed.
- `staff_profile`: role is reviewer, supervisor or admin; linked to the Supabase Auth user.
- `audit_event`: append-only and hash-chained. No one, admins included, can edit or delete a row.
- `webhook_delivery`.
- `deletion_job`.
- Optional, depending on Q4: `id_number_fingerprint` and `face_template`.

**Image access.** Staff never get direct access to the storage bucket. To view an image, the dashboard calls an Edge Function. The function checks the staff member's role, writes an audit entry, and only then returns a link that expires after 60 seconds.

### API 1: Confiance backend → Verify (Edge Functions; API key + signed requests)
- `POST /sessions {external_user_id, subject_type, locale, return_url}` → `{session_id, url, expires_at}`
- `GET /sessions/{id}` → status, decision, reason codes. **Never returns images.**
- `GET /applicants/{external_user_id}` → `verified: true/false`. Riders are verified once, not on each ride.
- Signed webhooks: `verification.approved`, `verification.rejected`, `verification.in_review`, `appeal.resolved`.

The exact routes, request and response types, limits and error codes of the implemented APIs are in `supabase/functions/_shared/contract.ts`, the single source of truth. The lists below show what exists and what later milestones add.

### API 2: Rider web flow → Verify (single-use session token)
- Since M1: `GET /flow/session` · `POST /flow/consent` · `POST /flow/document-type` · `POST /flow/upload-url` (a one-time upload link to private storage) · `POST /flow/captures {path, kind, quality}` (the server checks the uploaded image) · `POST /flow/submit`.
- Since M2: `POST /flow/mrz` (what the phone read from the code lines; the server recomputes every check digit).
- Since M3: `GET /flow/checks` (the server's check of each photo: pending, ok, retake with a reason, or unchecked; the rider waits for it for at most 20 seconds). Since M4 it also says when the code lines show an expired document.
- Since M5: `POST /flow/liveness/challenge` (a random challenge and its upload slots) · `POST /flow/liveness/captures` (the frames' report; the server checks every file). The submit needs the face check.
- Since automatic approval (2026-10-20): `GET /flow/result` (after the submit: verified, pending or review; nothing else).
- Planned: `GET /flow/status` (result, reason, retries left; M10) · `POST /flow/appeal` (M10).

### API 3: Ops dashboard → Verify (Supabase Auth with 2FA required; enforced by role)
- Queue and case details: read directly via database rules. Each role sees only what it is allowed.
- Since M1: `POST /admin/enroll {email, code, password}` (staff account set-up by one-time invite code) · `POST /admin/test-sessions` (test rider links, until M10) · `POST /admin/captures/view {captureId}` (audited, 60-second link).
- Since M2: `POST /admin/document-data {verificationId}` (the code lines read on the phone, decrypted; audited before decryption; never for admins). Since M3 it also returns the code lines and printed fields read by the server.
- Since M8: `POST /admin/decisions {verificationId, outcome, reasonCode, note}` (supervisor or the assigned reviewer; never admin) · `POST /admin/thresholds {baseVersion, config, note}` (admins only; active at once).
- Search: supervisors and above.
- Thresholds: admins only.
- Metrics, audit log, appeals.

**Roles:**
- Reviewer: only cases assigned to them.
- Supervisor: adds search, appeals and reviewer statistics.
- Admin: adds thresholds, users and audit log, but **no** routine image access.

### API 4: AI worker → Verify (since M3; every request Ed25519-signed by the worker)
- `POST /worker/claim` (the next job, or nothing) · `POST /worker/image` (that job's photo, relayed; no URL ever leaves Supabase) · `POST /worker/result` (the worker's evidence; the Edge Function decides).
- The worker is woken by an empty "ring" that carries no authority: from the `flow` function after each photo, and from a database job every minute while work waits.

---

## 4. Build plan: small milestones you can test on your phone
Each milestone ends with a Netlify link and short test steps. The flow has a "debug panel" showing what the system read.

| M | What you get | How you test it |
|---|---|---|
| **M0** | Repo and CI (tests, licence check, secret scan). Supabase **test project** created (Q9 region) with tables, security rules and private storage. Two Netlify sites (rider flow, dashboard) with automatic preview links. FR/EN hello page. | Open the link on your phone and switch the language |
| **M1** | **ID capture.** Live camera with a card frame, blur/glare/framing hints, auto-capture, crop and compression (target under 300 KB). Upload straight to private Supabase storage. Front and back. | Capture your ID in good and bad light; bad photos are refused with a clear hint. The image appears in the (temporary) admin debug page. |
| **M2** | **MRZ reading.** Read the MRZ on the phone, parse passport (TD3) and the new CNI (2025, TD1), validate check digits on the phone and again on the server. The old CNI has no MRZ. | Scan your passport or new CNI with the debug link: fields shown with ✅/❌ for each check digit; the dashboard shows the server's own check and "Show data read" |
| **M3** | **AI worker goes live (Q8).** On test sessions, the server re-checks each photo's quality (an unusable photo is retaken at once, at most once per side), re-reads the MRZ from the image and compares it with the phone's, recognises the document (firm from code lines, provisional from printed words) and reads a few printed fields. Our own MRZ model's training pipeline and gates. | Scan each document type with a test session: correct type, the server's code lines agree with the phone's, the fields behind "Show data read"; a blank card is sent back once (`M3_SPEC.md`) |
| **M4** | **Consistency checks and first risk flags.** On test sessions the server compares the printed fields with the code lines (tolerantly), checks the dates against each other and against today, and flags an expired document (the rider is told at once and may use another document), a holder under 18 and a printed field that disagrees. Our own MRZ model reads test sessions. | Try an expired ID, and a test card whose printed data does not match its MRZ (`M4_SPEC.md`) |
| **M5** | **Active liveness capture.** After the document photos, a face check with the front camera: the server's random challenge (3 of 5 actions and a one-time code), 13 small frames to private storage, a `liveness_capture` check (complete, plausible timings; not evaluated). The dashboard shows the challenge and the frames through the audited viewer. | A new challenge appears each time (`M5_SPEC.md`) |
| **M6** | **Server-side liveness evaluation.** A second Vercel worker (`worker-face/`, key `f1`) re-checks the challenge's actions from MediaPipe's face landmarks, in order; a flat-plane check (a print or a screen moves as one flat surface); the same face throughout; provisional screen and print cues. A `liveness` check: pass, flag or fail, review only. Training pipeline stub for our own detectors. | A printed photo or a phone screen held to the camera is flagged (`M6_SPEC.md`) |
| **M7** | **Face match**, test sessions only: the best face-check frame against the ID portrait with AuraFace; a `face_match` check with the similarity and an **uncalibrated** threshold, always review-only (no case is approved on it). The dashboard shows both faces side by side through the audited viewer. | Your selfie vs your ID matches; a colleague's does not (`M7_SPEC.md`) |
| M8 | Risk score, editable thresholds, approve/reject/review | Change a threshold and see the decision change, with no redeploy |
| M9 | Ops dashboard v1: login with 2FA, roles, queue, side-by-side view, decide with a reason, audit log | Log in as reviewer vs admin and confirm each sees different things |
| M10 | Integration API, webhooks, consent screen (placeholder text), result screen, retries and appeal | A small "fake ride app" page starts a session and receives the webhook |
| M11 | Tampering and replay signals | A photocopy, a screen photo and an edited image are all flagged |
| M12 | Metrics page and Phase 2 calibration report (automatic vs human agreement, per check) | Charts on your phone |
| M13 | Automatic deletion (scheduled database job), data-subject requests, hardening, load test, security fixes | Deletion appears in the audit log after a short test retention period |
| M14 | **Phase 1 pilot**: every case human-confirmed. Requires the lawyer's approval of hosting and consent wording. | Live metrics |

### Decisions for M2 (2026-10-13)
1. **The CNI becomes two choices.** "New CNI (2025)" has code lines (MRZ) and is read. "Old CNI" (2017 model) has none, so nothing is read for it. The rider picks one; the document list says which card has "3 lines of <<< on the back".
2. **Unreadable code lines: retry, then continue.** The rider gets tips and retakes the photo. After 3 failed tries, a "Continue anyway" button appears and the case is flagged for staff. A phone that cannot run the reader never blocks the rider.
3. **The rider sees only "Code lines read ✓".** The fields and the ✅/❌ for each check digit appear only in the debug view (`?debug=1`, offered as a "Debug link" QR code for test sessions) and on the dashboard.
4. **Reading model: Doubango now, our own in M3.** DoubangoTelecom's `mrz.traineddata` (BSD-3-Clause). Its caveat is recorded in `LICENSES.md`: its authors trained it on images collected from the web. We replace it with our own model in M3.

Details: `docs/M2_SPEC.md`.

### Decisions for M3 (2026-10-14)
1. **The AI worker runs on Vercel, not on a container host.**
   - A Vercel Python function in Paris (`cdg1`) replaces the container host (Scaleway) considered earlier. The same code runs on Vercel Pro or any container host.
   - **Free Hobby plan, for testing only.** You were told that Hobby's terms allow only non-commercial personal use, that Hobby has no data processing agreement (DPA), and that it includes 4 CPU-hours a month.
   - **Enforced in code:** a database switch keeps the worker on test sessions only, until Vercel Pro and its DPA are in place (and the lawyer agrees). A daily job cap (150 by default) protects the CPU budget.
2. **One milestone.** M3 is not split.
3. **Documents accepted** (answers Q5 and Q6):
   - passports of any country;
   - Cameroonian residence permits (carte de séjour, carte de résident; new and old models);
   - refugee cards (new grey and old red), for manual review;
   - voter card and driving licence: accepted, always manual review;
   - old CNI: manual review.

   The rider's option becomes "Titre de séjour ou carte de réfugié / Residence permit or refugee card", and the server works out which card it is. An ID card issued by another state is flagged as not accepted. As built, every residence permit goes to a person, so the reason never reveals a refugee card.
4. **The rider waits for the server's check:** "Checking your photos…", for at most about 20 seconds. A photo the server finds unusable (no document, or no readable text) is retaken at once, at most once per side. If the server is slow or down, the rider continues and staff review the case.
5. **Our own MRZ model:** train from zero first (cleanest provenance). If that fails the gates, fine-tune Google's `eng` model (Apache-2.0; its list of about 4,500 mostly commercial training fonts goes to the lawyer). Doubango stays until one model passes; **M3 is complete even if none passes.**
6. **OpenCV's bundled parts** (LGPL FFmpeg and libquadmath, Intel IPP, the GCC runtime with its exception, an unused out-of-support OpenSSL, and others) are accepted as documented exceptions (`LICENSES.md`). A slim OpenCV build that removes them comes before the pilot.

Details: `docs/M3_SPEC.md`.

### Decisions for M4 (2026-10-15)
1. **Expired document: the rider is told at once.** The server reads the expiry date from the code lines, or else from the printed expiry date (provisional). When the code lines say it (every check digit right), "Checking your photos…" tells the rider to use another, valid document, with "Use another document" (back to the document list) and "Continue anyway". Continuing leaves the hard flag `document_expired` for staff. An expiry read from print only is a provisional note for staff: the rider is told nothing. "Today" is the date in Douala.
2. **Under 18** (birth date from the code lines, else printed): the hard flag `under_18`, staff review, never approved automatically. The rider sees nothing special.
3. **Printed fields vs code lines, compared tolerantly:** accents, case, spaces, hyphens and apostrophes ignored; the code lines' truncated names allowed; OCR look-alikes (0/O, 1/I, 5/S, 8/B, 2/Z) in numbers; dates compared as dates whatever their format. A real disagreement is the flag `mrz_print_mismatch`, with the kinds of field (`name`, `number`, `birth_date`, `expiry_date`). Never a rider message.
4. **Date logic and number formats:** birth before issue before expiry, issue not in the future, at most 15 years of validity (named constants) → `date_logic`; the number's format per document type, guessed until real cards are seen → `number_format`, recorded as provisional only. Everything that depends on printed formats stays provisional, as in M3, except decisions 2 and 3.
5. **Our own MRZ model ships for test sessions only** (`/ocr/mrz-2/`): run 2 (fine-tuned from Google's `eng`, Apache-2.0) passed every automated gate; run 1 (from zero) did not. Doubango stays for every other session until G4 (the PM's own photos). `eng`'s training fonts (mostly commercial) are on the lawyer's list. The debug panel and the server's records name the model that read.

Details: `docs/M4_SPEC.md`.

**Supabase setup.** I can create the Supabase project and apply database changes directly through the connected Supabase tools. **I will ask before creating anything that costs money.** Netlify sites deploy automatically from GitHub.

---

## 5. Testing plan
- **Automated tests:** MRZ samples from the ICAO 9303 spec, check-digit edge cases, date logic, and **database security-rule tests** (a reviewer cannot read another reviewer's cases; nobody can edit the audit log; a rider token cannot read another session). Also: an audit entry is written on every image view.
- **"Golden" test set:** labelled real captures, re-scored before each model or threshold change.
- **Accuracy metrics per check:** false accepts and false rejects. Liveness uses the ISO 30107-3 terms APCER/BPCER. Results are **broken down by skin tone, age, gender, phone model and lighting.**
- **Fraud attack matrix:**
  - *Document attacks:* colour and black-and-white photocopy, ID shown on a phone or laptop screen, photo of a photo, pasted portrait, digitally edited fields, MRZ/print mismatch, expired ID, someone else's ID.
  - *Face attacks:* printed selfie, photo on a screen, video replay of someone else doing the challenge, paper mask, someone else's ID.
- **Collecting consented test images:**
  1. The lawyer drafts a volunteer consent form.
  2. Volunteers (aim for 50–100) use **their own documents only**.
  3. Attacks are made on those documents, or on **home-made "SPECIMEN" cards** we design and print ourselves. Never alter or forge real documents of other people.
  4. Test data lives in a separate Supabase test project and is deleted on schedule.
  5. Cover several phones (Tecno, Itel, Samsung A-series), lighting conditions and skin tones.

---

## 6. Must be reviewed by a human security engineer before launch
1. Threat model and architecture (written in M0, updated each milestone).
2. **Supabase Row Level Security policies:** the most important review. A single wrong rule can expose ID images.
3. **Handling of the Supabase "service role" key.** It bypasses all rules, so it must never appear in web pages; only in Edge Functions and the worker. Also: API keys, webhook signatures, rate limiting, upload validation.
4. Encryption: whether to add per-image encryption with our own keys, key rotation, and backups.
5. Staff access: 2FA enforcement, onboarding and offboarding, admin break-glass access.
6. Audit log integrity (no image is shown if the access can't be logged).
7. Liveness and replay resistance (one-time codes, virtual cameras or fake camera feeds).
8. The AI worker's host (Vercel since M3): the signed worker API and key rotation, the firewall rules, the test-only switch, the move to Pro with a DPA, the CPU budget, and the third-party parts inside its Python packages (see `THREAT_MODEL.md` and `LICENSES.md`).
9. CI/CD and secrets (GitHub, Netlify and Supabase settings).
10. Dependency, licence and model-provenance audit.
11. External penetration test.
12. With the lawyer: data-processing agreements with Supabase, Netlify and Vercel (Vercel Inc. is a US company; the worker runs in its Paris region), the EU region vs Cameroon data law, consent wording, retention and deletion (including backups), and registration with the data-protection authority.
13. Incident response plan if ID images leak.

### Decisions for the remaining milestones (2026-10-16)
1. **Order and sessions.** M4 is finished in the current session. The remaining milestones (M5–M14) continue in a new session, which starts from `docs/HANDOFF.md`.
2. **Face model (M7): research first, then you decide.** Most good public face models, and the datasets they were trained on, are non-commercial (InsightFace, the published ArcFace weights, VGGFace2). We will find the best option that is licensed for commercial use, or a plan to train our own. We document its licence and its accuracy limits, and show you before anything is built on it. The rest of M5–M7 is built around it in the meantime.
3. **Hosting: Vercel Hobby, test sessions only, for now.** Liveness and face checks run only on test sessions, under the daily cap. Moving to Vercel Pro (with its DPA) or to another host is decided before the pilot.
4. **Product decisions during the build: the safest default, recorded.** We pick the conservative option (more staff review, less automatic), record it in this file and list it at each milestone's ping for you to review. Anything legal, financial or licence-related still waits for you.

### Decisions for M5 (2026-10-19)
Your decision first; the others are the safest defaults (decision 4 above), for you to review.
1. **Your decision: an optional box to keep face images.** The consent screen gets a separate box, unticked by default: "keep my face images to improve and tune Confiance's checks (deleted on request)". The answer is stored with the version of its wording (`consent_record.keep_face_images`). Nothing depends on it yet. Placeholder wording, for the lawyer.
2. **Your decision: on-device face detection, if any, uses MediaPipe** (green in `docs/research/FACE_MODELS.md`), never YuNet. **M5 uses none:** MediaPipe's engine is a 13.5 MB download (3.9 MB compressed) on every rider's first visit, which is not cheap on low-end Android over slow networks. The phone only checks brightness and contrast in the oval; the server runs MediaPipe on the frames in M6.
3. **The face check is required** before the submit (the server refuses a submit without it). It comes after the document photos and their server check, and is kept if the rider then chooses another document.
4. **Challenge:** 3 different actions drawn at random from 5 (turn the head left, turn it right, look up, blink, smile), in a random order, plus a 6-digit code shown on screen during the capture. A challenge is valid for 10 minutes and used once; at most 5 per session (then the rider starts again from the Confiance app).
5. **Frames, not video:** 13 still frames of the whole camera picture, 480 px on the long side, about 40 KB each, under 600 KB in all. The server accepts 8 to 15 frames, refuses any file that is not what the phone said (size, JPEG, dimensions, SHA-256), and erases refused frames.
6. **The hints never block:** "Start" works after 6 seconds whatever the brightness check says; the server records that the rider started despite a warning, for staff.
7. **Recorded for every session, evaluated by nobody yet:** the server writes a `liveness_capture` check (frames complete, timings plausible) as the frames arrive. It runs inside Supabase with no model and no third party, so it is not limited to test sessions; M6's evaluation on the AI worker will be, as decision 3 above says. Staff see "Not evaluated yet".
8. **Retries:** a network failure resends the same frames ("Try again"); anything else needs a new challenge ("Start the face check again").
9. **Staff access to the frames** is the same as for the document photos: audited 60-second links, supervisors and the assigned reviewer, never admins.

Details: `docs/M5_SPEC.md`.

### Decisions for M6 (2026-10-19)
Your decisions first; then the safest defaults taken while building, for you to review.
1. **Your decision: liveness from MediaPipe Face Landmarker's landmarks, on the server.** The M5 challenge is re-checked from the frames: head turn direction (yaw), look up (pitch), blink (eye aspect ratio, and MediaPipe's blink score) and smile, each in the step the server asked for it, in order. Plus a **flat-plane check** (a print or a screen moves as one rigid plane; a real head shows parallax) and **frame-to-frame consistency** (the same face throughout, no cuts or jumps).
2. **Your decision: Silent-Face-Anti-Spoofing only as a low-weight signal, test sessions only.** **Not shipped:** PyTorch only (a 2020 model to export), undisclosed training data, for one more provisional cue. To reconsider with the first attack captures.
3. **Your decision: our own screen and print detectors** need attack photos we do not have yet: the training pipeline stub and the data-collection notes are in `training/antispoof/`; **heuristic signals ship now, marked provisional** (moiré, screen glare, low detail).
4. **Your decision: the result is a `check_result` named exactly `liveness`**, outcome pass, flag or fail, with generic codes and scores only in its details (no landmark, no per-frame value).
5. **Your decision: face images are kept for training only when the rider ticked `keep_face_images`.** `private.face_training_cases()` lists those cases (the latest consent only); nothing else may be exported.
6. **Your decision: a second Vercel Python project** (`worker-face/`, project `confiance-verify-face`, Paris `cdg1`), because the AI worker has no room left under Vercel's 500 MB. The same signed protocol with job kinds `liveness` and `face_match`, and every M3 property: Ed25519 signatures, nonces, bytes relayed, no Supabase credential on Vercel, a ring that carries no authority, a test-sessions-only switch and a daily cap (100). Its key id is `f1`. Models are fetched at build time from pinned URLs with their SHA-256 (no model in git).
7. **MediaPipe's models run on LiteRT, not with the `mediapipe` package** (its native library is 112 MB: with AuraFace the function would be about 533 MB, over the limit). Our port of MediaPipe's pipeline matches the official package within 0.5 px on average. Bundle: about 479 MB.
8. **A separate `face_job` table and scoped keys:** a key signs for one function only (`worker_key.scope`), the face function has its own signature audience, its own claim, cap, sweep and switch (`face_enabled_for_real_sessions`, off).
9. **Liveness never rejects a case:** `fail` (an action not done, or done the wrong way) and `flag` (everything else that needs a person, including every provisional cue) both mean review in M8 (`liveness_flag`, provisional).
10. **The rider app is unchanged:** the rider never waits for the face worker; staff see the result on the dashboard.

Details: `docs/M6_SPEC.md`.

### Decisions for M7 (2026-10-19)
1. **Your decision: AuraFace v1, its `glintr100.onnx` only, test sessions only.** Its SHA-256 (`a7933ea5…`) is checked to differ from InsightFace antelopev2's (`4ab1d643…`); the repository's other four files (InsightFace's own, non-commercial) are never shipped: the fetch script and the loader refuse their hashes.
2. **Your decision: detection and alignment with MediaPipe** (not YuNet, not SCRFD); the portrait is searched on the document front (or the passport's data page), the best selfie frame (one face, frontal, eyes open, largest) is chosen by the worker.
3. **Your decision: the result is a `check_result` named exactly `face_match`**, with the similarity.
4. **Your decision: the threshold is uncalibrated**: `FACE_MATCH_THRESHOLD` (0.35) is marked "uncalibrated — must be set on Cameroonian impostor pairs (NIST shows ~14x higher false-match rate for West Africans at fixed thresholds)".
5. **Review-only is a hard rule in the database, not a threshold setting** (the safest of the two options): `private.face_match_review_only()` returns true, so a case with a face match is never recommended for approval (`review_only_check`) and never approved automatically. No admin can turn it off; only a migration, after calibration and your decision. The face match never rejects either. **Consequence: no case is recommended for approval while this holds** (Phase 1: a person decides every case). *Superseded on 2026-10-20: a threshold setting now (see "Decisions for automatic approval").*
6. **The face match never runs on a real session**, whatever the face switch (licence).
7. **No crop or embedding is stored:** the details hold each face's box; the dashboard shows the portrait and the frame side by side by framing the whole photos, each opened through the audited viewer.
8. **Your decision: before the pilot, switch to a paid licence (InsightFace), an on-premise vendor SDK, or our own model.** The lawyer's items (AuraFace's undisclosed dataset, InsightFace files relabelled in its repository, biometric data) are in `LICENSES.md`.

Details: `docs/M7_SPEC.md`.

### Decisions for M8 (2026-10-19, safest defaults, for your review)
1. **Every case still goes to a person.** Automatic decisions exist but are off. Even switched on (a threshold setting), they apply to test sessions only and never approve a case with a check missing; liveness and face match do not exist before M6 and M7, so nothing is approved automatically, or even recommended for approval, before then. **Since M7, the face match is review-only (hard rule), so still no case is recommended for approval.** *Superseded on 2026-10-20 for test sessions: see "Decisions for automatic approval".*
2. **Hard flags mean review, whatever the score.** Always: expired document, under 18, and the documents always checked by a person (M3/M4 decisions); by default also a photo already used in another verification and a foreign ID card. An admin can add hard flags, never remove those three.
3. **Only firm signals can recommend a reject** (code lines with every check digit right, or the same photo bytes twice). Printed text, keywords, untuned quality thresholds and, later, liveness and face scores can only send a case to a person. Under 18 counts as provisional (it may come from print).
4. **The documents you decided are always reviewed** (old CNI, residence permits and refugee cards, driving licence, voter card) stay so in every threshold version.
5. **Decisions:** supervisors and the assigned reviewer, never admins (no routine access to photos or data). A reject needs a rider reason; a note is required to go against the recommendation or to approve a case with a hard flag. Each decision records the threshold version, the recommendation and score shown, and whether it agreed (for M12).
6. **Thresholds:** admins only, from the dashboard, without a redeploy. Versions are never edited; each records who and why. A new version re-assesses every case waiting for a decision at once.
7. **First weights and cut-offs are guesses** (approve at 0.15 or less, reject from 0.9 of firm signals), to calibrate in M12. Q1 (speed target) and Q4 (duplicate detection) stay open: nothing is matched across riders beyond the M1 "same photo" signal.

Details: `docs/M8_SPEC.md`.

### Decisions for automatic approval (2026-10-20)
**Your decision:** "When a user uploads their face and ID, the system tells them if their ID is verified and they move forward."

**What you were told before deciding:**
- **The face match threshold is not calibrated on Cameroonian faces.** NIST measures about 14 times more false matches for West Africans at default thresholds. An impostor with a similar face may therefore be approved, with no person before the decision.
- **The free AuraFace model is for test sessions only** (licence and provenance; `LICENSES.md`).
- **Vercel Hobby is for test sessions only** (non-commercial terms, no DPA).

**How it is built:** the safest version of the decision, for you to review. Details: `docs/AUTO_APPROVAL.md`.
1. **Automatic approval only, never an automatic reject.** Anything not approved goes to staff. The rider then sees "Nous vérifions quelques détails, nous vous tiendrons informé / We're checking a few details, we'll let you know".
2. **Every condition must hold.** The system approves a case only when:
   - the document check is firm: code lines with every check digit right; a document without code lines never qualifies;
   - the document is not expired and the holder is not under 18;
   - the printed text does not differ from the code lines;
   - there is no hard flag and no firm signal;
   - the server's photo check is ok;
   - liveness passed and the face match passed;
   - the score is at or under the approve cut-off of the active threshold version.
3. **The M7 hard rule "the face match is always review-only" becomes a threshold setting** (`faceMatchCountsForApproval`). A new threshold version made by the migration sets it, with automatic approval on, and the reason "PM decision 2026-10-20: automatic approval". Admins can switch either off from the Thresholds page, with no redeploy.
4. **Test sessions only.** The face worker runs on test sessions only, so a real session has no face match and goes to staff.
5. **The system's approval is recorded like a staff decision** (actor system, threshold version, recommendation and score) and audited. Staff can still confirm or overturn it afterwards (once; a note is required to go against it). The dashboard shows "Approved automatically" with the version, and the queue can show only those cases.
6. **The rider's result screen** asks the server for at most 75 s, every 2.5 s: verified (with "Continue", to the session's return address or an end screen), review, or waiting. A time-out shows the review message. Nothing personal is returned.
7. **Before any real rider:** calibrate the face match on Cameroonian impostor pairs, move to a licensed model (`M7_SPEC.md`), move to Vercel Pro with its DPA, and decide again whether automatic approval stays. The ride app must treat a later staff reject (M10 webhook) as final.

### Scope for now (2026-10-20)
The platform is for **testing first**. M0–M8 and automatic approval (test sessions only) are what we test now. M9–M14 (ops dashboard v1, integration API, fraud signals, calibration, deletion and hardening, pilot) and other complete features come later, when the PM asks for them.

### Decisions after the first real test (2026-10-20)
The PM's first real test (a test session with the PM's own new CNI and face, on a low-end phone) was not approved: liveness failed, a printed-name difference counted as a firm signal, the dashboard read "reject", and the result took 27 s. Fixed on this basis (details: `M6_SPEC.md`, `M4_SPEC.md`, `M8_SPEC.md`, `AUTO_APPROVAL.md`):
1. **"ID and face steps all at once" (PM).** Consent → document → ID front/back → straight to the face check, with no "Checking your photos…" wait between. The photos upload and are checked during the face check. One result step at the end ("Checking your ID…", then verified ✓ or "we're checking a few details"). The expired-document message and the one server retake per side are kept, shown only at that end step when they apply; then the rider retakes that side (or uses another document) and the result is evaluated again. The phone's instant hints (blur, glare) stay during capture.
2. **The result in less than 10 s after the face check (PM).** Measured from the end of the face check to the result. Built: the face worker is rung when the face check starts so its models load meanwhile; it fetches a job's photos in parallel and a face check's two jobs share their frames and face meshes; the case is assessed as the last check lands (never waiting for the minute's sweep); the app asks every second during the first 15 s. Timings are kept with each face check (`timing.fetchMs`, `wallMs`, `sinceJobMs`) and logged.
3. **Liveness, measured on the real test.** The yaw sign convention held (a turn to the rider's left read +35°); the rider was about one step late, and look up and smile were in no frame. Each action's prompt now lasts 3.5 s (3 s before), the last one has a tail frame (14 frames), an action may still be seen in the first two frames after its step, each measure is taken against the rider's own neutral (median of the frames where it should not move), and the cut-offs are those of a real person (turn 12°, look up 8°, smile score 0.35 with a 0.15 rise or the mouth 8% wider). The per-frame angles and scores are kept with the check (never a landmark or a picture) to tune on the next tests. Liveness still never rejects on its own.
4. **A printed name that differs from the code lines is a provisional note, not a firm signal.** Printed text is read by OCR, not yet tuned on real cards. When the code lines are trustworthy (every check digit right, the phone and the server read them the same), the name difference is the note `print_name_mismatch` (weight 0) and does not block an automatic approval; a differing document number or date stays firm. The name comparison also forgives word order, a missing middle name, OCR splits and merges, labels read into the value and one misread letter in a long word. Recorded as threshold version 4 ("Fixes after the PM's first real test"), which re-assessed the waiting cases.
5. **The dashboard never says "reject" unless the rules recommend a reject or a person rejected the case.** The recommendation is shown first; the score band is a labelled detail ("the score alone, not a decision").

---

## Verification
- Each milestone: CI green (unit tests, database security-rule tests, licence check, secret scan) + deployed to a Netlify preview + your phone test passes.
- M0–M3 use only your own documents (and, from the M3 tuning step, consenting volunteers' own documents), public ICAO samples and our own fictitious specimens.

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

## 1. Remaining questions (none block M0–M2)

| # | Question | Needed before |
|---|---|---|
| Q1 | Speed target (e.g. 99% decided in under 10 s) | M8 |
| Q2 | Maximum retries after a rejection (I suggest 3 per 24 h, then manual review only) | M10 |
| Q3 | Image retention period (lawyer). Also, can we keep a text record (name, ID number, decision) longer than the images? | M13 |
| Q4 | **Duplicate detection.** Should we flag the same ID number or the same face on two rider accounts? This catches a lot of fraud, but means storing a one-way fingerprint of the ID number and a face template. It is a privacy trade-off for the lawyer. | M8 |
| Q5 | **Foreign riders.** Do we accept only Cameroonian residence permits, or also foreign passports? Passports are cheap to add because they follow one international standard. | M3 |
| Q6 | **Voter card and driving licence.** Both have weak security features and no machine-readable zone. I suggest accepting them, but always sending them to manual review at first. | M3 |
| Q7 | Specimen images of each document version (old and new CNI, fronts and backs) | M3 |
| Q8 | **Where the "AI worker" runs** (see section 2). I recommend a small container host at about €5–20 per month. | M3 |
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
- **One thing Supabase cannot do: run our AI models.** Edge Functions are limited to a couple of seconds of CPU and 256 MB of memory. OCR, face matching and anti-spoofing therefore run in **one small Python worker**. The worker takes jobs from the Supabase queue and writes results back. It is a single Docker container that can run on any host (see Q8).
- **Staying portable and standalone.** Supabase is open source (Apache-2.0) and can be self-hosted. If the lawyer later requires hosting in Cameroon, we move the same database, functions and worker to our own server without rewriting. Netlify pages are plain files that can be hosted anywhere. I will not use Netlify-specific features (Netlify Functions, Forms, Identity), so we are not locked in.
- **The rider never logs in to Verify.** The Confiance backend asks for a single-use session link that expires after 30 minutes. The app opens it in a Chrome Custom Tab or WebView. The app then learns the result from a signed webhook. Drivers can be added later by using a different `subject_type`.

### Trade-offs to know about
1. **Data location.** In the test phase, real ID images will sit in Supabase's EU region. That is fine for consenting volunteers, but the lawyer must approve it before launch (Q9).
2. **Encryption.** Supabase encrypts all stored data on disk. I will *also* encrypt the most sensitive database columns (ID number, name, date of birth) inside the database. Per-image encryption with our own keys is extra work; I propose deciding on it with the security engineer before launch.
3. **Web flow vs native app.** A browser camera gives slightly less control than a native app. My mitigation: auto-capture, plus a server-side quality re-check that asks the rider to retake bad photos.

### Stack and licences (all allow commercial use)
| Area | Choice | Licence |
|---|---|---|
| Backend platform | Supabase (Postgres 15+, Auth, Storage, Edge Functions on Deno, Queues/pgmq, Vault) | Apache-2.0 / PostgreSQL / MIT (open source, self-hostable) |
| Hosting of web pages | Netlify (a hosting service, not a library) | Commercial service; terms checked for production |
| Web pages | React, TypeScript, Vite, i18next, supabase-js | MIT, Apache-2.0, MIT, MIT, MIT |
| MRZ parsing and check digits | **Written by us** in TypeScript, following ICAO 9303. The same code runs on the phone (instant feedback) and on the server (the authoritative check). | Ours. The popular `mrz` library is GPL, so we avoid it |
| MRZ reading on the phone (M2 only, before the worker exists) | tesseract.js with an OCR-B font model | Apache-2.0 (I will check the OCR-B model's licence before use) |
| AI worker | Python 3.12, OpenCV, NumPy, Pillow, ONNX Runtime | PSF, Apache-2.0, BSD-3, HPND, MIT |
| OCR, printed text FR/EN | RapidOCR with PP-OCR models | Apache-2.0 (code and models) |
| Face detection | OpenCV YuNet | MIT |
| Live face guidance on the phone (blink, head turn) | MediaPipe Face Landmarker | Apache-2.0 |
| Passive anti-spoofing | MiniVision Silent-Face-Anti-Spoofing | Apache-2.0 |
| **Face matching** | Candidates: **OpenCV SFace** (Apache-2.0) and **dlib ResNet** (released into the public domain by its author). We benchmark both on consented local data. | See warning below |
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
- `consent_record`: consent text version, language, time, device.
- `capture`: front/back/liveness, storage path, quality metrics, sha256.
- `liveness_challenge`: actions, one-time code, expiry.
- `check_result`: check name and version, score, pass/flag/fail, details.
- `extracted_document_data`: sensitive fields encrypted; records whether each field came from MRZ or OCR.
- `review_task`: priority, assignee, status, timing.
- `decision`: system or reviewer, outcome, reason code, note.
- `reason_code`: FR/EN text shown to riders.
- `appeal`.
- `threshold_config`: versioned; who changed it and when.
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

### API 2: Rider web flow → Verify (single-use session token)
`GET /flow` · `POST /flow/consent` · `POST /flow/upload-url` (returns a one-time upload link to private storage) · `POST /flow/captures/{id}/check` (server quality verdict) · `POST /flow/liveness/challenge` · `POST /flow/submit` · `GET /flow/status` (result, reason, retries left) · `POST /flow/appeal`

### API 3: Ops dashboard → Verify (Supabase Auth with 2FA required; enforced by role)
- Queue and case details: read directly via database rules. Each role sees only what it is allowed.
- `POST /admin/captures/{id}/view` (audited, 60-second link)
- `POST /admin/verifications/{id}/decision`
- Search: supervisors and above.
- Thresholds: admins only.
- Metrics, audit log, appeals.

**Roles:**
- Reviewer: only cases assigned to them.
- Supervisor: adds search, appeals and reviewer statistics.
- Admin: adds thresholds, users and audit log, but **no** routine image access.

---

## 4. Build plan: small milestones you can test on your phone
Each milestone ends with a Netlify link and short test steps. The flow has a "debug panel" showing what the system read.

| M | What you get | How you test it |
|---|---|---|
| **M0** | Repo and CI (tests, licence check, secret scan). Supabase **test project** created (Q9 region) with tables, security rules and private storage. Two Netlify sites (rider flow, dashboard) with automatic preview links. FR/EN hello page. | Open the link on your phone and switch the language |
| **M1** | **ID capture.** Live camera with a card frame, blur/glare/framing hints, auto-capture, crop and compression (target under 300 KB). Upload straight to private Supabase storage. Front and back. | Capture your ID in good and bad light; bad photos are refused with a clear hint. The image appears in the (temporary) admin debug page. |
| **M2** | **MRZ reading.** Read the MRZ on the phone, parse passport (TD3) and biometric CNI (TD1), validate check digits on the phone and again on the server | Scan your passport: fields shown with ✅/❌ for each check digit |
| M3 | **AI worker goes live (Q8).** Server re-reads the MRZ from the image itself, plus classification and printed-text OCR for each document type | Scan each document type: correct type and fields |
| M4 | Consistency checks and first risk flags | Try an expired ID, and a test card whose printed data does not match its MRZ |
| M5 | Active liveness capture: random challenge, frames uploaded | A new challenge appears each time |
| M6 | Server-side liveness evaluation + passive anti-spoofing | A printed photo or a phone screen held to the camera is flagged |
| M7 | Face match between selfie and ID portrait | Your selfie vs your ID matches; a colleague's does not |
| M8 | Risk score, editable thresholds, approve/reject/review | Change a threshold and see the decision change, with no redeploy |
| M9 | Ops dashboard v1: login with 2FA, roles, queue, side-by-side view, decide with a reason, audit log | Log in as reviewer vs admin and confirm each sees different things |
| M10 | Integration API, webhooks, consent screen (placeholder text), result screen, retries and appeal | A small "fake ride app" page starts a session and receives the webhook |
| M11 | Tampering and replay signals | A photocopy, a screen photo and an edited image are all flagged |
| M12 | Metrics page and Phase 2 calibration report (automatic vs human agreement, per check) | Charts on your phone |
| M13 | Automatic deletion (scheduled database job), data-subject requests, hardening, load test, security fixes | Deletion appears in the audit log after a short test retention period |
| M14 | **Phase 1 pilot**: every case human-confirmed. Requires the lawyer's approval of hosting and consent wording. | Live metrics |

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
8. The AI worker's host: hardening, network access, image scanning.
9. CI/CD and secrets (GitHub, Netlify and Supabase settings).
10. Dependency, licence and model-provenance audit.
11. External penetration test.
12. With the lawyer: data-processing agreements with Supabase and Netlify, the EU region vs Cameroon data law, consent wording, retention and deletion (including backups), and registration with the data-protection authority.
13. Incident response plan if ID images leak.

---

## Verification
- Each milestone: CI green (unit tests, database security-rule tests, licence check, secret scan) + deployed to a Netlify preview + your phone test passes.
- M0–M2 use only your own documents and public ICAO samples.

# Threat model (living document; started at M0)

This is a starting point for the **human security engineer**, who must review it before launch (see `PLAN.md` section 6). It is updated at every milestone.

## What we protect
1. **ID document images, selfies and liveness frames.** Most sensitive. A leak enables identity theft. Since M3, document photos of test sessions also pass, in memory only, through the AI worker on Vercel.
2. **Extracted identity data:** name, date of birth, ID number, nationality. Since M2 this includes the MRZ ("code lines") read on the rider's phone, and since M3 the code lines and printed fields read by the server and the card sub-type (refugee, séjour, résident), all stored encrypted.
3. **Decisions and the audit log.** Integrity matters: a forged "approved" lets a fraudster ride.
4. **Thresholds.** Changing them silently could auto-approve fraud.
5. **Secrets:** Supabase service-role key, API keys, webhook signing secrets, and since M3 the AI worker's Ed25519 private key (on Vercel).

## Who might attack, and how

| Attacker | Goal | Main defences (planned or in place) |
|---|---|---|
| Fraudulent rider | Pass with a fake, stolen or edited ID, or someone else's face | Server-side checks only (the phone is never trusted); MRZ check digits, recomputed by the server; the server re-reads the MRZ from the image and compares it with the phone's (M3; test sessions only until the switch is turned on); consistency checks; tamper and replay signals; active + passive liveness; face match; human review in Phase 1 |
| Anyone on the internet | Abuse the AI worker: forge or replay its requests, read photos through it, burn its CPU budget | The ring carries no authority; every worker request is Ed25519-signed, time-limited and single-use; the worker holds no Supabase credential and receives no image URL; a daily job cap; Vercel firewall rules (M3) |
| Compromised worker host or key (Vercel) | Fetch photos, post false results | The key only allows claiming the next job and fetching that job's photo while leased, each fetch audited; results are validated strictly and decided by the server; the worker never sees other data; the key can be revoked in the database (M3) |
| Rider replaying another session | Re-use frames or uploads | Single-use session tokens (stored hashed); one-time liveness codes; image sha256 reuse detection |
| Outside attacker | Steal images in bulk | Private bucket with **no** storage policies; RLS on every table; anon role has no table access; service-role key only on the server; HTTPS everywhere; strict headers/CSP |
| Curious or malicious staff | Browse or export IDs | Reviewers see only cases assigned to them; every image view, and every view of data read from a document, goes through an audited function and is shown for 60 seconds; admins have no routine access to either; 2FA required |
| Insider with database access | Hide what they did | Audit log is append-only (update, delete and truncate are blocked by triggers) and hash-chained; `audit_chain_first_break()` detects edits |
| Compromised Confiance backend / API key | Create sessions, read results | API keys stored hashed; results never include images; per-client key rotation; rate limits (M10) |
| Supply chain | Malicious dependency or model | Lockfile + `npm ci`; licence check; versions at least two weeks old when added; secret scanning; since M3, `uv.lock` with hashes and `exclude-newer` for the worker, and every OCR model's SHA-256 checked at load |

## In place at M0
- RLS enabled on all tables, with security-rule tests in CI (`supabase/tests/10_rls_test.sql`).
- Private `id-captures` bucket (JPEG/WebP only, 5 MB max), with no access policies.
- Append-only, hash-chained `audit_event`.
- Web apps: strict `Content-Security-Policy`, `noindex`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera allowed only on the rider site).
- Only the public "publishable" Supabase key ever appears in web apps.
- gitleaks secret scan on every push.

## In place at M1
- **Rider session tokens:** 32 random bytes; only their SHA-256 is stored (`verification.session_token_hash`). The token travels in the link's fragment (`#s=…`), which browsers never send to a server or put in a Referer. The rider app removes it from the address bar at once, keeps it for the tab only (`sessionStorage`), and sends it only in the `x-session-token` header. Sessions expire after 30 minutes (`410 session_expired`), and a submitted session accepts no further changes.
- **Test-session endpoint** (`POST /admin/test-sessions`): staff only (signed-in supervisor or admin with an active staff profile), audited (`test_session.create`). Test sessions are flagged `is_test` and hang off an `internal-test` API client whose key hash can never match a real key.
- **Staff enrollment by invite code:** an administrator stores only the SHA-256 of a one-time code (`staff_invite`). `POST /admin/enroll` gives the same answer for every failure (unknown address, wrong code, expired, used, locked). After 5 wrong codes the invite is locked; once used it cannot be used again. Every wrong code and the lock itself are written to the audit log (`staff_invite.failed_attempt`, `staff_invite.locked`, without the address or the code), so guessing, or someone locking an invitee out, is visible. Our functions never log the code, the password or the email; enrollment is audited (`staff.enroll`) without the code. There is no trigger on `auth.users`, and the enrollment database functions can be called only by the service role.
- **Audited 60-second image links:** `POST /admin/captures/view` writes `capture.view` to the audit log *before* it creates the signed link; if the audit write fails, no link is given. Only supervisors and the reviewer assigned to the case get links; admins get none. The dashboard keeps the link in memory only and withholds the Referer. It fetches the image past the browser's HTTP cache (`cache: no-store`) and shows it from an in-memory blob, which is freed when the link expires, the photo is hidden, the page is left or the staff member signs out, so no copy stays in the browser's disk cache (Storage serves objects with `max-age=3600`).
- **Upload limits per session:** at most 20 upload links per session (atomic counter in the database). Uploads go straight to the private bucket with signed upload tokens, each tied to one object path that cannot be overwritten. Each path is bound to its session and side. The server checks size (10 KB to 5 MB), JPEG signature and resolution (long side 720 px or more, and since M3 at most 1,600 px, the app's own maximum, which the AI worker also enforces), and deletes rejected files. It flags an image already uploaded in another verification (same SHA-256) for staff only; the rider is not told, so the check cannot be probed.
- **Edge Functions:** exact-origin CORS allowlist (`ALLOWED_ORIGINS`), request bodies capped at 16 KB, and error bodies limited to a code and a fixed message (internal errors are logged without request values).
- **Photos from the rider app** are re-encoded from a canvas, so they carry no EXIF or GPS data.

## In place at M2
M2 reads the MRZ ("code lines") on the rider's phone and checks it on the server. Details are in `M2_SPEC.md`.

- **What the phone reads is untrusted.**
  - The phone sends only the lines it read, never its own verdict. The `flow` function checks their shape strictly (3 × 30 or 2 × 44 characters of `A–Z`, `0–9`, `<`). It then parses them again with our own parser and recomputes every check digit before it records `pass` or `flag`.
  - **But the server cannot see the image until M3.** Check digits are public arithmetic: anyone can compute correct ones for invented data. So a forged MRZ with correct check digits passes M2's check, and so would lines sent by a modified app that never came from the photo. Until the M3 worker re-reads the image, `pass` only means "the lines are consistent with themselves". In Phase 1 a person reviews every case anyway.
  - The report must name a live photo of this session, of the side where the declared document carries its code lines; otherwise it is refused (404 or 422). There is one check per photo, and a repeated report changes nothing.
  - After 3 failed tries the rider may "Continue anyway"; the server then records `flag` for staff.
- **The MRZ lines are encrypted inside the database** (`extracted_document_data`).
  - **How:** pgcrypto's `pgp_sym_encrypt` with AES-256. It is salted, so the same lines never give the same bytes twice.
  - **The key:** 32 random bytes that the database generates itself when the migration runs, kept in Supabase Vault as `document_data_key_v1`. Vault stores secrets encrypted, under a root key that Supabase keeps outside the database. Nobody ever handles the value: it never appears in code, chat, CI, a function's settings or the text of a statement. Each row records the name of its key (`key_name`), so a second key can be added later without touching old rows.
  - **Why encrypt in the database rather than in the Edge Function:** the key never leaves the database, and the Supabase project does not log query parameters (`log_statement=ddl`, `log_min_duration_statement=-1`, `log_parameter_max_length_on_error=0`, checked 2026-10-13). So the plaintext lines handed to the database function stay out of the logs.
  - **Who can read it:**
    - The table has Row Level Security on, no policies, and every right revoked from the `anon` and `authenticated` roles. The dashboard cannot even see the ciphertext.
    - The plaintext comes back only through the database function `staff_read_document_data`, called by `POST /admin/document-data`. It writes the audit entry `document_data.view` first, in the same transaction: if the entry cannot be written, nothing is decrypted.
    - It re-checks the access rule itself: active staff; a supervisor, or the reviewer assigned to the case. **Admins never:** the admin function refuses them (403), and the database function refuses them again.
    - Every read is audited, including a read of a case with no data.
  - **What this protects against:** a copy of the table (an export, a leaked query result) is unreadable without the key; the dashboard's roles get nothing; logs hold no lines.
  - **What it does not protect against:** the key sits in the same database as the data. Anyone who can run SQL as the database owner can decrypt. Anyone holding the service-role key can call the read function in a supervisor's name, though that read is still audited under the name given. See the open items.
- **No personal data outside the encrypted table.**
  - `check_result.details` holds outcomes and counts only: true/false per check digit, format, tries, corrections, timing, engine and parser version. Supervisors and admins can read that table directly. The server copies these values field by field, so nothing read from the document can slip in.
  - The audit entries hold `{captureId, outcome, result}` (`mrz.record`) and `{role, items}` (`document_data.view`, where `items` is a count).
  - Our functions never log the lines, and their error messages never repeat a value sent.
  - On the phone the lines stay in memory. The fields and the raw OCR text appear only in debug mode, in a panel marked `translate="no"` so the browser's page translation never sends them to an online service. The full-resolution grayscale copy of the photo is dropped as soon as it has been read.
- **Showing the data on the dashboard** works like photos:
  - it is held in the page's memory only, and removed after 60 seconds, on Hide, when leaving the case and on sign-out;
  - the response is `no-store`;
  - the block is marked `translate="no"`, so the browser's page translation never sends it to an online service.
- **Rider CSP change:** `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`.
  - `'wasm-unsafe-eval'` allows the browser to compile WebAssembly, which the OCR engine needs. It does **not** allow running JavaScript from text (`eval`, `new Function`): that stays blocked, and scripts still come only from our own site.
  - The OCR worker is loaded from its URL, so `blob:` workers stay forbidden. The dashboard's CSP is unchanged.
  - Before starting the engine, the app test-compiles a tiny WebAssembly module. Where WebAssembly is forbidden (a stricter CSP, iOS Lockdown Mode) this fails at once, and the rider simply continues without reading.
- **OCR files come from our own site only**, under `/ocr/`, never from a CDN.
  - Versions are pinned exactly, and the build fails if the installed engine does not match its folder name.
  - A test pins the model's SHA-256.
- **Caching of `/ocr/`:**
  - The files are cached for a year as `immutable`. Their paths carry a version (`/ocr/7.0.0/`, `/ocr/mrz-1/`), so a new engine or model gets a new path.
  - A missing `/ocr/` file returns a 404, never the app page, so the app's HTML can never be cached for a year in place of a script.
  - Both hosts apply header rules by path, so the year-long header also covers `/ocr/NOTICE.txt` (whose path has no version) and 404 answers under `/ocr/`. This is harmless, since a fix would ship under a new path, but it should be checked on the real hosts.
- **What the phone keeps:**
  - the reading model in the browser's IndexedDB (key prefix `ocr-mrz-1`). It is the public model file and holds no personal data;
  - the engine files in the browser's normal cache.

## In place at M3
M3 adds the AI worker: a Python function on Vercel (Paris region, `cdg1`) that re-checks each document photo, re-reads its code lines, recognises the document and reads a few printed fields. Details are in `M3_SPEC.md`.

- **The trust boundary: the worker is an outside processor that decides nothing.**
  - It holds no Supabase credential except the public "publishable" key that the web pages also carry. It cannot read the database or the storage bucket.
  - Through the `worker` Edge Function it can do exactly three things: claim the next due job, fetch **that job's** photo while its 120-second lease runs, and post **that job's** result.
  - Its result is evidence only: measures, candidate code lines, a few fields, counts and flags. The Edge Function validates it strictly (any unknown key, wrong type or out-of-range value is refused) and makes every decision itself, with the same MRZ corrector and parser as the phone. The first result for a job wins.
- **Ed25519 request signatures.**
  - Each request is signed over `v1|confiance-verify/worker|<key id>|<method>|<route>|<Unix seconds>|<nonce>|<SHA-256 of the body>`. The version and audience bind a signature to this API; the route and body hash bind it to this request.
  - Checks, cheapest first: header shape; timestamp within ±60 seconds; body read up to 32 KB and no further; key known and not revoked; signature over the raw bytes before any JSON is parsed; nonce used once.
  - **Small-order public keys are refused.** WebCrypto accepts such a key, and with it anyone could make a signature that verifies (an all-zero key with an all-zero signature does). Only our own keys go into `worker_key`, but a placeholder key there must not open the door.
  - Any request with a browser `Origin` header is refused (403): no web page may call this API.
  - Signatures are verified with WebCrypto (no extra library). The same fixed test vectors (RFC 8032 test key) pass in TypeScript and in the worker's Python.
- **Replay guard.** The 32-hex nonce of every accepted request is stored once (`worker_nonce`) until its timestamp could no longer be accepted, then purged by the sweep. It is written only after the signature has been verified, so unsigned requests cannot fill the table.
- **The worker's key** (one key pair; the worker's).
  - The private key is generated with `umask 077`, never printed, stored on Vercel as a **sensitive** production variable (`WORKER_SIGNING_KEY`), and its file is shredded.
  - The public key is stored in `worker_key`. Rotation: insert a new key, deploy the worker with it, then set `revoked_at` on the old one. A key revoked between lookup and nonce is still refused (`worker_use_nonce` checks again).
- **The doorbell carries no authority.** A ring is an empty `POST` to the worker's public URL. Anyone may ring; the worker then claims whatever is due through the signed API, and answers only `{"ok": true}`. The worst a stranger's ring does is wake the worker to find no work. Its models load only after a successful claim, so such a ring costs little CPU. At deploy, Vercel's firewall allows only `POST /api/process` and rate-limits it.
- **No image URL leaves Supabase.** The `worker` function reads the photo from the private bucket and relays its bytes, only to the attempt holding the lease (`404` otherwise; `410` when the photo was replaced or erased).
  - **Every relay is audited first** (`worker.image`, with `{jobId, attempt, verificationId, byteSize}`): if the audit entry cannot be written, no bytes are sent.
- **Images in memory only, decoded defensively.** The worker checks the bytes' size and SHA-256 against the claim, decodes them with Pillow's JPEG decoder only (never OpenCV's decoders, never video), with a pixel limit from the 1,600 px long side. Nothing is written to disk.
- **Data minimisation.**
  - Raw OCR text never leaves the worker.
  - It reads only the fields listed in `M3_SPEC.md`, never parents' names, address, height, place of birth, occupation, distinguishing marks, the 17-digit unique identifier or the passport's card access number.
  - The QR code on the new cards is **detected, never decoded**, so its identity data is never read.
  - Code lines and fields read by the server, including the card sub-type, are stored only encrypted (`extracted_document_data`, same Vault key as M2) and shown only through the audited "Show data read".
  - `check_result.details` hold outcomes, generic codes, counts, measures and field **names**: never a value, never the card sub-type, never a nationality. Supervisors and admins can read that table. The policy reasons are generic, and every residence permit goes to a person, so no reason reveals a refugee card.
  - `worker_job.evidence` (generic family codes, counts, flags) is not readable by staff. Staff may read only each job's status (with its photo and case ids, under the same rule as the photos), so the case page can say per photo whether the server is still working on it.
- **Audit entries** hold identifiers, outcomes and codes only: `worker.image`, `worker.result` (`{jobId, captureId, attempt, checks}`, an outcome per check), `worker.job_failed` (`{jobId, captureId, code, attempts}`), and `capture.create` now adds `replaced` (a count).
- **Log hygiene.**
  - The worker logs event codes, exception class names and numbers only, never a message (which could quote data), a body or anything read from a photo. Third-party loggers are set to ERROR, and the standard library's per-request log line is turned off. Vercel's own runtime logs only "POST /api/process" and the status.
  - The Edge Functions log codes only, and their error messages never repeat a value sent.
  - The worker's ring answers (`{"ok":true}`) are all that pg_net keeps (6 hours).
- **Models cannot be swapped or fetched.** The OCR model files come from the pinned rapidocr wheel; their SHA-256 is checked when they load, and their paths are set so that RapidOCR never downloads one (by default it would fetch missing models from modelscope.cn).
- **The test-only switch, enforced in the database.**
  - While `worker_settings.enabled_for_real_sessions` is false, a real session's photo gets a job that is already failed (`ineligible`): it is never handed out, never relayed to Vercel, and the warm-up ring is not sent for it.
  - The claim checks eligibility again (test session, or switch on; session still open; document declared).
  - The rider is never blocked: the photo is "unchecked" and a person reviews the case.
- **The daily job cap** (`daily_job_cap`, default 150 per day, Douala time) bounds the CPU any flood of uploads can burn. Beyond it, jobs end `failed` with code `budget`: those photos go unchecked, to staff, for the rest of the day.
- **Concurrency without lost updates or deadlocks.** Every writer of a case's server checks takes one advisory lock per case before touching rows. The case-level checks are written only if the case has not changed since the snapshot they were decided from (otherwise `stale`, decide again). The claim and the sweep skip a case that another writer holds instead of waiting.
- **Replaced photos are erased.** A newer photo of a side marks the older one erased (`superseded_by`), deletes the data read from it, drops its unfinished job, and the `flow` function removes its file from storage.
- **Supply chain of the worker.**
  - Exact pins in `worker/uv.lock` with hashes, and `exclude-newer` enforcing the two-week rule.
  - An override keeps OpenCV's GUI build (Qt) out.
  - The one source-only package (antlr4 4.9.3) is built with a pinned setuptools; its build dependency's hash is not in the lock.
  - Licences and the native parts of every wheel: `LICENSES.md`.

## Open items for the security engineer
- **Supabase Auth public sign-ups are still enabled** at the platform level. This does not give access: staff access requires an invite, and sign-ups get no staff profile. They should still be disabled in the Supabase dashboard (Authentication → Sign In / Providers). Until then, keep "Confirm email" on: enrollment takes over an existing account for the invited address. Setting the new password revokes that account's refresh tokens, but access tokens it already holds stay valid until they expire (1 hour by default), and anything else its previous holder set up on it (MFA factors, linked identities, user metadata) stays.
- **Staff 2FA** is not in place yet; it arrives in M9 with the dashboard v1. Until then staff sign in with email and password only (12 characters or more).
- **Staff sessions live in browser `localStorage`** (Supabase Auth default, `persistSession: true`), so any script running on the dashboard origin could read them. The strict CSP (`script-src 'self'`) is the main defence.
- **No IP rate limiting** on the public endpoints (`/flow/*`, `/admin/enroll`). Invite codes are limited to 5 attempts in the database, and upload links to 20 per session. Rate limiting and abuse protection still need a design.
- **Server-side pixel checks cover test sessions only** until the switch is turned on (after Vercel Pro and its DPA). For real sessions the server still checks size, JPEG signature and resolution only, and the MRZ only for consistency. Even with the worker, check digits are public arithmetic: a forged document printed with consistent code lines passes them. The worker closes a narrower gap (lines that never came from the photo now show as "not the lines read on the phone"). In Phase 1 a person reviews every case.
- **Vercel Hobby, for testing only.**
  - Its terms allow only non-commercial personal use, and it comes with **no data processing agreement**.
  - **Vercel Inc. is a US company:** even though the function runs in Paris, the lawyer must assess the transfer, and whether Vercel's logs and metadata are kept elsewhere.
  - Before real sessions: Vercel Pro, its DPA, and the lawyer's agreement, or the same worker on another host.
  - Anyone with admin rights on the Vercel project can deploy code that keeps the photos it is given. Protect that account with 2FA and few members.
- **The CPU budget is a denial-of-service surface.**
  - Hobby includes 4 CPU-hours a month, roughly 3,000–4,000 photos at the measured speed. Cold starts cost more (each loads the models). The bundle (about 377 MB) is over Vercel's 225 MB standard size; `worker/vercel.json` makes Vercel bundle all of it, so no package and no model is fetched from PyPI at a cold start.
  - Rings without work cost little, but each is an invocation. Vercel's firewall rate limit must be in place.
  - Once the switch is on, anyone holding real session links can upload photos up to the per-session upload limit (20) and the daily cap. Beyond the cap, real riders' photos also go unchecked, to staff: degraded, never blocked.
  - What Vercel does once the monthly allowance is used must be checked on its Usage page. If the worker stops answering, photos become "unchecked".
- **Cost of unauthenticated requests to the worker API:** each well-formed request inside the time window costs one `worker_key` lookup before its signature is checked. There is no rate limit on the Supabase side.
- **Firewall rules are set by hand at deploy** (allow only `POST /api/process`; rate limit), not in code. Check them after every project change.
- **Ed25519 through WebCrypto** is verified in Node and Deno, not yet on Supabase's Edge Runtime: a smoke test after deploy, with `@noble/ed25519` (MIT) as the fallback. pg_net and pg_cron are tested only against stand-ins in CI.
- **OpenSSL 1.1.1k inside the OpenCV wheel** (in FFmpeg's libraries) is out of support. Scanners will report it. Our code never calls the video or network functions that use it (photos are decoded by Pillow only), but it ships until the slim OpenCV build, which also removes Intel IPP and the LGPL FFmpeg.
- **Provisional classification can be fooled** by anything printed with the right words: it never decides on its own, and it is shown as provisional. The same goes for the provisional quality thresholds, which can only ask for one retake per side.
- **Late results:** a result from an earlier attempt is accepted while its job is pending, claimed or failed (the first result wins), including a job given up as `ineligible` after one attempt.
- **Best-effort cleanup:** if removing a replaced photo's file fails, the file stays in the bucket with its row marked erased (logged). The retention job (M13) must find such files by listing the bucket.
- **Supabase Free plan egress:** every checked photo leaves storage once more (relayed to the worker), which counts against the plan's egress allowance.
- Per-image encryption with our own keys (on top of Supabase's disk encryption)?
- **Review the column-encryption design** for `extracted_document_data` (in place since M2, described above). In particular:
  - **Key rotation:** each row records its key's name, but there is no rotation procedure yet: add `document_data_key_v2`, re-encrypt the old rows, then retire v1.
  - **Key held outside the database, later:** today the key sits in Vault, in the same database as the data. Anyone who can run SQL as the database owner, or who holds the service-role key, can decrypt. The read function trusts the admin function to name the signed-in staff member: it checks that this person is active staff with the right role, but a service-role caller could name any supervisor (the read would still be audited under that name). Holding the key outside the database, for example in a key service used by the AI worker, would mean a database compromise alone reveals nothing.
  - **Backups:** confirm what a Supabase backup or a restored project contains (Vault secrets, and whether the Vault root key travels with them), and that deletion also covers the encrypted rows in backups.
  - **Encryption is tested only against a stand-in Vault in CI** (plain-text secrets). The deploy step checks it on the real Vault.
- **Debug mode works on any rider session.** The dashboard offers the debug link only for test sessions, but the rider app accepts `?debug=1` on any session. It then shows the rider what was read from the document in their own hands, with ✅/❌ for each check digit. The check-digit rules are public, so this gives a forger nothing new, but consider limiting debug mode to test sessions before real riders (M10).
- **Consent wording:** the placeholder consent text now says we collect "the details read from its code lines (name, number, dates)". The lawyer's final text must cover this (`CONSENT_VERSION` is now `placeholder-v1`, so each recorded consent names the wording shown).
- **Install scripts:** `npm ci` runs the install scripts of dependencies. Three packages in the lockfile have one: `deno` (sets up its binary), `fsevents` (macOS only), and, since M2, `tesseract.js` (`opencollective-postinstall`, which only prints a message). Consider running only the scripts that are needed.
- Supabase Auth settings: 2FA enforcement, session lifetime, password policy, SSO.
- Virtual camera / injected video detection for liveness.
- Data residency (Supabase EU region; the AI worker in Vercel's Paris region) and contracts with Supabase and Vercel (with the lawyer). The test sites on Vercel are public (no data on them; access needs a session link or a staff sign-in); consider Vercel deployment protection before real riders.
- Backups: they also contain images, so deletion must cover them.

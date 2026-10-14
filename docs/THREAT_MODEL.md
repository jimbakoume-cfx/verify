# Threat model (living document; started at M0)

This is a starting point for the **human security engineer**, who must review it before launch (see `PLAN.md` section 6). It is updated at every milestone.

## What we protect
1. **ID document images, selfies and liveness frames.** Most sensitive. A leak enables identity theft.
2. **Extracted identity data:** name, date of birth, ID number, nationality. Since M2 this includes the MRZ ("code lines") read on the rider's phone, stored encrypted.
3. **Decisions and the audit log.** Integrity matters: a forged "approved" lets a fraudster ride.
4. **Thresholds.** Changing them silently could auto-approve fraud.
5. **Secrets:** Supabase service-role key, API keys, webhook signing secrets.

## Who might attack, and how

| Attacker | Goal | Main defences (planned or in place) |
|---|---|---|
| Fraudulent rider | Pass with a fake, stolen or edited ID, or someone else's face | Server-side checks only (the phone is never trusted); MRZ check digits, recomputed by the server; the server re-reads the MRZ from the image (M3); consistency checks; tamper and replay signals; active + passive liveness; face match; human review in Phase 1 |
| Rider replaying another session | Re-use frames or uploads | Single-use session tokens (stored hashed); one-time liveness codes; image sha256 reuse detection |
| Outside attacker | Steal images in bulk | Private bucket with **no** storage policies; RLS on every table; anon role has no table access; service-role key only on the server; HTTPS everywhere; strict headers/CSP |
| Curious or malicious staff | Browse or export IDs | Reviewers see only cases assigned to them; every image view, and every view of data read from a document, goes through an audited function and is shown for 60 seconds; admins have no routine access to either; 2FA required |
| Insider with database access | Hide what they did | Audit log is append-only (update, delete and truncate are blocked by triggers) and hash-chained; `audit_chain_first_break()` detects edits |
| Compromised Confiance backend / API key | Create sessions, read results | API keys stored hashed; results never include images; per-client key rotation; rate limits (M10) |
| Supply chain | Malicious dependency | Lockfile + `npm ci`; licence check; versions at least two weeks old when added; secret scanning |

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
- **Upload limits per session:** at most 20 upload links per session (atomic counter in the database). Uploads go straight to the private bucket with signed upload tokens, each tied to one object path that cannot be overwritten. Each path is bound to its session and side. The server checks size (10 KB to 5 MB), JPEG signature and resolution (long side 720 px or more), and deletes rejected files. It flags an image already uploaded in another verification (same SHA-256) for staff only; the rider is not told, so the check cannot be probed.
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

## Open items for the security engineer
- **Supabase Auth public sign-ups are still enabled** at the platform level. This does not give access: staff access requires an invite, and sign-ups get no staff profile. They should still be disabled in the Supabase dashboard (Authentication → Sign In / Providers). Until then, keep "Confirm email" on: enrollment takes over an existing account for the invited address. Setting the new password revokes that account's refresh tokens, but access tokens it already holds stay valid until they expire (1 hour by default), and anything else its previous holder set up on it (MFA factors, linked identities, user metadata) stays.
- **Staff 2FA** is not in place yet; it arrives in M9 with the dashboard v1. Until then staff sign in with email and password only (12 characters or more).
- **Staff sessions live in browser `localStorage`** (Supabase Auth default, `persistSession: true`), so any script running on the dashboard origin could read them. The strict CSP (`script-src 'self'`) is the main defence.
- **No IP rate limiting** on the public endpoints (`/flow/*`, `/admin/enroll`). Invite codes are limited to 5 attempts in the database, and upload links to 20 per session. Rate limiting and abuse protection still need a design.
- **No server-side pixel check until M3:** the server checks size, JPEG signature and resolution only. Blur, glare and framing are measured on the phone, which is not trusted, and so is the MRZ: until the M3 worker re-reads the image, a forged MRZ with correct check digits passes M2's check. The AI worker re-checks images in M3.
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
- Data residency (Supabase EU region) and contracts with Supabase and Vercel (with the lawyer). The test sites on Vercel are public (no data on them; access needs a session link or a staff sign-in); consider Vercel deployment protection before real riders.
- Backups: they also contain images, so deletion must cover them.

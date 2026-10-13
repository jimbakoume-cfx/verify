# Threat model (living document; started at M0)

This is a starting point for the **human security engineer**, who must review it before launch (see `PLAN.md` section 6). It is updated at every milestone.

## What we protect
1. **ID document images, selfies and liveness frames.** Most sensitive. A leak enables identity theft.
2. **Extracted identity data:** name, date of birth, ID number, nationality.
3. **Decisions and the audit log.** Integrity matters: a forged "approved" lets a fraudster ride.
4. **Thresholds.** Changing them silently could auto-approve fraud.
5. **Secrets:** Supabase service-role key, API keys, webhook signing secrets.

## Who might attack, and how

| Attacker | Goal | Main defences (planned or in place) |
|---|---|---|
| Fraudulent rider | Pass with a fake, stolen or edited ID, or someone else's face | Server-side checks only (the phone is never trusted); MRZ check digits; consistency checks; tamper and replay signals; active + passive liveness; face match; human review in Phase 1 |
| Rider replaying another session | Re-use frames or uploads | Single-use session tokens (stored hashed); one-time liveness codes; image sha256 reuse detection |
| Outside attacker | Steal images in bulk | Private bucket with **no** storage policies; RLS on every table; anon role has no table access; service-role key only on the server; HTTPS everywhere; strict headers/CSP |
| Curious or malicious staff | Browse or export IDs | Reviewers see only cases assigned to them; every image view goes through an audited function issuing 60-second links; admins have no routine image access; 2FA required |
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

## Open items for the security engineer
- **Supabase Auth public sign-ups are still enabled** at the platform level. This does not give access: staff access requires an invite, and sign-ups get no staff profile. They should still be disabled in the Supabase dashboard (Authentication → Sign In / Providers). Until then, keep "Confirm email" on: enrollment takes over an existing account for the invited address. Setting the new password revokes that account's refresh tokens, but access tokens it already holds stay valid until they expire (1 hour by default), and anything else its previous holder set up on it (MFA factors, linked identities, user metadata) stays.
- **Staff 2FA** is not in place yet; it arrives in M9 with the dashboard v1. Until then staff sign in with email and password only (12 characters or more).
- **Staff sessions live in browser `localStorage`** (Supabase Auth default, `persistSession: true`), so any script running on the dashboard origin could read them. The strict CSP (`script-src 'self'`) is the main defence.
- **No IP rate limiting** on the public endpoints (`/flow/*`, `/admin/enroll`). Invite codes are limited to 5 attempts in the database, and upload links to 20 per session. Rate limiting and abuse protection still need a design.
- **No server-side pixel check until M3:** the server checks size, JPEG signature and resolution only. Blur, glare and framing are measured on the phone, which is not trusted; the AI worker re-checks images in M3.
- Per-image encryption with our own keys (on top of Supabase's disk encryption)?
- Column encryption design for `extracted_document_data` (M2/M3).
- Supabase Auth settings: 2FA enforcement, session lifetime, password policy, SSO.
- Virtual camera / injected video detection for liveness.
- Data residency (Supabase EU region) and contracts with Supabase and Vercel (with the lawyer). The test sites on Vercel are public (no data on them; access needs a session link or a staff sign-in); consider Vercel deployment protection before real riders.
- Backups: they also contain images, so deletion must cover them.

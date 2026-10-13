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

## Open items for the security engineer
- Per-image encryption with our own keys (on top of Supabase's disk encryption)?
- Column encryption design for `extracted_document_data` (M2/M3).
- Supabase Auth settings: 2FA enforcement, session lifetime, password policy, SSO.
- Rate limiting and abuse protection on public Edge Functions.
- Virtual camera / injected video detection for liveness.
- Data residency (Supabase EU region) and contracts with Supabase and Netlify (with the lawyer).
- Backups: they also contain images, so deletion must cover them.

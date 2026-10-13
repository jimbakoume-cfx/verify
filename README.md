# Confiance Verify

In-house identity verification (KYC) for Confiance riders. It is a standalone web platform that the Confiance ride-hailing app connects to through an API. Nothing is sent to outside KYC vendors.

- **Plan (approved):** [`docs/PLAN.md`](docs/PLAN.md)
- **Licence register:** [`docs/LICENSES.md`](docs/LICENSES.md)
- **Threat model:** [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)

## What is in this repository

| Folder | What it is |
|---|---|
| `apps/rider` | The rider's verification flow (mobile web page, FR/EN), hosted on Netlify |
| `apps/dashboard` | The internal ops dashboard for the KYC team, hosted on Netlify |
| `packages/capture` | The camera quality engine: blur, glare, brightness and framing checks, card detection, auto-capture, compression (pure TypeScript, runs in the rider's browser) |
| `packages/shared` | Code shared by both apps: languages, branding, Supabase connection, and the HTTP contract re-exported from `supabase/functions/_shared/contract.ts` |
| `supabase/functions` | Edge Functions: `flow` (the rider's session API) and `admin` (staff enrollment, test sessions, audited photo links) |
| `supabase/migrations` | Database structure and security rules, applied to Supabase |
| `supabase/tests` | Automatic tests proving the security rules work |
| `scripts` | Licence check and database test runner |
| `docs` | Plan, milestone spec, licences, threat model |

## Milestone status

| Milestone | Status |
|---|---|
| M0: foundations (apps, database, security rules, CI) | Done |
| **M1**: ID capture | In review |
| M2: MRZ reading | Next |

## How to test M1 on your phone
1. **Once:** an administrator creates your invite (see the comment at the top of `supabase/migrations/20261014000000_m1_capture.sql`) and gives you the one-time code. Use the role **supervisor**: admins cannot open ID photos, by design.
2. On the dashboard, choose **Set up my account**, then enter your email, the invite code and a new password (12 characters or more). Next time, just sign in with email and password.
   Forgotten password, or an invite that expired or was locked after 5 wrong codes: the administrator runs the same statement again with a new code (it updates the existing invite and resets its counter), and you choose **Set up my account** again; your account and role are kept.
3. Press **New test session**: a QR code and a rider link appear, valid for 30 minutes.
4. On your phone, scan the QR code or open the link. Both Netlify sites ask for a Netlify team login, which can lose the link's `#s=…` part, so log in on the phone first (open the rider site once), then open the link again.
5. Follow the rider flow: consent, document choice, front (and back), review, upload, done. Try good and bad light: bad photos get a clear hint.
6. Back on the dashboard, open the case and press **View photo** for each side. Each view is recorded in the audit log, and the photo disappears after 60 seconds.

Add `?debug=1` before the `#` of the rider link to see the live quality metrics (`apps/rider/README.md`).

## For developers

Requirements: Node 22, npm 10+.

```bash
npm ci
npm run dev:rider        # http://localhost:5173
npm run dev:dashboard
npm test                 # unit tests
npm run typecheck
npm run licenses         # commercial-licence check
npx deno check supabase/functions/flow/index.ts supabase/functions/admin/index.ts supabase/functions/*/*.test.ts
npx deno lint supabase/functions                     # Edge Functions (Deno is a dev dependency)
DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres scripts/test-db.sh   # schema + security-rule tests (disposable Postgres only)
```

Supabase settings go in `apps/*/.env.local` (see `.env.example`). Only the **publishable** key belongs in the web apps. The service-role key must never be committed or put in a web app.

### Netlify setup (one site per app)
Both sites build from the repository root using the root `netlify.toml`. Each site needs these environment variables:
- `VERIFY_APP`: `rider` (site `confiance-verify`) or `dashboard` (site `confiance-verify-ops`)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`: public values from the Supabase project

Security headers and page routing ship with each app (`apps/*/public/_headers`, `_redirects`). The sites are private: you must be logged in to the Netlify team to open them.

### Edge Function settings (Supabase secrets)
Both functions are deployed with `verify_jwt = false` (`supabase/config.toml`): they check the rider's session token or the staff member's sign-in themselves. Supabase provides `SUPABASE_URL` and the service key; set these secrets:

| Secret | Value | Used by |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://confiance-verify.netlify.app,https://confiance-verify-ops.netlify.app` | both: browser origins allowed to call them, matched exactly (no wildcards). Add a Netlify preview origin such as `https://deploy-preview-12--confiance-verify.netlify.app`, or `http://localhost:5173` for local development, while you need it. |
| `RIDER_APP_URL` | `https://confiance-verify.netlify.app` | `admin`: base of the rider link (`<RIDER_APP_URL>/#s=<token>`) |
| `TEST_SESSION_TTL_MINUTES` | optional, default `30` | `admin`: lifetime of a test session |

When a required secret is missing, the function refuses the requests that need it and logs a warning at startup.

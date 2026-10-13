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
| `packages/shared` | Code shared by both apps: languages, branding, Supabase connection |
| `supabase/migrations` | Database structure and security rules, applied to Supabase |
| `supabase/tests` | Automatic tests proving the security rules work |
| `scripts` | Licence check and database test runner |
| `docs` | Plan, licences, threat model |

## Milestone status

| Milestone | Status |
|---|---|
| **M0**: foundations (apps, database, security rules, CI) | In review |
| M1: ID capture | Next |

## How to test M0 on your phone
1. Open the rider link and the dashboard link (shared in the pull request once Netlify is connected).
2. Tap **FR / EN**: all text switches language, and the choice is remembered when you reload.
3. Add `?lang=en` to the end of the link: the page opens in English. This is how the Confiance app will choose the language.
4. At the bottom, check that it says **"Serveur connecté / Server connected"** with a green dot.

## For developers

Requirements: Node 22, npm 10+.

```bash
npm ci
npm run dev:rider        # http://localhost:5173
npm run dev:dashboard
npm test                 # unit tests
npm run typecheck
npm run licenses         # commercial-licence check
DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres scripts/test-db.sh   # schema + security-rule tests (disposable Postgres only)
```

Supabase settings go in `apps/*/.env.local` (see `.env.example`). Only the **publishable** key belongs in the web apps. The service-role key must never be committed or put in a web app.

### Netlify setup (one site per app)
Both sites build from the repository root using the root `netlify.toml`. Each site needs these environment variables:
- `VERIFY_APP`: `rider` (site `confiance-verify`) or `dashboard` (site `confiance-verify-ops`)
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`: public values from the Supabase project

Security headers and page routing ship with each app (`apps/*/public/_headers`, `_redirects`). The sites are private: you must be logged in to the Netlify team to open them.

# Confiance Verify

In-house identity verification (KYC) for Confiance riders. It is a standalone web platform that the Confiance ride-hailing app connects to through an API. Nothing is sent to outside KYC vendors.

- **Plan (approved):** [`docs/PLAN.md`](docs/PLAN.md)
- **Milestone specs:** [`docs/M1_SPEC.md`](docs/M1_SPEC.md) (ID capture), [`docs/M2_SPEC.md`](docs/M2_SPEC.md) (MRZ reading), [`docs/M3_SPEC.md`](docs/M3_SPEC.md) (the AI worker's server checks)
- **Licence register:** [`docs/LICENSES.md`](docs/LICENSES.md)
- **Threat model:** [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)

## What is in this repository

| Folder | What it is |
|---|---|
| `apps/rider` | The rider's verification flow (mobile web page, FR/EN), hosted on Vercel: https://confiance-verify.vercel.app. Since M2 it also reads the code lines (MRZ) on the phone, with a reading engine and model served from the site itself under `/ocr/` (`public/ocr/`, `src/mrz/`). Since M3 it waits for the server's check of the photos ("Checking your photos…") and retakes a photo the server cannot use. |
| `apps/dashboard` | The internal ops dashboard for the KYC team, hosted on Vercel: https://confiance-verify-ops.vercel.app. Since M3 the case page shows the server's checks and the data read by the server. |
| `packages/capture` | The camera quality engine: blur, glare, brightness and framing checks, card detection, auto-capture, compression. Since M2 it also finds the code lines on the photo and prepares them for reading (`src/mrz/`). Pure TypeScript, runs in the rider's browser. |
| `packages/shared` | Code shared by both apps: languages, branding, Supabase connection, and the HTTP contract and MRZ parser re-exported from `supabase/functions/_shared/` |
| `supabase/functions` | Edge Functions: `flow` (the rider's session API), `admin` (staff enrollment, test sessions, audited photo links, audited "data read" views) and, since M3, `worker` (the AI worker's signed API: claim a job, fetch its photo, send the result; all decisions are made here). `_shared/mrz.ts` and `_shared/mrzCorrect.ts` are our MRZ parser and look-alike correction, used by the phone, the server and the dashboard alike. |
| `supabase/migrations` | Database structure and security rules, applied to Supabase |
| `supabase/tests` | Automatic tests proving the security rules work |
| `worker` | **The AI worker (M3):** Python 3.12, one Vercel function (`api/process.py`, project `confiance-verify-worker`, Paris region). Re-checks photo quality, re-reads the code lines, gathers evidence of the document type and reads a few printed fields, with RapidOCR. See [`worker/README.md`](worker/README.md). |
| `training/mrz` | **Our own MRZ reading model (M3):** the reproducible training recipe, its pinned inputs and its acceptance gates. Runs on a training machine only. See [`training/mrz/README.md`](training/mrz/README.md). |
| `e2e` | Browser tests (Playwright) with a fake camera; `e2e/fixtures/mrz` holds the MRZ test images, `e2e/fixtures/specimens` the worker's fictitious specimen documents (M3) |
| `scripts` | Licence check, database test runner, the fake-camera video, MRZ test-image and specimen-document generators, and the fonts used only to draw those images (OCR-B, and Inter since M3) |
| `docs` | Plan, milestone specs, licences, threat model |

## Milestone status

| Milestone | Status |
|---|---|
| M0: foundations (apps, database, security rules, CI) | Done |
| M1: ID capture | Done |
| M2: MRZ reading | Done |
| **M3**: AI worker (the server re-checks the photos, re-reads the code lines from the image, recognises the document, reads printed text; our own MRZ model's training) | In review |
| M4: consistency checks and first risk flags | Next |

## Before you test (once)
1. An administrator creates your invite (see the comment at the top of `supabase/migrations/20261014000000_m1_capture.sql`) and gives you the one-time code. Use the role **supervisor**: admins cannot open ID photos or the data read from them, by design.
2. On the dashboard, choose **Set up my account**, then enter your email, the invite code and a new password (12 characters or more). Next time, just sign in with email and password.
   Forgotten password, or an invite that expired or was locked after 5 wrong codes: the administrator runs the same statement again with a new code (it updates the existing invite and resets its counter), and you choose **Set up my account** again; your account and role are kept.

## How to test M3 on your phone
M3 adds the "AI worker": the server now looks at each photo itself. It checks that the photo is usable, reads the code lines from the image and compares them with what your phone read, recognises the document and reads a few printed fields. The full test, and what counts as a pass, is in [`docs/M3_SPEC.md`](docs/M3_SPEC.md) ("The PM test").

**Only test sessions are checked by the server for now.** Real sessions stay unchecked until Vercel Pro and its data processing agreement are in place. Use your own documents only, and never paste data read from a document into a chat or a ticket.

1. On the dashboard, press **New test session** and scan the **Debug link** with your phone.
2. Accept the consent and choose your document. The list now says **Titre de séjour ou carte de réfugié** (*Residence permit or refugee card*).
3. Photograph each side as in M2.
4. After the photos are sent, the phone shows **Vérification de vos photos…** (*Checking your photos…*), usually for a few seconds and never more than about 20.
   - If the server cannot use a photo (no document on it, or no readable text), the camera for that side opens again with **"… : photo à reprendre"** and the reason. This happens at most once per side.
   - If the server is slow (the first photo after a quiet period can be) or down, the phone simply continues.
5. On the dashboard, open the case. The new **Contrôles du serveur** (*Server checks*) section shows:
   - the document recognised, and whether it comes from the code lines (firm) or from printed words (provisional);
   - what a person must decide;
   - for each side: the photo check, the server's own reading of the code lines (**Same lines as read on the phone ✅** is what we hope to see), and which printed fields were found.
6. **Afficher les données lues** (*Show data read*), now in its own section **Données lues sur le document** (*Data read from the document*), adds the server's code lines and the printed fields for 60 seconds. Each view is recorded in the audit log.

Two extra tries:
- **Retake:** choose the old CNI and photograph a blank plastic card as the front. You should be asked once to take it again; the second time it is kept and flagged.
- **Slow server:** add `&checksWaitMs=3000` after `?debug=1` in the debug link (before the `#`). The phone continues after 3 seconds.

Please send screenshots of the "Server checks" section (they show no personal data), and say which fields were wrong or missing, without copying them.

## How to test M2 on your phone
The MRZ, or "code lines", are the 2 or 3 lines of letters, digits and `<<<` at the bottom of a passport's photo page or on the back of the new ID card. M2 reads them on the phone and checks their check digits there and again on the server.

1. On the dashboard, press **New test session** (*Nouvelle session de test*). Two QR codes appear, valid for 30 minutes: the rider link and the **Debug link** (*Lien de débogage*).
2. Scan the **Debug link** QR code with your phone. It opens the rider site with the debug panel on.
3. Accept the consent, then choose **Passport** (*Passeport*) or **New national ID card (2025)** (*Nouvelle CNI (2025)*). The old CNI has no code lines, so nothing is read for it.
4. Photograph the document as asked: the passport's photo page, or the new CNI's front, then its back. The code lines are on the passport's photo page and on the CNI's back. Keep the `<<<` lines whole and sharp, with no glare on them.
5. After the photo of the side with the code lines, the **Reading the code lines…** screen appears for a few seconds.
   - The first time only, the phone downloads the reader: **about 2.8 MB, once**, then it is kept on the phone. Use Wi-Fi if you can.
6. The review screen shows **Code lines read ✓**. That is all a real rider will see.
   - Below it, the debug panel lists ✅/❌ for each check digit and the fields read (name, number, dates…). It also shows the character height, which helps us tune the reader to your phone, so a screenshot is welcome.
   - If the lines could not be read, you get tips and **Retake the photo** becomes the main button. After 3 failed tries, **Continue anyway** appears, and the case is flagged for staff.
7. Press **Use this photo** and let the photos send.
8. Back on the dashboard, open the case (**Open this session's case**). The **Code lines (MRZ)** section shows the server's own check: ✅/❌ for each check digit, whether the document code fits, tries and reading time.
9. Press **Show data read** (*Afficher les données lues*): the fields and the raw code lines appear for 60 seconds. Each view is recorded in the audit log.

**One assumption to confirm:** M2 assumes the new CNI (2025) carries its code lines as **3 lines on its back** (the standard ID-card layout). If a real card has them on the front, or has another number of lines, say so: it is a one-line change (`MRZ_EXPECTATION` in `supabase/functions/_shared/contract.ts`).

Everything from M1 still works the same way: bad light or blur gets a clear hint, and **View photo** on the case page shows each photo for 60 seconds. Without the debug link, you can add `?debug=1` before the `#` of a rider link yourself (`apps/rider/README.md`).

## For developers

Requirements: Node 22, npm 10+.

```bash
npm ci
npm run dev:rider        # http://localhost:5173
npm run dev:dashboard
npm test                 # unit tests, including real MRZ reading on the test images (about 5 s)
npm run typecheck
npm run licenses         # commercial-licence check
npx deno check supabase/functions/flow/index.ts supabase/functions/admin/index.ts supabase/functions/worker/index.ts supabase/functions/*/*.test.ts
npx deno lint supabase/functions                     # Edge Functions (Deno is a dev dependency)
DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres scripts/test-db.sh   # schema + security-rule tests (disposable Postgres only; PostgreSQL 16 or later)
```

The AI worker (Python 3.12, needs [uv](https://docs.astral.sh/uv/)):

```bash
cd worker
uv sync                      # the locked dependencies (uv.lock, with hashes)
uv run pytest                # everything, including the real OCR on the specimen photos (about 2 minutes)
uv run pytest -m "not ocr"   # without the OCR models (seconds)
uv lock --check
```

The worker's specimen photos in `e2e/fixtures/specimens` are committed. To change them, run `uv run python ../scripts/make-specimens.py` from `worker/` and commit the result. The MRZ model's training is described in `training/mrz/README.md`; it runs for hours on a training machine, never in CI.

Supabase settings go in `apps/*/.env.local` (see `.env.example`). Only the **publishable** key belongs in the web apps. The service-role key must never be committed or put in a web app.

The MRZ test images in `e2e/fixtures/mrz` are committed. To change them, run `python3 scripts/make-mrz-fixtures.py` (needs Pillow; developer machines only) and commit the result.

### Hosting (Vercel, test environment)
Both sites are static builds published to the Vercel team "JB":
- rider: https://confiance-verify.vercel.app (project `confiance-verify`)
- dashboard: https://confiance-verify-ops.vercel.app (project `confiance-verify-ops`)

To publish: build the app with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set (public values from the Supabase project), copy `apps/<app>/vercel.json` into `apps/<app>/dist`, then run `vercel deploy --prod --scope suivix` from that folder. `vercel.json` carries the security headers and page routing; a test keeps it in sync with the Netlify files (`public/_headers`, `_redirects`, root `netlify.toml`), which still work if the sites move back to Netlify.

The rider build also writes the reading engine's files into `dist/ocr/7.0.0/`, next to the model in `dist/ocr/mrz-1/`. These paths are cached by phones for a year, so a new engine or model version must get a new folder name (see `apps/rider/src/mrz/types.ts`).

Apply a milestone's database migration before publishing its dashboard: since M2 the case page reads `check_result.capture_id`, and since M3 `capture.superseded_by` and the server checks.

The sites themselves hold no data: riders need a session link from staff, and the dashboard needs a staff sign-in.

**The AI worker** (M3) is a third Vercel project, `confiance-verify-worker`, with root folder `worker/`, region Paris (`cdg1`) and no Git deployments. Its production address, `https://confiance-verify-worker.vercel.app/api/process`, is its "doorbell". Its settings are production-only Vercel environment variables:
- `SUPABASE_WORKER_URL` (`https://<project-ref>.supabase.co/functions/v1/worker`);
- `SUPABASE_PUBLISHABLE_KEY` (public);
- `WORKER_KEY_ID`;
- `WORKER_SIGNING_KEY`: **secret**, marked sensitive. Its public half goes into the database table `worker_key`.

Vercel's firewall allows only `POST /api/process` and rate-limits it. Deploy steps, and the SQL to add or revoke a key, turn on real sessions or change the daily cap: `docs/M3_SPEC.md` ("Deploy notes", "Operating the worker"). **Real sessions stay off** (`worker_settings.enabled_for_real_sessions = false`) until Vercel Pro and its DPA are in place.

### Edge Function settings (Supabase secrets)
All three functions (`flow`, `admin`, `worker`) are deployed with `verify_jwt = false` (`supabase/config.toml`): they check the rider's session token, the staff member's sign-in or the worker's signature themselves. Supabase provides `SUPABASE_URL` and the service key.

The hosted **test** environment needs no secrets: when `ALLOWED_ORIGINS`, `RIDER_APP_URL` or `WORKER_RING_URL` is unset, the functions fall back to the public test URLs in `supabase/functions/_shared/environment.ts`. **Production must set them explicitly:**

| Secret | Value | Used by |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://confiance-verify.vercel.app,https://confiance-verify-ops.vercel.app` | both: browser origins allowed to call them, matched exactly (no wildcards). Add a preview origin such as `https://confiance-verify-abc123-suivix.vercel.app`, or `http://localhost:5173` for local development, while you need it. |
| `RIDER_APP_URL` | `https://confiance-verify.vercel.app` | `admin`: base of the rider link (`<RIDER_APP_URL>/#s=<token>`) |
| `TEST_SESSION_TTL_MINUTES` | optional, default `30` | `admin`: lifetime of a test session |
| `WORKER_RING_URL` | `https://confiance-verify-worker.vercel.app/api/process` (HTTPS only) | `flow` (M3): the AI worker's doorbell, rung after each photo. Without it, photos wait for the database's sweep (up to a minute). The sweep's own copy of the address is in Vault (`worker_ring_url`), written by the M3 migration. |

The `worker` function needs no secret of its own: the worker's public keys are in the database (`worker_key`), and the private key never leaves Vercel.

When a required secret is missing, the function refuses the requests that need it and logs a warning at startup.

The encryption key for the data read from documents is **not** a function secret: the M2 migration generates it inside the database and keeps it in Supabase Vault (`document_data_key_v1`). Nobody needs to create, copy or see it.

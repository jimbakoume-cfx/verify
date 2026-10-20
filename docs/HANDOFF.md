# Handoff: continuing Confiance Verify after M4

Start here in a new session. Read `docs/PLAN.md` first (the brief, the architecture, the milestones and every PM decision so far), then the spec of the last milestone (`docs/M4_SPEC.md`).

## Where things stand (2026-10-16)
- **Merged in `main`:** M0–M3 (PRs #2, #3, #4).
- **M4:** consistency checks and the first risk flags. It is on branch `claude/zen-mayer-av7qzl`, in PR jimbakoume-cfx/verify#5; CI was green when this note was written.
  - Its migration `m4_consistency` is applied to the test project.
  - The `worker` and `flow` Edge Functions, the AI worker (Vercel) and the two web apps are redeployed with M4, followed by the live checks. See the PR's description for the outcome.
- **Next milestone:** M5 (active liveness). Follow the decisions under "Decisions for the remaining milestones" in `PLAN.md`:
  - **Face model (M7):** research a commercially licensed option and ask the PM before building on it.
  - **Hosting:** stay on Vercel Hobby, for test sessions only.
  - **Product choices:** take the safest default, record it in `PLAN.md` and list it at each milestone's ping.

## Live systems
- **Supabase test project** `vghjssfowrfhpgtghztc` (Paris).
  - Edge Functions: `flow`, `admin` and `worker`, all with `verify_jwt` false and import map `deno.json`.
  - Vault: `document_data_key_v1` and `worker_ring_url`.
  - pg_cron job `worker-sweep`.
  - `worker_settings.enabled_for_real_sessions` is false.
- **Vercel** (team `suivix`):
  - `confiance-verify`: the rider app;
  - `confiance-verify-ops`: the dashboard;
  - `confiance-verify-worker`: the Python AI worker, in `cdg1`, with firewall rules that allow only `POST /api/process`, rate-limited per IP.
- **Worker signing key:** `w1`. The public key is in `worker_key`; the private seed exists only as a sensitive Vercel variable.

## Deploy lessons (read before deploying)
- **Large SQL requests can hang.** The Supabase MCP SQL tools (`apply_migration`, `execute_sql`) hang for 60 s and execute nothing on some request texts: literal `DROP` statements, some long function bodies, large payloads. What worked:
  1. Stage the migration file in parts in a temporary table. Send a part as `convert_from(decode('<base64>','base64'),'UTF8')` when plain text hangs.
  2. Check each part's SHA-256.
  3. In one transaction, check the SHA-256 of the whole text against the repo file, `execute` it, and record it in `supabase_migrations.schema_migrations` byte for byte.
  4. Drop the staging table through a base64-encoded `execute`.
- **Edge Functions:**
  - Deploy the transitive import closure of `<fn>/index.ts` plus `deno.json`, byte for byte.
  - Verify with `get_edge_function`. Supabase leaves out files that are only imported as types, which is harmless.
- **Vercel CLI:**
  - Run it with `NODE_USE_ENV_PROXY=1` and `--scope suivix`.
  - Delete any `.env.local` it creates, before and after each command: it holds an OIDC token.
  - Never put a secret in the repo or in chat.
- **Restarts:** the container restarts now and then. Do long work in short, resumable steps, and run long training with `nohup setsid`.

## Open items for the PM
- **G4 for our own MRZ model** (`/ocr/mrz-2/`, test sessions only): the PM's own document photos.
- **The lawyer's list:**
  - `eng`'s training fonts;
  - Vercel Hobby's terms and its missing DPA;
  - Supabase's EU region;
  - the consent wording.
- **Specimen photos** from consenting volunteers, to tune the provisional checks (list in `M3_SPEC.md`).
- **Q3 (retention period) and Q9 (region and plan)** in `PLAN.md`.
- **M5–M8 and automatic approval are deployed (2026-10-20), PR jimbakoume-cfx/verify#6:** face worker `confiance-verify-face` (key `f1`, firewall set), threshold version 3 active with automatic approval for test sessions only. The face match uses AuraFace and must move to a paid licence, a vendor SDK or our own model before the pilot; its threshold must be tuned on consenting Cameroonian volunteers; lawyer items in `docs/LICENSES.md`. Turn on leaked-password protection in Supabase Auth.
- **Fixes after the PM's first real test (2026-10-20, branch `claude/zen-mayer-av7qzl`)**, `PLAN.md` "Decisions after the first real test". Deploy in this order (test project `vghjssfowrfhpgtghztc`; see "Deploy lessons"):
  1. **Database:** apply `supabase/migrations/20261022000000_real_test_fixes.sql` (no literal removal statement). It adds threshold version 4 and re-assesses the waiting cases (the PM's session among them: expected score 0.5, review, the name a note, liveness the only blocker). Check: `select version, created_by_migration from threshold_config order by version desc limit 1;`.
  2. **Edge Functions:** `face` (liveness-eval-v2, timings, createdAt), `flow` (face warm-up ring at the challenge), `worker` (consistency: the name provisional; tolerant names), `admin` (`risk.ts`: the optional signal; saving a version from the new dashboard needs it). Each: the closure of `<fn>/index.ts` plus `deno.json`.
  3. **Face worker** `confiance-verify-face`: redeploy (parallel fetch, shared frames, model preload); no new variable.
  4. **Web apps:** the rider app (photos then straight to the face check, 3.5 s steps and 14 frames, faster polling) and the dashboard (recommendation first, band as a detail, per-frame measures, the new signal), together with `flow`.
  Then a new test session with your own face: the result should come within about 10 s of the end of the face check, and "Server face checks" shows the measures per frame.

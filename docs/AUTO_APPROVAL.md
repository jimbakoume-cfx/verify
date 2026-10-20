# Automatic approval with a rider result screen

**PM decision (2026-10-20):** "When a user uploads their face and ID, the system tells them if their ID is verified and they move forward." Recorded in `PLAN.md` under "Decisions for automatic approval", with the risks the PM was told.

This is the safest version of that decision. It builds on M8 (`M8_SPEC.md`: score, thresholds, decisions) and M6/M7 (`M6_SPEC.md`, `M7_SPEC.md`: liveness and face match).

## What the system does
- **It approves automatically. It never rejects automatically.** A case that is not approved waits for a person, as before.
- **It approves only when every condition holds.** These are `AUTO_APPROVAL_BLOCKERS` in `risk.ts`, also in `private.risk_evaluate`. The stored assessment lists each one that fails, under `autoApproval.blockers`.
  1. Automatic approval is on in the active threshold version (`autoDecide`).
  2. The session is a test session.
  3. The rules recommend approval: no hard flag, no unknown signal, the document is not one a person always decides, no check is missing or review-only, and the score is at or under the approve cut-off.
  4. The document check is firm, which takes all three of these:
     - the server read the code lines on the newest photo of the side that carries them, with every check digit right (`mrz_server` passed);
     - the code lines classified it as the declared document;
     - the dates were checked from the code lines.

     A passport or a new CNI can qualify. A document without code lines (old CNI, driving licence, voter card) and a residence permit never do.
  5. The document is not expired and the holder is not under 18.
  6. The printed text does not differ from the code lines.
  7. There is no hard flag, no firm signal of any weight (even one switched off), and no unknown signal.
  8. The server's photo check found every photo ok.
  9. The server's liveness check passed.
  10. The face match passed: the similarity is at or above the threshold.
  11. The face match may count (`faceMatchCountsForApproval`).
- **The face match is a threshold setting, not a hard rule.** Since M7, a hard rule made it "review-only". It is now `faceMatchCountsForApproval`, an optional setting of the threshold configuration (missing means false).
  - The migration `20261021000000_auto_approval.sql` adds a version that turns on this setting and `autoDecide`. It starts from the active version's settings, and its reason is "PM decision 2026-10-20: automatic approval".
  - Admins can switch either setting off from **Thresholds** without a redeploy. A new version re-assesses every case waiting for a decision.
- **The system records its approval like a staff decision.** The `decision` row has actor `system` and keeps the threshold version, the recommendation and the score. The review task is closed, and `verification.auto_approved_at` is set.
- **It is audited twice:**
  - `decision.create`, with `automatic: true`;
  - `decision.auto_approve`, with the version, the trigger and the conditions that held (codes only).
- **Staff can still check the case afterwards.** A supervisor, or the reviewer the case was assigned to, can confirm the approval or overturn it, once. Going against the approval needs a note. The audit entry carries `overridesAutomatic`.
- **A migration's re-assessment never approves a case.** The cases already waiting when this migration runs are assessed again, but none is approved by that run.

## What the rider sees
After the submit, the result screen asks `GET /flow/result` at once, then every 2.5 s (`RESULT_POLL_MS`), for at most 75 s (`RESULT_WAIT_MS`).

| State | Screen |
|---|---|
| `pending` | "Vérification de votre pièce d'identité… / Checking your ID…", with a spinner |
| `verified` | "Votre pièce d'identité est vérifiée ✓ / Your ID is verified ✓" and **Continuer / Continue**. The button goes to the session's `return_url` (https only) or, without one, to an end screen. |
| `review` | "Nous vérifions quelques détails, nous vous tiendrons informé. / We're checking a few details, we'll let you know." |
| time-out or error | the same as `review` |

**How the server decides `pending`.** The state is `pending` while an automatic approval can still come:
- the session is a test session;
- the active version has both settings on;
- no blocker that no later check can lift holds already (for example an expired document or a firm signal);
- one of the case's server checks (a photo's or the face worker's) is still running.

**What else the rider app does:**
- **It never shows a refusal, a score or a reason.** The endpoint returns only `{state, returnUrl}`.
- **It copes with slow networks.** It asks again after a network error or a busy server, and abandons a request still running when the time is up.
- **It has a debug override.** With `?debug=1`, `resultWaitMs` and `resultPollMs` change the wait and the poll interval.
- **Where `return_url` comes from.** No route fills `verification.return_url` yet; the sessions API arrives in M10. Until then, test sessions end on the end screen.

## What staff see (dashboard)
- **Case page, "Risk and decision":**
  - "Automatic approval" says either "Approved automatically with threshold version N" or every reason the system did not approve the case.
  - "Counted although uncalibrated: Face match" appears when the face match counted.
  - The system's decision is titled "Approved automatically (version N)", with a form to confirm or overturn it.
- **"Server face checks":** the face match is badged "Counts for automatic approval" instead of "Review only" when it counted.
- **Queue:** a filter "Approved automatically", and a badge with the version on each such case.
- **Thresholds page:** both switches, the NIST warning beside the face match setting, and versions made by a migration named as such.

## Deploy
Order: the migration first, then the Edge Functions, then the web apps. A separate deploy of this branch (M6/M7) may already be running; apply this after it.
1. **Database:** apply `supabase/migrations/20261021000000_auto_approval.sql`. Follow `docs/HANDOFF.md` for large migrations. The text holds no literal removal statement: the one constraint it replaces is removed through `execute`.
   - It adds a threshold version, makes it active, and audits it.
   - It assesses the waiting cases again, without approving any.
   - Check: `select version, created_by_migration, config->'autoDecide', config->'faceMatchCountsForApproval' from threshold_config order by version desc limit 1;`
2. **Edge Functions:**
   - `flow`: new route `GET /result`.
   - `admin`: `risk.ts` now accepts `faceMatchCountsForApproval`; without this, saving a version from the new dashboard fails.
   - `worker` and `face` need not be redeployed for this change: only comments and new types changed in the files they import.
3. **Web apps:** publish the rider app (the result screen) and the dashboard.

To switch automatic approval off at once, an admin opens **Thresholds**, unticks "Approve automatically", gives a reason, and saves.

## The PM test (after deploy, test sessions only)
1. Create a test session. Take a passport or new CNI photo with readable code lines, then do the face check with your own face. Within about a minute: "Votre pièce d'identité est vérifiée ✓", then **Continuer**. On the dashboard the case shows "Approved automatically (version N)".
2. Repeat with a colleague's face at the face check, and with an old CNI. Both end on "Nous vérifions quelques détails…", and the case lists why the system did not approve it.
3. As an admin, untick "Let a passed face match count toward approval" and save. Repeat step 1: the rider now sees "Nous vérifions…".

## Tests
- **Shared vectors** (`risk_vectors.json`, run in TypeScript and SQL): every condition, alone, blocks the approval; a reject recommendation is never eligible; the switch-off; a version stored before the setting existed. Also `autoApprovalConfig` (the migration's version).
- **`90_auto_approval_test.sql`:**
  - the approval and how it is recorded and audited;
  - 14 blocking cases, a real session among them;
  - never an automatic reject;
  - the admin switch-off and switch-on;
  - a migration's re-assessment approves nothing;
  - staff confirm or overturn;
  - `flow_result`: its states, its privileges, https only.
- **Edge Functions:** `flow/handler.test.ts` (`GET /result`), `flow/result.test.ts`, and `admin/decisions.test.ts` (the setting, an override).
- **Rider app:** `flow/result.test.ts` (polling, time-out, slow networks, https only), `flow/machine.result.test.ts`, `flow/api.test.ts`.
- **Dashboard:** `lib/risk.test.ts`, `lib/thresholdForm.test.ts`, `screens/CaseRisk.test.ts`, `screens/CaseFace.test.ts`.
- **End to end** (`e2e/result.spec.ts`, emulated backend):
  - verified, then Continue to the return address;
  - verified in English, then the end screen;
  - review;
  - the time-out.

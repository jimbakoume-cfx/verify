# M8 — Risk score, editable thresholds, approve / reject / review: design spec

Goal (from `PLAN.md`): Phase 1 of the risk score, transparent weighted rules plus hard flags, with the thresholds in a versioned database table that an admin edits from the dashboard without a redeploy. Every decision records the threshold version it used.

The PM's test: change a threshold and see the decision change, with no redeploy (below, "How to change a threshold and see the decision change").

**Words used here:**
- **Signal:** a generic code that adds its weight to the score (`RISK_SIGNALS` in `risk.ts`). Never a value read from a document.
- **Firm vs provisional signal** (as in M3/M4): firm comes from code lines whose check digits are all right, or from an exact fact (the same photo bytes uploaded twice). Provisional comes from printed text, keywords, untuned quality thresholds, or uncalibrated scores. **Only firm signals can make a reject recommendation.**
- **Hard flag:** a signal that sends the case to a person whatever the score.
- **Recommendation:** approve, review or reject, from the rules. **Decision:** what a person (or, when switched on, the system) records.

## Decisions for M8 (safest defaults, 2026-10-19)
Recorded in `PLAN.md` under "Decisions for M8". In short:
1. **Every case still goes to a person.** Automatic decisions exist but are off (`autoDecide: false`). Even switched on, they apply to test sessions only, and never approve a case with a required check missing. Liveness and face match do not exist before M6 and M7, so no case can be approved automatically, or even recommended for approval, before then.
2. **Hard flags mean review.** Mandatory: `document_expired`, `under_18` (M4) and `manual_review_document` (M3). By default also `image_reused` and `unsupported_document`. An admin can add hard flags but cannot remove the mandatory ones.
3. **Provisional signals never reject**, however heavy their weights: a reject needs the firm signals alone to reach the cut-off. `under_18` counts as provisional (it may come from printed text).
4. **Documents always decided by a person** (old CNI, residence permits, driving licence, voter card; PM decisions of M3) are a setting no version can remove.
5. **Missing checks block approval only.** A case missing its server checks, its liveness check or its face match is never recommended for approval; it can still be recommended for reject on firm signals.
6. **Decisions:** supervisors and the assigned reviewer decide; admins do not (they have no routine access to the photos or the data read). A reject needs a rider reason (`reason_code`). A note is required to go against the recommendation, to approve a case with a hard flag, or to decide a case without an assessment. The note is staff-only and never goes into the audit log.
7. **Thresholds:** admins only, through the audited admin function. Versions are append-only; each records who and why; the active version is the highest one. A new version re-assesses every case waiting for a decision at once.
8. **Unknown signals** (a reason a later worker adds before the rules know it) send the case to a person.
9. **A failed assessment never blocks the pipeline:** the case's stored assessment is cleared (shown as "not assessed") and the failure audited (`risk.assess_failed`); staff decide every case anyway.
10. **No duplicate detection across riders (Q4) and no speed target (Q1) yet:** both are PM questions. `image_reused` is the M1 signal (same photo bytes in another verification), nothing more.

## The rules (`supabase/functions/_shared/risk.ts`, `private.risk_evaluate`)
Computed in whole basis points (no floating-point sums), so the same facts and version always give the same result.

```
score     = min(1, sum of the weights of the enabled signals present)
firmScore = the same over the firm signals only
band      = approve if score <= approveMax, reject if score >= rejectMin, else review
recommendation:
  review   if a hard flag or an unknown signal is present, or the document is always reviewed
  reject   else if firmScore >= rejectMin
  approve  else if score <= approveMax and no required check is missing
  review   otherwise
```
The stored assessment (`verification.risk_reasons`, `RiskAssessment`) lists every condition that holds (`RISK_REASONS`: `hard_flag`, `unknown_signal`, `always_review_document`, `firm_score_high`, `provisional_signals`, `score_between`, `score_low`, `missing_checks`), every signal present with its weight and whether it counted, was firm or hard, the missing checks, and the rider reason a reject would use (`rejectReasonCode`, from the first firm signal: `SIGNAL_REJECT_CODES`).

**Signals and default weights (version 2):**

| Signal | Source | Firm | Weight | Hard |
|---|---|---|---|---|
| `document_expired` | consistency (M4) | yes | 1 | mandatory |
| `under_18` | consistency (M4) | no | 1 | mandatory |
| `image_reused` | same SHA-256 in another verification (M1) | yes | 0.6 | yes |
| `unsupported_document` | foreign ID card from the code lines (M3) | yes | 0.5 | yes |
| `mrz_disagreement` | phone vs server code lines (M3) | yes | 0.5 | |
| `mrz_invalid_server` | server code lines fail a check (M3) | yes | 0.5 | |
| `mrz_print_mismatch` | print vs code lines (M4) | yes | 0.5 | |
| `type_mismatch` | code lines show another document (M3) | yes | 0.3 | |
| `date_logic` | consistency (M4) | yes | 0.4 | |
| `number_format` | consistency (M4, confirmed formats only) | yes | 0.2 | |
| `manual_review_document` | always-reviewed document (M3) | no | 0 | mandatory |
| `unrecognised_document` | M3 | no | 0.3 | |
| `mrz_unreadable_server` | M3 | no | 0.2 | |
| `mrz_phone_flag` | the phone's MRZ report flagged (M2) | no | 0.1 | |
| `phone_report_missing` | M3 | no | 0.1 | |
| `provisional_classification` | M3 | no | 0.1 | |
| `quality_poor` | server photo verdict not ok (M3) | no | 0.1 | |
| `liveness_flag` | placeholder: a `liveness` check that did not pass (M6) | no | 0.5 | |
| `face_match_flag` | placeholder: a `face_match` check that did not pass (M7) | no | 0.5 | |

Cut-offs: `approveMax` 0.15, `rejectMin` 0.9. Required checks (not configurable): `server_checks` (each side the document needs has a server result, and no `server_unchecked`), `liveness`, `face_match` (a `check_result` of that name, until M6/M7 write one).

## The database (`supabase/migrations/20261019000000_m8_decisions.sql`)
No table removed, no function replaced, no `DROP`.
- **`threshold_config`**: append-only (update, delete and truncate refused by triggers, for every role); each inserted version must follow the latest without a gap and pass `private.risk_config_errors` (the same rules as `thresholdConfigErrors`); a version after 2 names its author; every version after 1 has a reason (5–500 characters). The dashboard's roles may only read. Version 2 is `DEFAULT_THRESHOLD_CONFIG`.
- **`verification`**: `risk_recommendation`, `risk_reasons` (the assessment), `risk_assessed_at`; `risk_score` and `threshold_config_version` (M0) are now filled.
- **`decision`**: `recommendation`, `risk_band`, `risk_score`, `agrees_with_recommendation` (null when the recommendation was review), with `threshold_config_version` (M0).
- **When a case is assessed:** deferred triggers, which run as the writing transaction commits: when the verification becomes `submitted`, and whenever a `check_result` of a submitted, undecided case is written or removed (late worker results, the phone's report, the sweep giving up). Each change of the stored assessment is audited (`risk.assess`, with the version, score, recommendation, band and trigger). Open and decided cases are never re-assessed: a decision keeps what it was shown.
- **`public.staff_decide`** (service role): re-checks the access rule (active reviewer or supervisor matching the profile; a reviewer only on an assigned case), the rider reason and the note rule, then records the decision, closes the review task, sets the case `approved` or `rejected`, and audits `decision.create` (never the note).
- **`public.staff_create_threshold_version`** (service role): active admins only; refuses a stale base version, an invalid configuration, a missing reason and an unchanged configuration; inserts the version, audits `threshold_config.create` with the paths that changed (never the note), and re-assesses every submitted, undecided case in the same transaction.
- **Automatic decisions** (`autoDecide`): `private.risk_refresh` records a system decision only for a test session whose recommendation is reject, or approve with no required check missing.
- **Lock order:** the verification row is locked `FOR NO KEY UPDATE` after any case lock (M3), so a concurrent photo upload (whose foreign key takes `KEY SHARE`) never deadlocks with an assessment.

## Edge Functions (`admin`)
- `POST /admin/decisions` `{verificationId, outcome: approve|reject, reasonCode, note}` → `{decisionId, status, recommendation, agreesWithRecommendation, thresholdVersion}`. Supervisors and the assigned reviewer; admins 403 `forbidden_role`; another reviewer 404. Errors: 409 `already_decided`, 409 `not_submitted`, 422 `note_required`, 422 `invalid_reason`, 400 for a malformed body (note over 1,000 characters, control characters).
- `POST /admin/thresholds` `{baseVersion, config, note}` → `{version, rescored}`. Admins only. The configuration is checked with `thresholdConfigErrors` before the database checks it again; 409 `stale_version` when someone saved a version meanwhile; 400 for an invalid configuration, a missing reason or no change.
- Contract: `contract.ts` "Decisions and thresholds", and five error codes.

## The dashboard (`apps/dashboard`)
- **Case page → "Risk and decision" / "Risque et décision"** (`screens/CaseRisk.tsx`): the recommendation badge, the score, the firm score, the band (with a bar showing both cut-offs), the threshold version and time, every reason that holds, a table of the signals (weight, firm or provisional, hard flag in red, switched off), the missing checks, and the rider reason a reject would use. Under it, the decision: the form (approve or reject; for a reject the rider reasons, the recommended one chosen; a note marked required when it is) or the recorded decision (by whom, when, the recommendation and version shown, agreement, reason, note). Admins see why they cannot decide.
- **Queue (home) → sort "By recommendation"**: cases waiting for a decision first, reject, review (highest score first), approve, then not assessed; the recommendation and score on each waiting row.
- **Thresholds page (`/thresholds`, admins; "Thresholds" in the top bar)** (`screens/Thresholds.tsx`): the active version (who, when, why, cut-offs, automatic decisions), the form for the next version (weights, counts, hard flags with the mandatory ones locked, always-reviewed documents, automatic decisions, the reason), checked as you type with the server's own rules, with "Changes from version N" listed before saving; then every version with what it changed. A French "0,5" is accepted.
- Dev previews: `case-reject`, `case-decided`, `thresholds`, `thresholds-edit`.

## Tests
- **Shared vectors** (`supabase/tests/risk_vectors.json`): 22 assessments and 17 configurations, run by `risk.test.ts` (TypeScript) and by `70_m8_test.sql` (`private.risk_evaluate`, `private.risk_config_errors`); both must give exactly the same results. The file also pins the signal list and version 2. `scripts/test-db.sh` passes `repo_root` to psql so the SQL test can read it.
- **`70_m8_test.sql`:** RLS (nobody writes `threshold_config`, admins included; anon reads nothing; the dashboard roles cannot call the RPCs; a reviewer sees no decision of another's case); append-only, gap-free, valid, authored versions; only an active admin creates one (stale, invalid, no reason, unchanged refused); assessment at submit, after a late check, never for open or decided cases, and no audit entry when nothing changes (determinism); the PM's test (version 3 turns A's review into reject); decisions (roles, reasons, notes, agreement, closing, audit without the note); automatic decisions (test session rejected by the system; real session and missing liveness untouched); no failed assessment during the M1–M4 tests.
- **`risk.test.ts`:** the vectors, the defaults, firm signals, determinism, never an approval with a check missing, never a reject from provisional signals, the diff.
- **`admin/decisions.test.ts`:** both routes with fakes that follow the SQL functions: access, validation, every answer mapped, no note in logs; the parsers of the database's answers.
- **Dashboard:** `lib/risk.test.ts` (parsers, queue sort, note rule, versions), `lib/thresholdForm.test.ts`, `screens/CaseRisk.test.ts` (the section, the decision form and record, the editor, history and changes, rendered on the server side, FR and EN), the locale coverage.

## How to change a threshold and see the decision change (the PM test, after deploy)
Use test sessions only.
1. As a supervisor, create a test session and photograph `e2e/fixtures/specimens/passport-mismatch.jpg` (printed at 100%) as a passport; submit.
2. Open the case: "Risk and decision" shows **Recommend: review**, score 0.5 ("Printed text differs from the code lines", firm, +0.5), band review, "Version 2", and the missing checks (liveness, face match).
3. As an admin, open **Thresholds** in the top bar. Set **Reject cut-off** to `0,5` (or `0.5`), give a reason ("PM test: lower the reject cut-off"), check that "Changes from version 2" says "Reject cut-off: 0.9 → 0.5", and press **Make version 3 active**. The page says how many waiting cases were assessed again.
4. Reload the supervisor's case: it now shows **Recommend: reject**, "Version 3", "Firm signals reach the reject cut-off" and the rider reason `DOC_INVALID`. Nothing was redeployed; the audit log has `threshold_config.create` and a `risk.assess` with trigger `thresholds`.
5. Decide it (for example approve, with a note): the decision records version 3, the recommendation reject and "Went against the recommendation".
6. As an admin, create version 4 with the reject cut-off back at 0.9 (the reason: "Back to the defaults"). History lists all versions with their changes.

## Deploy notes
1. Apply the migration (it seeds version 2 and assesses the cases already submitted).
2. Deploy the `admin` Edge Function (the `flow` and `worker` functions are unchanged; the database assesses on its own).
3. Publish the dashboard.

Order: the migration first. The old dashboard ignores the new columns; the old admin function has no new routes.

## Known limits
- Weights and cut-offs are first guesses, to calibrate in M12 against staff decisions (`agrees_with_recommendation`, `risk_band`, `risk_score`).
- The placeholders count any `liveness` or `face_match` check of the case, newest first; M6/M7 will say which result counts.
- The server checks run on test sessions only until the worker's switch is on: real sessions miss `server_checks`, so they are always review.
- The queue sort works on the 20 most recent cases (the queue proper arrives in M9).
- Assignment of reviewers is still by SQL until M9.

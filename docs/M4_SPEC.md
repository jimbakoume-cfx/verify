# M4 — Consistency checks and first risk flags: design spec

Goal (from `PLAN.md`): the server compares what a document says with itself and with today's date. An expired document is caught at once, a rider under 18 is flagged for staff, and printed data that disagrees with the code lines (MRZ) is flagged. M4 also ships our own MRZ reading model, for test sessions only.

The PM's test: try an expired ID, and a test card whose printed data does not match its code lines.

**Words used here:**
- **Firm vs provisional** (as in M3): firm comes from code lines whose check digits are all right; provisional comes from printed text read by the worker, whose formats are not yet checked on real cards. Provisional results are shown as such and never decide on their own.
- **Flag:** a generic code that sends the case to a person (it joins the `document_policy` reasons). **Hard flag:** a flag that can never be auto-approved once automatic decisions exist (M8): `document_expired` and `under_18`. The dashboard shows them apart.
- **Today:** the date in Douala (`Africa/Douala`, UTC+1, no daylight saving time).

The HTTP contract stays in `supabase/functions/_shared/contract.ts`.

## Decisions taken by the PM (2026-10-15)
1. **Expired document.** The server reads the expiry date from the code lines, or else from the printed expiry date (provisional). When the code lines say so (every check digit right), the rider is told at once on "Checking your photos…" to use another, valid document, with **"Use another document"** (back to the document list) and **"Continue anyway"**. Continuing leaves the hard flag `document_expired` for staff. A printed-only expiry is a provisional staff flag: the rider is told nothing.
2. **Under 18** (birth date from the code lines, else printed): hard flag `under_18`, staff review, never auto-approved. The rider sees nothing special.
3. **Printed fields vs code lines:** a tolerant comparison (below). A real disagreement is the flag `mrz_print_mismatch`, with the kinds of field that disagree (`name`, `number`, `birth_date`, `expiry_date`). Never a rider message.
4. **Date logic and number formats:** birth before issue before expiry, issue not in the future, expiry at most 15 years after issue → `date_logic`. Number formats per document type are provisional guesses → `number_format`, recorded as provisional only.
5. **Our own MRZ model (run 2) for test sessions only**, under `/ocr/mrz-2/`. Doubango stays for real sessions until G4 (the PM's photos) passes.

## What the rider sees
After the photos are sent, "Checking your photos…" works as in M3, plus one new answer of `GET /flow/checks`:

- `expired: true` when the newest photo of the side carrying the code lines has been checked, and its code lines (every check digit right) give an expiry date before today.
- The screen then stops waiting and shows, in place of the status line, **"Ce document a expiré" / "This document has expired"**, "Utilisez une autre pièce d'identité, en cours de validité. / Please use another, valid ID document.", and two buttons:
  - **"Utiliser une autre pièce" / "Use another document"**: back to the document list. Every photo of this attempt is forgotten on the phone; whatever is chosen next (even the same type) starts with new photos, which replace the old ones on the server.
  - **"Continuer quand même" / "Continue anyway"**: the wait goes on as before (a retake may still be asked), then the case is submitted. Staff see `document_expired`.
- The expiry message comes before any retake: there is no point retaking a photo of an expired document.

Nothing else changes for the rider: under 18, mismatches, date logic and number formats are for staff only.

## How consistency is decided
A new case-level check, **`consistency`** (`check_result`, `capture_id` null, one per case), decided by the `worker` Edge Function with the classification, from the newest live photo of each side **the declared document needs** (a photo of a side left over from an earlier document choice no longer counts, for any case-level check).

**Inputs.**
- Code lines: the server's own reading (`mrz_server`) on the side that carries them. Firm only when every check digit is right and both dates are real; otherwise they are not used at all.
- Printed fields (`ocr_server`): front first, then back for what the front lacks. Since M4 the worker also reads the number and the birth and expiry dates on documents with code lines (it read only names and the issue date before), so that they can be compared.

**Where the values come from, and where they go.** The Edge Function decides from the worker's result in the request (the photo just read) plus the stored values of the case's other photos. The database decrypts those inside `worker_case_snapshot` (SECURITY DEFINER, service role only) and returns them with the snapshot, in the same statement: only the server's code lines and the printed fields, never the card sub-type, and only for the newest live photos. Nothing else changes: the values never reach `check_result`, `audit_event`, `worker_job.evidence` or any log. The check stores generic codes only:

```
details = { flags: [...], provisional: [...], basis: "mrz" | "printed" | "none", mismatches: [...] }
```

The database refuses any other key, and any code outside the contract's lists (`CONSISTENCY_DETAIL_KEYS`, `CONSISTENCY_FLAGS`, `MISMATCH_KINDS`).

**The rules** (`supabase/functions/worker/consistency.ts`, pure, tested with tables; thresholds are named constants):

| Code | Firm (`flags`) | Provisional (`provisional`) |
|---|---|---|
| `document_expired` | expiry from the code lines is before today | printed expiry is before today, with no firm code lines |
| `under_18` | birth date from the code lines, under 18 today | **also a flag** (PM decision 2), from the printed birth date; `basis` says so |
| `mrz_print_mismatch` | a printed field disagrees with the firm code lines (`mismatches` names the kinds) | — |
| `date_logic` | birth not before expiry, both from the code lines | any rule involving a printed date: birth before issue, issue before expiry, issue not after today, birth not after today, expiry at most `MAX_VALIDITY_YEARS` (15) after issue |
| `number_format` | only for a format marked confirmed (none yet) | the number (firm code lines first, else printed) does not fit the guessed format of the declared document |

**The tolerant comparison** (`compare.ts`): a field missing on either side, or a date that cannot be read, is not compared (never a mismatch).
- **Names:** accents dropped (also Ä→AE, Ö→OE, Ü→UE as ICAO transliterates them), case, spaces, hyphens, apostrophes and the filler `<` ignored; digits read for look-alike letters (0/O, 1/I, 5/S, 8/B, 2/Z). When the code lines' name field is full (truncated), one name may start with the other. Surname and given names are compared on their own, then together.
- **Numbers:** spaces, hyphens, dots, slashes and fillers ignored; look-alikes 0/O, 1/I, 5/S, 8/B, 2/Z made equal.
- **Dates:** compared as dates. ISO (as the worker sends them), `DD.MM.YYYY`, `DD/MM/YY`, `DD-MM-YYYY`, `DD MM YYYY`, `05 MAR 1991` and French or English month names. A numeric date that also reads month-first agrees if either reading does.

**Outcome:** `flag` when `flags` is not empty; `skipped` when there was nothing to compare (`basis: none`); otherwise `pass` (provisional codes are shown, but do not flag).

**`document_policy`** gains the codes of `flags` as reasons. `POLICY_REASONS` lists the hard ones first.

## Edge Functions
- **worker:** decides `consistency` with the classification after each result (`case.ts` `decideCaseChecks`, rules in `consistency.ts` and `compare.ts`), from the request's values for the photo just read and the snapshot's for the others. Its flags join the reasons it sends.
- **flow:** `GET /flow/checks` reads the case's consistency flags (generic codes) to answer `expired`. `POST /flow/document-type` decides the case's server checks again when the document changes, so a flag from the previous document does not linger. As before, after a replaced photo.
- **Contract:** `SERVER_CHECK_NAMES.consistency`, `CONSISTENCY_FLAGS`, `HARD_FLAGS`, `MISMATCH_KINDS`, `ConsistencyDetails`, `CONSISTENCY_DETAIL_KEYS`, `CONSISTENCY_TIME_ZONE`, `FlowChecks.expired`, and the five codes added to `POLICY_REASONS` (hard flags first).

## The rider app (`apps/rider`)
- `GET /flow/checks` gives `expired`. The reducer's new actions: `checks/expired`, `expired/another`, `expired/continue`. An answer without `expired` (a server not yet updated) counts as `false`.
- **MRZ model:** test sessions read with **`mrz-2`** (`/ocr/mrz-2/`, cache `ocr-mrz-2`, engine `tesseract.js-7.0.0/mrz-2`), every other session with Doubango's `mrz-1`. `GET /flow/session` already says `isTest`. The engine label goes into each MRZ report (`MrzCheckDetails.engine`, shown on the dashboard) and into the debug panel ("Model").
- Dev preview: `checking-expired`.

## The dashboard (`apps/dashboard`)
- **Server checks → "Consistency" / "Cohérence"** (`lib/consistency.ts`): what it is based on (code lines, printed text, nothing), each flag with its explanation, **hard flags in red with a "Hard flag" / "Signal bloquant" badge**, the provisional codes under a Provisional badge, and the kinds of field that disagree. Codes only, never a value.
- **"For a person to decide"** lists the new reasons; the hard ones first, in red.
- Dev previews: `case-expired`, `case-mismatch-print`.

## The database (`supabase/migrations/20261017000000_m4_consistency.sql`)
No new table or column, and no `DROP`:
- `private.worker_case_document_data(uuid)`: decrypts the newest live photos' `mrz_server` lines and `ocr_server` fields (without the sub-type); fails loudly when a row's key is missing from Vault.
- `public.worker_case_snapshot` (same signature) adds them as `documentData`. The fingerprint is unchanged (they change only when the evidence does).
- `private.worker_apply_case` also writes or deletes `consistency`, refusing unknown keys and codes.

## The AI worker (`worker/`)
Reads the document number and the birth and expiry dates on documents with code lines too, and knows the passport number's labels ("N° de passeport", "Passport No"). Build label `worker-2`.

## Our MRZ model (`training/mrz/`)
Run 1 (from zero) failed G1 (clean CER above Doubango's) and G2 (3 wrong-but-valid reads of its own). Run 2 (fine-tuned from Google's `tessdata_best` `eng`) passed every automated gate; reports in `training/mrz/results/`. G4 (the PM's own photos) is still to do, so the model ships for **test sessions only**. Its provenance (Apache-2.0 weights trained on about 4,500 mostly commercial fonts) is on the lawyer's list (`LICENSES.md`).

## Tests
- `compare.test.ts` (names, numbers, dates, many cases) and `consistency.test.ts` (every rule, firm and provisional, Douala's date at midnight).
- `decide.test.ts` / `handler.test.ts`: the payload, reasons from flags, the stale sides of an earlier document, the overlay of the photo just read.
- `flow`: `expired` only when the code-lines side is checked; the refresh after a new document choice.
- `supabase/tests/50_m4_test.sql`: the snapshot's decrypted data (newest live photos only, no sub-type, service role only), the consistency row (written, deleted, refused keys and codes), its flags as reasons, nothing personal in `check_result` or `audit_event`.
- Rider: the reducer and the model choice; dashboard: the parser and the section's rendering (server-side React).
- Worker: the widened fields, and two new specimens, `passport-expired.jpg` and `passport-mismatch.jpg`, read by the real OCR and judged by the server's own consistency code (Deno).
- Browser: `server-checks-expired.spec.ts` (both buttons); the model follows the session (`capture-cni-biometric.spec.ts`), and the debug panel names it (`capture-passport.spec.ts`).

## The PM test (after deploy)
Use test sessions only.
1. **Expired document:** your own expired passport or card, if you have one; otherwise print `e2e/fixtures/specimens/passport-expired.jpg` at 100% and photograph it as a passport. Expect "This document has expired". Try both buttons: "Use another document" back to the list, "Continue anyway" to the end. The dashboard shows `document_expired` in red under "For a person to decide" and in "Consistency".
2. **Printed data vs code lines:** print `passport-mismatch.jpg` and photograph it as a passport. The rider sees nothing; the dashboard shows `mrz_print_mismatch` with "Name".
3. **Your own valid documents:** "Consistency" passes (or shows provisional notes only). Report any false flag, naming the field kind, never its value.
4. **The new model:** the debug panel shows "Model: tesseract.js-7.0.0/mrz-2" on test sessions; report any document whose code lines read worse than before.

## Deploy notes
1. Apply the migration.
2. Deploy the `worker` and `flow` Edge Functions (both decide case checks; `flow` also answers `expired`).
3. Deploy the AI worker on Vercel (it reads more fields).
4. Publish the rider app (expired screen, `mrz-2`) and the dashboard.

Order: the migration first. The old functions keep working against it (a case payload without `consistency` simply has none); the new rider copes with a server that does not send `expired`.

## Known limits
- Consistency runs where the worker runs: test sessions only, until the switch is on.
- Printed formats (dates, numbers, labels) are tuned on our renders only; every result that depends on them is provisional.
- A forged document with consistent code lines and print still passes: consistency is no proof of authenticity.
- `number_format` guesses: old CNI 9 digits, new CNI 9 letters or digits, residence permits 6–12. To confirm with real cards (Q7).

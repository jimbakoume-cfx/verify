# M7 — Face match between the selfie and the ID portrait: design spec

Goal (from `PLAN.md`): compare the best frame of the face check (M5) with the portrait on the identity document, and give staff a similarity score.

The PM's test: your selfie against your ID matches; a colleague's does not.

M7 runs on the face worker built for M6 (`M6_SPEC.md`: architecture, protocol, database, deploy). This spec adds what is specific to the face match.

## Decisions taken by the PM (2026-10-19)
1. **Model: AuraFace v1** (fal.ai), **only its retrained `glintr100.onnx`**, Apache-2.0, **test sessions only**. Its SHA-256 must not be InsightFace's antelopev2 file's, and **the other four files of the repository are never shipped** (they are byte for byte InsightFace's non-commercial files).
2. **Face detection and alignment with MediaPipe** (not YuNet, not SCRFD).
3. **Compare the best selfie frame with the ID portrait** cropped from the document front photo (the passport's data page).
4. **Result:** a `check_result` named exactly `face_match`, with the similarity score and an outcome.
5. **The threshold is a named constant, marked "uncalibrated — must be set on Cameroonian impostor pairs** (NIST shows ~14x higher false-match rate for West Africans at fixed thresholds)", and **every face_match result on any case is review-only**: M8 never auto-approves on the face match until it is calibrated (a flag in `threshold_config` or a hard rule, the safest one chosen and recorded).
6. **Before the pilot: switch to a paid licence, a vendor SDK or our own model.** AuraFace is for test sessions only.

## Decisions taken while building (safest defaults, for the PM's review)
1. **Review-only is a hard rule, not a threshold setting.** `private.face_match_review_only()` returns true; while it does, a case with a `face_match` result lists it under `reviewOnly` and is **never recommended for approval** (reason `review_only_check`), so it is never approved automatically either (automatic approval needs an approve recommendation). No admin can switch it off from the dashboard: changing it takes a migration, with the calibration report. A face match can never reject either: `face_match_flag` is provisional.
   - Consequence: **no case can be recommended for approval at all** while the face match is required and review-only. That is intended (Phase 1: a person decides every case).
2. **The face match never runs on a real session**, whatever the face switch: the database creates its job already failed (`ineligible`), `face_claim` refuses it, and the worker refuses a claim that says otherwise.
3. **Outcome:** `pass` at or above the threshold with nothing doubtful; `fail` under a low threshold (clearly different); `flag` for everything else (between the two, no face to compare, a tiny portrait, an alignment without the mesh, a turned selfie).
4. **No crop is stored.** The details give each face's box (fractions of its photo); the dashboard shows the two faces side by side by scaling and shifting the whole photos, each opened through the audited viewer. Nothing extra is kept beyond normal retention.
5. **No embedding ever leaves the worker** (a biometric template; PLAN.md Q4: no face templates are stored).
6. **The best frame is chosen by the worker:** exactly one face, the most frontal, eyes open, largest. The rider app is unchanged.

## How the comparison works (`worker-face/verify_face/facematch.py`)
1. **The portrait:** BlazeFace runs on the whole document photo and on half-overlapping square windows of it (100%, 75%, 50% and 35% of the short side): a card photographed at 1,280 px shows a face about 100 px wide, too small for the short-range detector on the whole picture. The largest confident face is the portrait; a smaller one (the "ghost" portrait of the new cards and passports) is only counted.
2. **The selfie:** every frame of the face check is analysed; the best one is kept.
3. **Alignment:** the 5 points of the ArcFace template (eye centres, nose tip, mouth corners) from the face mesh, or from the detector's keypoints when the mesh does not take on a small portrait (`method: "detector"`, a problem code), then a similarity transform to 112 x 112.
4. **Embedding:** AuraFace's `glintr100.onnx` on ONNX Runtime (RGB, (x − 127.5) / 127.5), 512 numbers, L2-normalised; the **similarity** is their cosine (−1 to 1).

The evidence sent (`FaceMatchEvidence`): whether each face was found, how many faces the document shows, each box, the eyes' distance in pixels, the alignment method, the detection score, the selfie frame used and its pose, the similarity.

## What the Edge Function decides (`face/decide.ts`, check `face_match`, version `face-match-v1`)
| Constant | Value | Note |
|---|---|---|
| `FACE_MATCH_THRESHOLD` | **0.35** | **UNCALIBRATED — must be set on Cameroonian impostor pairs (NIST shows ~14x higher false-match rate for West Africans at fixed thresholds).** A common starting point for ArcFace-type models on web photos, nothing more. |
| `FACE_MATCH_LOW_THRESHOLD` | 0.15 | under it: `fail` (uncalibrated likewise) |
| `FACE_MATCH_MIN_PORTRAIT_EYES` | 24 px | a smaller portrait: `portrait_small` |
| `SELFIE_MAX_YAW`, `SELFIE_MAX_PITCH` | 20° | beyond: `selfie_not_frontal` |
| `FACE_MATCH_MODEL` | `auraface-v1/glintr100` | stored with every result |

**Details** (`FaceMatchDetails`; the database refuses any other key, and refuses `calibrated` other than `false` and `reviewOnly` other than `true`): model, engine, similarity, threshold, low threshold, `calibrated: false`, `reviewOnly: true`, problem codes, `portrait: {captureId, box}` (the job's document front), `selfie: {captureId, box}` (a frame of the job), timing. `score` = the similarity.

## Calibration (before the threshold may mean anything)
From `docs/research/FACE_MODELS.md` §6: 50–100 consented volunteers, their own documents and face checks. Genuine pairs: each volunteer's portrait against their own frames. **Impostor pairs: same sex, same age band, Cameroonians**, because that is where false matches rise (NIST FRTE 1:1: the median false-match rate for West Africans is 13.8 times the Eastern Europeans' at a fixed threshold). Report FNMR and FMR by skin tone (Monk scale), sex, age and phone. Proposed bar for any automation: FMR ≤ 1e-3 in every group at the chosen threshold, with a West Africa / overall ratio ≤ 2. Then a migration may change `private.face_match_review_only()`, with the PM's decision recorded in `PLAN.md`.

## The dashboard
In "Server face checks", **Face match: ID portrait and face check**: the outcome, an **Uncalibrated** badge, a **Review only** badge, a warning ("The threshold is a first guess… This score never approves a case: compare the faces yourself."), the similarity, the threshold (and the low one), the model, the time, the problems; then **Show the portrait and the frame (2 views)**: the ID portrait and the best frame side by side, only the faces visible, for 60 seconds, each view audited (`capture.view`), supervisors and the assigned reviewer only, never admins. The risk section lists "Review only: never helps approve — Face match (uncalibrated threshold)".

## Licences and the lawyer (`docs/LICENSES.md`)
- **AuraFace `glintr100.onnx`:** Apache-2.0 on the weights, **amber**: trained on "a commercial dataset comprising face images from various sources", not named. Its repository relabels InsightFace's non-commercial files as Apache-2.0 (verified by SHA-256), which lowers our trust in the claim. **Lawyer items:** ask fal.ai in writing for the dataset's name, licence and consent basis (and a warranty); whether an Apache label on weights cures claims from the training data or the people photographed (GDPR-style biometric rules, BIPA-type claims, Cameroon Law 2024-017); biometric processing of riders' faces (consent wording, DPIA, retention).
- Pinned: `https://huggingface.co/fal/AuraFace-v1/resolve/af6d057c9b0ec4071d4c49c80e3539258798b609/glintr100.onnx`, 260,694,151 bytes, SHA-256 `a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60` (InsightFace antelopev2's `glintr100.onnx` is `4ab1d643…534cdf`: different, so retrained as claimed). The four InsightFace files' hashes are refused by the fetch script and the loader (`FORBIDDEN_SHA256`).
- **Before the pilot (PM decision):** one of (a) a commercial licence from InsightFace (`buffalo_l`, measured by NIST; price unknown), (b) an on-premise vendor SDK with good West-Africa numbers in NIST FRTE (Paravision, ROC, IDEMIA; bends "no KYC vendors" but keeps every image in-house), (c) our own model (pre-trained on a commercially licensed set, fine-tuned on consented riders; about 2 months once data exists). Get quotes for (a) and (b), and add training consent (c) to the volunteer form. `FACE_MATCH_MODEL` and `model_id` in each result keep the model replaceable.

## Tests
- `face/decide.test.ts`: every outcome and problem, the constants and the fixed `calibrated`/`reviewOnly`, the details' keys, never an embedding.
- `face/handler.test.ts`: a face match recorded with its document and a frame of the job; a selfie that is not one of the job's frames refused.
- `80_m6_m7_test.sql`: the face match test-only (switch or not), details refused with `calibrated: true`, `reviewOnly: false`, an embedding, another document, a selfie from elsewhere; **M8: a clean test case with liveness and face match passed is recommended for review (`review_only_check`), and with automatic decisions on it is not approved**.
- `risk_vectors.json` (TypeScript and SQL): review-only never approves, never stops a firm reject, lists in order.
- Python, with the models: the drawn face pasted on a SPECIMEN passport is found inside the portrait box, aligned with the mesh, the best frame is frontal; the same drawn person scores higher than another (0.925 against 0.782: drawn faces look alike to the model, which says nothing about real faces); a blank document gives no comparison. End to end through the real Edge Function: recorded, uncalibrated, review-only.
- **Measured** (development machine, one thread; reported, never asserted): a face match about **1.1 s of CPU** warm (two embeddings of about 0.25 s each, the landmarks on 13 frames and the document windows); **3-5 s** cold (AuraFace read, hashed and loaded: about 1.1 s to load, 0.6 s to hash, peak memory about 550 MiB).

## The PM test (after deploy)
Test sessions only. Your own face and documents, and a colleague who agrees.
1. **You:** a test session with your own document and your own face. On the dashboard, "Face match": a similarity well above the threshold (expect **Passed**, with **Uncalibrated** and **Review only**). Press **Show the portrait and the frame**: your ID portrait and your face check side by side.
2. **A colleague:** a new test session with **your** document and **the colleague's** face at the face check. Expect a low similarity (**Failed** or **To check**).
3. Note both similarities and send them with the phone model and the light (no screenshot of the photos). These are the first real numbers; they set nothing yet.
4. The risk section of both cases says **Recommend: review**, with "Review-only check".

## Known limits
- **Uncalibrated:** 0.35 means nothing until measured on Cameroonian pairs. A person compares the faces on every case.
- **A small, old, laminated portrait** against a phone selfie is harder than the web photos the model was trained on; the portrait search is tuned on our drawn SPECIMEN documents only.
- **Drawn faces look alike to the model**; real accuracy is unknown until the volunteer set exists.
- **Test sessions only** (licence); real sessions miss `face_match`, so they are never recommended for approval anyway.
- **One document front per case:** a second ID document's portrait (e.g. a driving licence beside a CNI) is not compared.

# Our own screen and print detectors (M6): data collection notes and training stub

**Status (2026-10-19): nothing is trained.** We have no attack photos. Until we do, the face worker
ships three hand-made, **provisional** passive cues (`worker-face/verify_face/spoof.py`: moiré, screen
glare, low detail), with cut-offs set on drawn faces and simulated attacks only
(`supabase/functions/face/decide.ts`). They can only flag a case for a person, never fail it.
Silent-Face-Anti-Spoofing (amber: undisclosed training data) is **not** shipped; the PM allowed it as a
low-weight, test-only signal, but it needs a PyTorch-to-ONNX export of a 2020 model for little gain over
these cues. It can be added later as one more provisional measure if the data below shows it helps.

The research (`docs/research/FACE_MODELS.md`, section 4) is clear that no open passive anti-spoofing
model is commercially clean: the green route is **our own detectors, trained on our own consented
attack captures**. This folder is where that happens.

## What to collect

Follow the plan's test-image rules (`docs/PLAN.md`, section 5): the lawyer's volunteer consent form,
volunteers' own faces and documents only, never anyone else's.

| Kind (`label`) | How | At least |
|---|---|---|
| `bonafide` | The real face check, done normally, in the rider app (test sessions) | 50 people |
| `print` | A colour print (and a black-and-white one) of the volunteer's own selfie, held to the front camera, flat, then bent and tilted while following the challenge | 20 people |
| `screen` | The volunteer's own selfie shown on a phone, a tablet and a laptop screen, held to the camera; brightness high and low | 20 people |
| `replay` | A video of the volunteer doing a face check, replayed on a screen | 20 people |
| `mask` | Optional: a paper mask with eye holes | — |

For each: 2-3 phones from what riders use (Tecno, Itel, Samsung A series), good and dim light, indoor
and outdoor. **Skin tones across the Monk scale, with most volunteers at 7-10** (our riders): a detector
that is only measured on light skin is not measured. The frames are the app's own 13 frames per face
check, so what is trained is what the server sees.

## Where the images come from, and consent

- Volunteers: the test project, test sessions, under the volunteer form (`consent` = `volunteer-form-v<n>:<pseudonym>`).
- Riders: **only** those who ticked "keep my face images to improve and tune Confiance's checks"
  (M5, `consent_record.keep_face_images`); `private.face_training_cases()` lists them (administrators,
  SQL editor). A rider who did not tick it, or whose latest answer is no, is never exported, and their
  images follow the normal retention (M13) only: nothing extra is kept for them.
- The export keeps pseudonyms only (a manifest row never holds a name, a document number or a crop of
  a document) and is deleted on the training data's own schedule (to agree with the lawyer, Q3).

## The manifest and the stub

`py/manifest.py` (standard library; its rules run in CI) defines one JSON line per capture: file,
label, person (pseudonym), session, device, lighting, Monk tone (1-10) and the consent it rests on.
The split is **by person**, so no face is in both training and evaluation.

`py/train.py` is a stub: it checks the manifest and says what is missing (at least 50 people, 20 per
attack family, bona fide captures at Monk 7 or darker). Once the data is there it will take the face
worker's own measures on each capture (so training and serving share the code), fit a logistic
regression per attack family in numpy, and report **APCER per attack type and BPCER** (ISO/IEC
30107-3), overall and per Monk group, phone and lighting. The cut-offs it supports replace
`MOIRE_MIN`, `SCREEN_GLARE_MIN` and `LOW_DETAIL_MAX` in `face/decide.ts` (or a new score), with the PM.

```sh
python3 -m unittest discover -s training/antispoof/py -p "test_*.py"
uv run --project worker-face python training/antispoof/py/train.py --manifest <captures>/manifest.jsonl --root <captures>
```

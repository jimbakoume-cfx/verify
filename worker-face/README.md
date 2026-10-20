# Face worker (M6 liveness evaluation, M7 face match)

The second AI worker. For each face check a rider records (M5), it:

1. **re-checks the liveness challenge on the server** (`liveness` job): on every frame, the face (MediaPipe Face Landmarker's models), its pose, eye openness and blink score, smile score and mouth width; the **flat-plane test** (a print or a screen moves as one plane: the RMS error of the best homography of the skull's rigid points against the reference frame); the **same-face test** (3-D shape against the reference frame) and position jumps; and three **provisional passive cues** (moiré, screen glare, low detail);
2. **compares the ID portrait with the best frame** (`face_match` job, test sessions only): the portrait found on the document front (the passport's data page), the best frame (one face, straight, eyes open), both aligned on the ArcFace 5-point template and embedded by **AuraFace v1's `glintr100.onnx`**; the cosine similarity.

It decides nothing: the Supabase Edge Function `face` decides (`supabase/functions/face/decide.ts`) and records the case-level checks `liveness` and `face_match`. Images, landmarks and embeddings stay in memory; only numbers leave the worker (`FaceFrameMeasure`, `FaceMatchEvidence` in `contract.ts`). Never an embedding: it is a biometric template (PLAN.md Q4).

Specs: `docs/M6_SPEC.md`, `docs/M7_SPEC.md`.

## Why a second Vercel project

The AI worker's bundle is about 377 MB of Vercel's 500 MB Python limit; AuraFace alone is 261 MB. This project (`confiance-verify-face`) holds only what the face jobs need:

| Part | Installed size |
|---|---|
| ai-edge-litert 2.2.0 (LiteRT, runs the three `.tflite` models) | 58.3 MB |
| onnxruntime 1.30.0 (runs AuraFace) | 63.7 MB |
| numpy, pillow, cryptography, cffi, pycparser, packaging | 92.5 MB |
| **Python packages** | **214.5 MB** |
| `models/glintr100.onnx` (AuraFace) | 260.7 MB |
| `models/face_landmarker.task` (MediaPipe) | 3.8 MB |
| **Total** | **about 479 MB** (under 500 MB) |

**Not the `mediapipe` package.** Its single native library is 112 MB (271.8 MB installed with its dependencies), which with AuraFace would be about 533 MB. `verify_face/landmarks.py` runs Face Landmarker's own three models (detector, mesh, blendshapes) on LiteRT with MediaPipe's pipeline (letterbox, SSD anchors, weighted NMS, rotated 1.5x crop, projection); checked locally against the official package on a portrait: landmarks within 0.5 px on average, blendshapes within 0.015. If Vercel's "large functions" (beta, up to 5 GB) are used later, the official package can replace it.

The protocol is the AI worker's (M3), unchanged: the doorbell (`POST /api/process`, empty body, no authority), Ed25519-signed `POST /claim`, `/image`, `/result` to the `face` Edge Function, the bytes relayed (never a URL), the decisions and records made by the Edge Function. Differences: its own audience (`confiance-verify/face`) and key (`f1`, scope `face` in `worker_key`), so neither worker can call the other's function; `/image` takes the input's `captureId` (a job reads several photos: up to 15 frames and the document front), and only the inputs the claim handed out are relayed.

## Layout

| Path | What it does |
|---|---|
| `api/process.py` | Vercel entry point (the AI worker's, unchanged but for the package) |
| `verify_face/runner.py` | One ring: claim, fetch each input, analyse, result |
| `verify_face/client.py` | Signed calls; the claim validated field by field |
| `verify_face/signing.py` | Ed25519, the AI worker's canonical line for the face audience |
| `verify_face/imaging.py` | Bytes checked against the claim (size, SHA-256), JPEG only, dimensions |
| `verify_face/models.py`, `model_manifest.py` | Pinned model files (URL, size, SHA-256), checked at load; forbidden hashes (InsightFace) |
| `verify_face/landmarks.py` | BlazeFace + Face Mesh V2 + Blendshapes V2 on LiteRT |
| `verify_face/geometry.py` | Pose, eye aspect ratio, mouth width, 5 points, homography residual, shape distance; the synthetic canonical face for the tests |
| `verify_face/spoof.py` | Provisional passive cues (moiré, glare, detail) |
| `verify_face/liveness.py` | The liveness job's per-frame measures |
| `verify_face/facematch.py` | Portrait search (windows), best frame, alignment, AuraFace embedding, similarity |
| `verify_face/pipeline.py` | One job to its `FaceResultRequest`; refuses a face match for a real session |
| `scripts/fetch_models.py` | Build command: downloads the pinned models, refuses any other byte (standard library only) |
| `NOTICE` | Licences of what ships without one: ai-edge-litert, the MediaPipe model, AuraFace |

## Configuration (Vercel environment, production only)

| Variable | What it is |
|---|---|
| `SUPABASE_FACE_URL` | `https://<project-ref>.supabase.co/functions/v1/face` |
| `SUPABASE_PUBLISHABLE_KEY` | The project's publishable key (public) |
| `FACE_WORKER_KEY_ID` | `f1` |
| `FACE_WORKER_SIGNING_KEY` | **Secret.** base64url of the 32-byte Ed25519 seed. Its public key goes in `worker_key` with `scope = 'face'` |
| `FACE_MODELS_DIR` | Optional (default `models/` next to the code) |
| `FACE_MODEL_THREADS` | Optional, 1 to 4 (default 1: Vercel's single vCPU) |

## Develop and test

```sh
cd worker-face
uv sync
python3 scripts/fetch_models.py    # the models (265 MB), checked; needed by the tests marked `models`
uv run pytest                      # everything; without the models the `models` tests are skipped
FACE_MODELS_DIR=/nonexistent uv run pytest   # as CI runs it
uv lock --check
```

- **No real face anywhere in the tests.** `tests/synthface.py` draws a face: MediaPipe's canonical face model (its 468 points, triangles and texture coordinates, Apache-2.0) painted with a flat texture and rendered with a z-buffer. The real models find it, so the tests can turn its head (real 3-D parallax), close its eyes, make it smile, tilt it as a flat print (a homography), film it on a screen (a pixel grid) and paste it on a SPECIMEN document. Two drawn "people" differ in texture and shape. It tests the plumbing, the geometry and the sign conventions, never accuracy on real riders.
- `tests/test_edge_function.py` serves the real `face` Edge Function in Deno (`tests/tools/server_face.ts`): signatures, audience, scope, replays; with the models, a drawn genuine sequence passes, a tilted print fails, a turn the wrong way fails, a face match is recorded review-only. CI sets `FACE_REQUIRE_DENO=1`.
- **Licences:** `UV_PROJECT_ENVIRONMENT=/tmp/face-prod uv sync --frozen --no-dev && uv run python ../scripts/check-python-licenses.py --prod-python /tmp/face-prod/bin/python --table ../scripts/python-licenses-face.toml`.
- **Timing** (reported at the end of a run with the models, never asserted). On the development machine, one thread: a liveness job of 13 frames about **0.35 s of CPU**; a face match about **1.1 s** warm, **3-5 s** cold (AuraFace read, hashed and loaded).

## Deploy (Vercel project `confiance-verify-face`)

See `docs/M7_SPEC.md`, "Deploy notes", for the whole order (migration, Edge Functions, key, project, firewall). In short: root `worker-face/`, region `cdg1`, no Git deployments; the build command `python3 scripts/fetch_models.py` puts the models in `models/`, which `vercel.json` includes in the function; `VERCEL_PYTHON_DISABLE_RUNTIME_INSTALL=1` bundles every package. Check the build log: the two models "ok (downloaded)", no "exceeds the standard size; optimizing dependencies", and the function's size (expected about 479 MB). If the build command does not run for this project type, fetch locally and deploy prebuilt (`vercel build --prod` then `vercel deploy --prebuilt --prod`).

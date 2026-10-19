"""Confiance Verify face worker (M6 liveness evaluation, M7 face match).

Claims face jobs from the Supabase "face" Edge Function, measures the face check's frames (MediaPipe
Face Landmarker's models on LiteRT) and compares the ID portrait with the best frame (AuraFace), then
sends back numbers only: the Edge Function makes every decision. Images, landmarks and embeddings stay
in memory and are dropped with the job. See README.md.

This package must stay importable with the standard library alone: scripts/fetch_models.py imports
model_manifest at build time, before the dependencies are installed.
"""

# Face worker build, sent with every result (FaceResultRequest.engine, at most 60 characters).
WORKER_VERSION = "face-1"
MODELS_LABEL = "mediapipe-fl-v1/auraface-v1"
ENGINE = f"{WORKER_VERSION}/{MODELS_LABEL}"

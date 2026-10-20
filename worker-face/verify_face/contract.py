"""The parts of supabase/functions/_shared/contract.ts the face worker relies on, mirrored in Python.

contract.ts stays the single source of truth: tests/test_contract_sync.py reads it and fails when a
value here drifts from it.
"""

from __future__ import annotations

DECLARED_DOCUMENTS = (
    "cni_biometric",
    "cni_legacy",
    "passport",
    "residence_permit",
    "driving_licence",
    "voter_card",
)
LIVENESS_ACTIONS = ("turn_left", "turn_right", "look_up", "blink", "smile")
FACE_JOB_KINDS = ("liveness", "face_match")

# CAPTURE_LIMITS and LIVENESS_LIMITS: what the server accepted at upload.
MAX_CAPTURE_BYTES = 5 * 1024 * 1024
MAX_LONG_SIDE = 1600
MAX_FRAMES = 15
MAX_FRAME_BYTES = 100_000
MAX_FRAME_LONG_SIDE = 640

# Signatures: the AI worker's scheme (Worker API), for the face function's own audience.
WORKER_SIGNATURE_VERSION = "v1"
FACE_WORKER_AUDIENCE = "confiance-verify/face"
WORKER_SIGNATURE_WINDOW_S = 60
WORKER_HEADERS = {
    "keyId": "x-worker-key-id",
    "timestamp": "x-worker-timestamp",
    "nonce": "x-worker-nonce",
    "signature": "x-worker-signature",
}
FACE_LIMITS = {
    "maxBodyBytes": 32 * 1024,
    "maxInputs": 16,
    "maxEngineLength": 60,
}
# Routes as the face Edge Function sees them (after routePath() in _shared/http.ts).
ROUTES = ("/claim", "/image", "/result")

# FaceFrameMeasure keys, in contract order.
FRAME_MEASURE_KEYS = (
    "index", "faces", "yaw", "pitch", "roll", "blink", "eyeOpenness", "smile", "mouthWidth", "faceSize",
    "centerX", "centerY", "planarResidual", "shapeDistance", "moire", "glare", "detail",
)

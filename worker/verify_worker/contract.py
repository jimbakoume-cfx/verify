"""The parts of supabase/functions/_shared/contract.ts the worker relies on, mirrored in Python.

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
CAPTURE_SIDES = ("document_front", "document_back")
MRZ_FORMATS = ("TD1", "TD3")
MRZ_LAYOUT = {"TD1": {"lines": 3, "length": 30}, "TD3": {"lines": 2, "length": 44}}

# CAPTURE_LIMITS: what the server accepted at upload, so anything beyond is not a capture of ours.
MAX_CAPTURE_BYTES = 5 * 1024 * 1024
MAX_LONG_SIDE = 1600

# Worker API.
WORKER_SIGNATURE_VERSION = "v1"
WORKER_AUDIENCE = "confiance-verify/worker"
WORKER_SIGNATURE_WINDOW_S = 60
WORKER_HEADERS = {
    "keyId": "x-worker-key-id",
    "timestamp": "x-worker-timestamp",
    "nonce": "x-worker-nonce",
    "signature": "x-worker-signature",
}
WORKER_LIMITS = {
    "maxBodyBytes": 32 * 1024,
    "maxMrzCandidates": 8,
    "maxCandidateLength": 60,
    "maxFieldLength": 80,
    "maxKeywordGroups": 16,
    "maxEngineLength": 60,
}
# Routes as the worker Edge Function sees them (after routePath() in _shared/http.ts).
ROUTES = ("/claim", "/image", "/result")

# WorkerFields keys, in contract order.
FIELD_NAMES = ("surname", "givenNames", "documentNumber", "birthDate", "expiryDate", "issueDate", "subtype")
ROTATIONS = (0, 90, 180, 270)

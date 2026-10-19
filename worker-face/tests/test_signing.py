"""Request signatures for the face function: the AI worker's scheme and test key (the shared vectors in
supabase/functions/worker/signature.vectors.json), for the face audience. A signature made for one
function never verifies for the other."""

from __future__ import annotations

import json

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from conftest import REPO
from verify_face.contract import FACE_WORKER_AUDIENCE, WORKER_HEADERS
from verify_face.signing import Signer, b64url_decode, canonical_string

VECTORS = json.loads((REPO / "supabase" / "functions" / "worker" / "signature.vectors.json").read_text(encoding="utf-8"))


def signer() -> Signer:
    return Signer.from_seed(VECTORS["kid"], VECTORS["seed"])


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_the_canonical_line_is_the_ai_workers_with_the_face_audience(case):
    body = case["body"].encode("utf-8")
    message = canonical_string(VECTORS["kid"], case["method"], case["path"], case["timestamp"], case["nonce"], body)
    assert message.decode("ascii") == case["canonical"].replace("|confiance-verify/worker|", f"|{FACE_WORKER_AUDIENCE}|")


def test_signature_verifies_for_the_face_line_only():
    s = signer()
    body = b'{"jobId":"x"}'
    headers = s.headers("/result", body, now=1792400000, nonce="0" * 32)
    assert headers[WORKER_HEADERS["keyId"]] == VECTORS["kid"]
    public = Ed25519PublicKey.from_public_bytes(b64url_decode(VECTORS["public"]))
    signature = b64url_decode(headers[WORKER_HEADERS["signature"]])
    public.verify(signature, canonical_string(VECTORS["kid"], "POST", "/result", "1792400000", "0" * 32, body))
    worker_line = canonical_string(VECTORS["kid"], "POST", "/result", "1792400000", "0" * 32, body).replace(
        FACE_WORKER_AUDIENCE.encode(), b"confiance-verify/worker"
    )
    with pytest.raises(InvalidSignature):
        public.verify(signature, worker_line)


@pytest.mark.parametrize("path", ["/claim", "/image", "/result"])
def test_routes(path):
    assert canonical_string("f1", "POST", path, "1", "a" * 32, b"").startswith(b"v1|confiance-verify/face|f1|POST|" + path.encode())


def test_refuses_other_routes_methods_and_malformed_parts():
    with pytest.raises(ValueError):
        canonical_string("f1", "POST", "/process", "1", "a" * 32, b"")
    with pytest.raises(ValueError):
        canonical_string("f1", "GET", "/claim", "1", "a" * 32, b"")
    with pytest.raises(ValueError):
        canonical_string("f 1", "POST", "/claim", "1", "a" * 32, b"")
    with pytest.raises(ValueError):
        Signer.from_seed("f1", "too-short")

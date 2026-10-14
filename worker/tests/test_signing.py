"""Request signatures: byte-for-byte the canonical line and Ed25519 signatures the Edge Function
verifies (supabase/functions/worker/signature.vectors.json, shared with signature.test.ts)."""

from __future__ import annotations

import json
import re

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from conftest import REPO
from verify_worker.contract import WORKER_HEADERS
from verify_worker.signing import Signer, b64url_decode, b64url_encode, canonical_string, new_nonce

VECTORS = json.loads((REPO / "supabase" / "functions" / "worker" / "signature.vectors.json").read_text(encoding="utf-8"))


def signer() -> Signer:
    return Signer.from_seed(VECTORS["kid"], VECTORS["seed"])


def test_vector_key_is_the_rfc8032_test_key():
    s = signer()
    assert s.public_key_b64url() == VECTORS["public"]
    rfc = VECTORS["rfc8032"]
    assert b64url_decode(VECTORS["seed"]).hex() == rfc["seedHex"]
    assert s.private.sign(bytes.fromhex(rfc["message"])).hex() == rfc["signatureHex"]


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_vectors(case):
    body = case["body"].encode("utf-8")
    message = canonical_string(VECTORS["kid"], case["method"], case["path"], case["timestamp"], case["nonce"], body)
    assert message.decode("ascii") == case["canonical"]
    assert case["bodySha256"] in case["canonical"]
    headers = signer().headers(case["path"], body, now=int(case["timestamp"]), nonce=case["nonce"])
    assert headers == {
        WORKER_HEADERS["keyId"]: VECTORS["kid"],
        WORKER_HEADERS["timestamp"]: case["timestamp"],
        WORKER_HEADERS["nonce"]: case["nonce"],
        WORKER_HEADERS["signature"]: case["signature"],
    }


def test_signature_verifies_with_the_public_key():
    s = signer()
    body = b'{"jobId":"x","attempt":1}'
    h = s.headers("/image", body, now=1_800_000_000, nonce="0" * 32)
    public = Ed25519PublicKey.from_public_bytes(b64url_decode(s.public_key_b64url()))
    message = canonical_string(s.kid, "POST", "/image", "1800000000", "0" * 32, body)
    public.verify(b64url_decode(h[WORKER_HEADERS["signature"]]), message)  # raises if wrong


def test_fresh_nonce_and_current_timestamp():
    s = signer()
    a = s.headers("/claim", b"{}")
    b = s.headers("/claim", b"{}")
    assert a[WORKER_HEADERS["nonce"]] != b[WORKER_HEADERS["nonce"]]
    assert re.fullmatch(r"[0-9a-f]{32}", new_nonce())
    assert re.fullmatch(r"[0-9]{10}", a[WORKER_HEADERS["timestamp"]])
    # base64url without padding.
    assert re.fullmatch(r"[A-Za-z0-9_-]{86}", a[WORKER_HEADERS["signature"]])


@pytest.mark.parametrize(
    "kid, method, path, ts, nonce",
    [
        ("bad kid", "POST", "/claim", "1", "0" * 32),
        ("k", "GET", "/claim", "1", "0" * 32),
        ("k", "POST", "/other", "1", "0" * 32),
        ("k", "POST", "/claim", "-1", "0" * 32),
        ("k", "POST", "/claim", "1", "0" * 31),
        ("k", "POST", "/claim", "1", "A" * 32),
    ],
)
def test_canonical_refuses_malformed_parts(kid, method, path, ts, nonce):
    with pytest.raises(ValueError):
        canonical_string(kid, method, path, ts, nonce, b"")


@pytest.mark.parametrize("seed", ["", "abc", b64url_encode(b"\x01" * 31), b64url_encode(b"\x01" * 32) + "=", "+" * 43])
def test_seed_must_be_32_bytes_of_base64url(seed):
    with pytest.raises(ValueError):
        Signer.from_seed("k", seed)

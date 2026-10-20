"""Ed25519 request signatures for the face worker API (M6/M7): the AI worker's scheme
(worker/verify_worker/signing.py) for the face function's own audience, so that a signature made for one
function is never valid for the other. Every request to the face Edge Function is signed over one
canonical line, byte for byte the same as the TypeScript verifier builds it (worker/signature.ts):

    v1|confiance-verify/face|<kid>|<METHOD>|<path>|<timestamp>|<nonce>|<sha256 hex of the body>

path is the route as the Edge Function sees it ("/claim", "/image", "/result"), timestamp is Unix
seconds as a decimal string, nonce is 32 lowercase hex characters (used once). The signature and
the keys travel as base64url without padding. Only the face worker holds the private key (key id f1, scope "face"); Supabase keeps
the public key in worker_key, so nothing on the Vercel side can be replayed against it.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import secrets
import time
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .contract import FACE_WORKER_AUDIENCE, ROUTES, WORKER_HEADERS, WORKER_SIGNATURE_VERSION

_KID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_NONCE = re.compile(r"^[0-9a-f]{32}$")


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    """Strict base64url without padding: anything else (padding, '+', '/', spaces) is refused."""
    if not re.fullmatch(r"[A-Za-z0-9_-]*", text) or len(text) % 4 == 1:
        raise ValueError("not base64url")
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except binascii.Error as err:
        raise ValueError("not base64url") from err


def canonical_string(kid: str, method: str, path: str, timestamp: str, nonce: str, body: bytes) -> bytes:
    """The exact bytes that are signed (ASCII)."""
    if not _KID.match(kid):
        raise ValueError("bad key id")
    if method != "POST":
        raise ValueError("bad method")
    if path not in ROUTES:
        raise ValueError("bad path")
    if not timestamp.isdigit():
        raise ValueError("bad timestamp")
    if not _NONCE.match(nonce):
        raise ValueError("bad nonce")
    digest = hashlib.sha256(body).hexdigest()
    fields = (WORKER_SIGNATURE_VERSION, FACE_WORKER_AUDIENCE, kid, method, path, timestamp, nonce, digest)
    return "|".join(fields).encode("ascii")


def new_nonce() -> str:
    """128 random bits as 32 lowercase hex characters."""
    return secrets.token_hex(16)


@dataclass(frozen=True)
class Signer:
    """The face worker's signing key and its id (FACE_WORKER_KEY_ID)."""

    kid: str
    # Not called `key`: the CI secret scan (gitleaks) reads "key: <long identifier>" as a leaked key.
    private: Ed25519PrivateKey

    @classmethod
    def from_seed(cls, kid: str, seed_b64url: str) -> Signer:
        """FACE_WORKER_SIGNING_KEY: base64url of the 32-byte Ed25519 seed."""
        if not _KID.match(kid):
            raise ValueError("bad key id")
        seed = b64url_decode(seed_b64url.strip())
        if len(seed) != 32:
            raise ValueError("bad seed length")
        return cls(kid, Ed25519PrivateKey.from_private_bytes(seed))

    def public_key_b64url(self) -> str:
        """The value to store in worker_key.public_key (32 raw bytes, base64url)."""
        raw = self.private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        return b64url_encode(raw)

    def headers(
        self,
        path: str,
        body: bytes,
        *,
        method: str = "POST",
        now: float | None = None,
        nonce: str | None = None,
    ) -> dict[str, str]:
        """The four signature headers for one request. `now` and `nonce` are fixed only in tests."""
        timestamp = str(int(time.time() if now is None else now))
        nonce = new_nonce() if nonce is None else nonce
        message = canonical_string(self.kid, method, path, timestamp, nonce, body)
        return {
            WORKER_HEADERS["keyId"]: self.kid,
            WORKER_HEADERS["timestamp"]: timestamp,
            WORKER_HEADERS["nonce"]: nonce,
            WORKER_HEADERS["signature"]: b64url_encode(self.private.sign(message)),
        }

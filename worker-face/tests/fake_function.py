"""A stand-in for the Supabase "face" Edge Function, served on 127.0.0.1 for the client tests. It checks
every request as the real one does (apikey, Ed25519 signature over the face audience's canonical line,
timestamp window, single-use nonce) and answers from a script. tests/test_edge_function.py runs the
real one."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from verify_face.contract import WORKER_HEADERS, WORKER_SIGNATURE_WINDOW_S
from verify_face.signing import b64url_decode, canonical_string

PREFIX = "/functions/v1/face"
API_KEY = "sb_publishable_test"


class FakeFunction:
    def __init__(self, kid: str, public_key_b64url: str):
        self.kid = kid
        self.public = Ed25519PublicKey.from_public_bytes(b64url_decode(public_key_b64url))
        self.claims: list[Any] = []  # dicts (jobs), or ints (an error status to answer)
        self.images: dict[str, Any] = {}  # captureId -> bytes, or an error status
        self.result_status = 200
        self.results: list[dict] = []
        self.requests: list[str] = []
        self.image_requests: list[dict] = []
        self.nonces: set[str] = set()
        self.refused: list[str] = []
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}{PREFIX}"

    def __enter__(self) -> FakeFunction:
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                path = self.path[len(PREFIX):] if self.path.startswith(PREFIX) else self.path
                fake.requests.append(path)
                problem = fake.check(self.headers, path, body)
                if problem:
                    fake.refused.append(problem)
                    return self.error(401, problem)
                if path == "/claim":
                    if not fake.claims:
                        self.send_response(204)
                        self.end_headers()
                        return None
                    item = fake.claims.pop(0)
                    return self.error(item, "server_error") if isinstance(item, int) else self.json(200, item)
                if path == "/image":
                    request = json.loads(body)
                    fake.image_requests.append(request)
                    item = fake.images.get(request["captureId"], 404)
                    if isinstance(item, int):
                        return self.error(item, "image_gone" if item == 410 else "not_found")
                    self.send_response(200)
                    self.send_header("content-type", "image/jpeg")
                    self.send_header("content-length", str(len(item)))
                    self.end_headers()
                    self.wfile.write(item)
                    return None
                if path == "/result":
                    fake.results.append(json.loads(body))
                    if fake.result_status != 200:
                        return self.error(fake.result_status, "image_gone")
                    return self.json(200, {"status": "recorded"})
                return self.error(404, "not_found")

            def json(self, status: int, value: Any) -> None:
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def error(self, status: int, code: str) -> None:
                self.json(status, {"error": {"code": code, "message": "test"}})

        return Handler

    def check(self, headers, path: str, body: bytes) -> str | None:
        if headers.get("apikey") != API_KEY:
            return "unauthorized"
        kid = headers.get(WORKER_HEADERS["keyId"])
        ts = headers.get(WORKER_HEADERS["timestamp"]) or ""
        nonce = headers.get(WORKER_HEADERS["nonce"]) or ""
        signature = headers.get(WORKER_HEADERS["signature"]) or ""
        if kid != self.kid or not ts.isdigit() or abs(int(ts) - time.time()) > WORKER_SIGNATURE_WINDOW_S:
            return "invalid_signature"
        try:
            self.public.verify(b64url_decode(signature), canonical_string(kid, "POST", path, ts, nonce, body))
        except (InvalidSignature, ValueError):
            return "invalid_signature"
        if nonce in self.nonces:
            return "replayed_request"
        self.nonces.add(nonce)
        return None

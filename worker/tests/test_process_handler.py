"""api/process.py, the Vercel entry point: a ring runs the loop and answers {"ok": ...} only."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import logging
import threading
import urllib.error
import urllib.request
from http.server import HTTPServer

import pytest
from PIL import Image

from conftest import WORKER
from fake_function import API_KEY, FakeFunction
from verify_worker import log
from verify_worker.signing import Signer, b64url_encode

SEED = b64url_encode(bytes(range(1, 33)))
KID = "ring-test"
PROXY_VARS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy")


def load_process_module():
    spec = importlib.util.spec_from_file_location("api_process", WORKER / "api" / "process.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def process(monkeypatch):
    for name in PROXY_VARS:
        monkeypatch.delenv(name, raising=False)
    for name in ("SUPABASE_WORKER_URL", "SUPABASE_PUBLISHABLE_KEY", "WORKER_KEY_ID", "WORKER_SIGNING_KEY"):
        monkeypatch.delenv(name, raising=False)
    return load_process_module()


@pytest.fixture
def server(process):
    httpd = HTTPServer(("127.0.0.1", 0), process.handler)
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}/api/process"
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture
def logs():
    log.configure()
    records: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    handler = Collect()
    logging.getLogger("verify_worker").addHandler(handler)
    yield records
    logging.getLogger("verify_worker").removeHandler(handler)


def call(url: str, method: str = "POST", body: bytes | None = b"") -> tuple[int, dict, dict]:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, data=body if method in ("POST", "PUT") else None, method=method)
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, dict(response.headers), json.loads(response.read() or b"null")
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), json.loads(err.read() or b"null")


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE", "PATCH"])
def test_only_post(server, method):
    status, headers, body = call(server, method)
    assert status == 405 and body == {"ok": False}
    assert headers.get("allow") == "POST"


def test_missing_configuration(server, logs):
    status, _, body = call(server)
    assert status == 500 and body == {"ok": False}
    assert logs == ["ring_failed.config_missing"]


def test_ring_runs_the_loop(server, process, monkeypatch, logs):
    signer = Signer.from_seed(KID, SEED)
    buf = io.BytesIO()
    Image.new("RGB", (900, 570)).save(buf, "JPEG")
    image = buf.getvalue()
    job = "7b0c3c1e-1a59-4c55-9d40-2f6f2a0d9c11"
    with FakeFunction(KID, signer.public_key_b64url()) as fake:
        fake.claims = [{
            "jobId": job, "attempt": 1, "captureId": "0a7f1f5e-5e2b-4f8a-9f53-0d0c4f9d2b10", "side": "document_front",
            "declaredDocument": "passport", "mrzExpectation": None,
            "image": {"sha256": hashlib.sha256(image).hexdigest(), "byteSize": len(image), "width": 900, "height": 570},
        }]
        fake.images = {job: image}
        monkeypatch.setenv("SUPABASE_WORKER_URL", fake.url)
        monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", API_KEY)
        monkeypatch.setenv("WORKER_KEY_ID", KID)
        monkeypatch.setenv("WORKER_SIGNING_KEY", SEED)
        seen = []

        def analyse(claim, data):
            seen.append(claim["jobId"])
            return {"jobId": job, "attempt": 1, "timing": {"ms": 5, "cold": True}, "quality": {"textLines": 0}, "classification": {"rotation": 0}}

        monkeypatch.setattr(process, "analyse", analyse)
        # The ring's body is ignored, whatever it holds.
        status, _, body = call(server, body=b'{"jobId": "something else", "please": "process"}')
    assert status == 200 and body == {"ok": True}
    assert seen == [job] and len(fake.results) == 1
    assert logs[-1].startswith("ring_done.no_job claimed=1 recorded=1")


def test_unexpected_errors_are_logged_by_class_only(server, process, monkeypatch, logs):
    def boom():
        raise RuntimeError("SPECIMEN HELENE 15.02.1990 must never reach a log")

    monkeypatch.setattr(process, "ring", boom)
    status, _, body = call(server)
    assert status == 500 and body == {"ok": False}
    assert logs == ["ring_failed.unhandled error=RuntimeError"]


@pytest.mark.parametrize(
    "body, headers",
    [(b"", {}), (b"{}", {"content-type": "application/json"})],
    ids=["flow ring: empty body", "sweep ring: pg_net posts {} as JSON"],
)
def test_rings_from_the_flow_and_the_sweep(server, process, monkeypatch, body, headers):
    """Both doorbells Supabase rings are accepted alike; their body is never read for meaning."""
    rings = []
    monkeypatch.setattr(process, "ring", lambda: rings.append(True) or (200, {"ok": True}))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(server, data=body, method="POST", headers=headers)
    with opener.open(request, timeout=30) as response:
        assert (response.status, json.loads(response.read())) == (200, {"ok": True})
    assert rings == [True]

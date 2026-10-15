"""The worker against the real worker Edge Function: supabase/functions/worker/handler.ts, run in Deno by
tests/tools/server_worker.ts with in-memory stand-ins for the database and storage.

The TypeScript verifier checks the Python signatures (the same RFC 8032 test key as the shared vectors
in signature.vectors.json, at the current time), refuses replays, tampering and other keys, and the
results the real pipeline sends pass the server's strict validation and decisions, including the
shared MRZ corrector and parser. fake_function.py is a Python re-implementation; this is the real one.
"""

from __future__ import annotations

import hashlib
import json
import queue
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from conftest import REPO, SPECIMENS, deno_or_skip, has_deno
from verify_worker.client import WorkerClient, default_opener
from verify_worker.contract import WORKER_HEADERS
from verify_worker.signing import Signer, b64url_encode, canonical_string

VECTORS = json.loads((REPO / "supabase" / "functions" / "worker" / "signature.vectors.json").read_text(encoding="utf-8"))
KID = VECTORS["kid"]
API_KEY = "sb_publishable_test"
SERVER = "worker/tests/tools/server_worker.ts"
# The first run compiles the function's TypeScript; later ones start in about a second.
START_TIMEOUT_S = 120


class EdgeFunction:
    """The real worker function on 127.0.0.1, serving `jobs` in order."""

    def __init__(self, workdir: Path, jobs: list[dict]):
        config = workdir / "server.json"
        config.write_text(json.dumps({"kid": KID, "publicKey": VECTORS["public"], "jobs": jobs}), encoding="utf-8")
        self.events: queue.Queue[dict] = queue.Queue()
        self.proc = subprocess.Popen(
            [
                "npx", "deno", "run", "--quiet", "--no-prompt",
                "--allow-net=127.0.0.1",
                f"--allow-read={SPECIMENS},{config}",
                SERVER, str(config),
            ],
            cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        threading.Thread(target=self._read, daemon=True).start()
        event = self.events.get(timeout=START_TIMEOUT_S)
        assert event["event"] == "listening", event
        self.url = f"http://127.0.0.1:{event['port']}/functions/v1/worker"

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.events.put(json.loads(line))

    def drain(self) -> list[dict]:
        events = []
        while True:
            try:
                events.append(self.events.get_nowait())
            except queue.Empty:
                return events

    def close(self) -> None:
        self.proc.terminate()
        self.proc.wait(timeout=10)


@pytest.fixture
def edge(tmp_path):
    if not has_deno():
        deno_or_skip()
    started: list[EdgeFunction] = []

    def start(jobs: list[dict] | None = None) -> EdgeFunction:
        function = EdgeFunction(tmp_path, jobs or [])
        started.append(function)
        return function

    yield start
    for function in started:
        function.close()


def vector_signer() -> Signer:
    return Signer.from_seed(KID, VECTORS["seed"])


def client_for(function: EdgeFunction, signer: Signer | None = None) -> WorkerClient:
    # No proxy for 127.0.0.1, whatever the environment says.
    return WorkerClient(function.url, API_KEY, signer or vector_signer(), opener=default_opener({}))


def post(function: EdgeFunction, path: str, body: bytes, headers: dict[str, str]) -> tuple[int, dict | None]:
    """A raw POST; returns the status and the JSON body (None when empty)."""
    request = urllib.request.Request(
        function.url + path, data=body, method="POST", headers={"content-type": "application/json", "apikey": API_KEY, **headers}
    )
    opener = default_opener({})
    try:
        with opener.open(request, timeout=30) as response:
            data = response.read()
            return response.status, json.loads(data) if data else None
    except urllib.error.HTTPError as err:
        data = err.read()
        return err.code, json.loads(data) if data else None


def error_code(answer: tuple[int, dict | None]) -> tuple[int, str | None]:
    status, body = answer
    return status, (body or {}).get("error", {}).get("code")


def test_python_signatures_verify_in_the_edge_function(edge):
    """The worker's own client, signing with the shared test key now: accepted (204, no job)."""
    function = edge()
    client = client_for(function)
    assert client.claim() is None
    assert client.claim() is None  # a fresh nonce each time


def test_the_edge_function_refuses_what_it_must(edge):
    function = edge()
    signer = vector_signer()
    body = b"{}"

    # No signature at all.
    assert error_code(post(function, "/claim", body, {})) == (401, "invalid_signature")

    # The same signed request twice: the nonce is used once.
    headers = signer.headers("/claim", body)
    assert post(function, "/claim", body, headers) == (204, None)
    assert error_code(post(function, "/claim", body, headers)) == (401, "replayed_request")

    # A body other than the one signed (the digest of the raw bytes is in the canonical line).
    tampered = signer.headers("/claim", body)
    assert error_code(post(function, "/claim", b'{"x":1}', tampered)) == (401, "invalid_signature")
    assert error_code(post(function, "/claim", b"{ }", signer.headers("/claim", body))) == (401, "invalid_signature")

    # Signed for another route.
    assert error_code(post(function, "/claim", body, signer.headers("/image", body))) == (401, "invalid_signature")

    # Outside the time window, either way.
    for skew in (-120, 120):
        assert error_code(post(function, "/claim", body, signer.headers("/claim", body, now=time.time() + skew))) == (
            401,
            "invalid_signature",
        )

    # Another key under the same id, and an unknown id.
    other = Ed25519PrivateKey.generate().private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    impostor = Signer.from_seed(KID, b64url_encode(other))
    assert error_code(post(function, "/claim", body, impostor.headers("/claim", body))) == (401, "invalid_signature")
    stranger = Signer.from_seed("unknown-kid", VECTORS["seed"])
    assert error_code(post(function, "/claim", body, stranger.headers("/claim", body))) == (401, "invalid_signature")

    # A signature over a line of the other audience's format is not ours.
    message = canonical_string(KID, "POST", "/claim", str(int(time.time())), "ab" * 16, body)
    foreign = message.replace(b"confiance-verify/worker", b"confiance-verify/other")
    headers = signer.headers("/claim", body)
    headers[WORKER_HEADERS["nonce"]] = "ab" * 16
    headers[WORKER_HEADERS["timestamp"]] = message.split(b"|")[5].decode("ascii")
    headers[WORKER_HEADERS["signature"]] = b64url_encode(signer.private.sign(foreign))
    assert error_code(post(function, "/claim", body, headers)) == (401, "invalid_signature")

    # A browser (any Origin) is refused before anything else.
    assert error_code(post(function, "/claim", body, {**signer.headers("/claim", body), "origin": "https://example.org"}))[0] == 403

    # After all that, the worker's own requests still go through.
    assert client_for(function).claim() is None


def specimen_job(file: str, verification: str, manifest: dict) -> dict:
    photo = next(p for p in manifest["photos"] if p["file"] == file)
    data = (SPECIMENS / file).read_bytes()
    return {
        "jobId": str(uuid.uuid4()),
        "captureId": str(uuid.uuid4()),
        "verificationId": verification,
        "kind": photo["side"],
        "declaredDocument": photo["declaredDocument"],
        "image": str(SPECIMENS / file),
        "sha256": hashlib.sha256(data).hexdigest(),
        "byteSize": len(data),
        "width": photo["width"],
        "height": photo["height"],
    }


@pytest.mark.ocr
def test_a_ring_through_the_real_edge_function(edge, manifest):
    """Claim, image and result, signed by the worker and checked by the function, for real specimens:
    the server reads back exactly the printed code lines, and its quality verdicts are the ones the
    rider's retakes depend on."""
    from verify_worker.pipeline import analyse
    from verify_worker.runner import run_ring

    cni = str(uuid.uuid4())
    files = ["cni-new-front.jpg", "cni-new-back.jpg", "passport-uto.jpg", "blank-card.jpg", "no-document.jpg"]
    jobs = [specimen_job(f, cni if f.startswith("cni-new") else str(uuid.uuid4()), manifest) for f in files]
    function = edge(jobs)

    summary = run_ring(client_for(function), analyse, window_s=240)
    assert (summary.claimed, summary.recorded, summary.stopped) == (len(files), len(files), "no_job")

    events = function.drain()
    results = {e["jobId"]: e for e in events if e["event"] == "result"}
    audits = [e for e in events if e["event"] == "audit"]
    by_file = {f: results[job["jobId"]] for f, job in zip(files, jobs, strict=True)}
    assert all(r["kid"] == KID and r["attempt"] == 1 for r in by_file.values())

    def check(result: dict, name: str) -> dict:
        return next(c for c in result["checks"] if c["name"] == name)

    # The code lines: the worker's candidates, corrected and parsed by the server, are the printed ones.
    for file in ("cni-new-back.jpg", "passport-uto.jpg"):
        expected = next(p for p in manifest["photos"] if p["file"] == file)["expected"]["mrz"]
        result = by_file[file]
        assert result["mrzFormat"] == expected["format"]
        assert result["mrzLines"] == "\n".join(expected["lines"])
        mrz = check(result, "mrz_server")
        assert mrz["outcome"] == "pass", file
        assert mrz["details"]["found"] is True
        assert all(mrz["details"]["checks"].values())

    # The verdicts behind the rider's retakes: unreadable and no_document; the specimens are usable.
    verdicts = {f: check(r, "quality_server")["details"]["verdict"] for f, r in by_file.items()}
    assert verdicts == {
        "cni-new-front.jpg": "ok",
        "cni-new-back.jpg": "ok",
        "passport-uto.jpg": "ok",
        "blank-card.jpg": "unreadable",
        "no-document.jpg": "no_document",
    }

    # Both sides of the new CNI decided the case: classification and the document policy.
    case = by_file["cni-new-back.jpg"]["caseChecks"]
    assert case is not None and case["classification"] is not None

    # One audit entry per photo relayed, naming the key; never a value read from a document.
    assert sorted(a["details"]["jobId"] for a in audits if a["action"] == "worker.image") == sorted(j["jobId"] for j in jobs)
    assert all(a["actorId"] == KID for a in audits)
    public = json.dumps([[r["checks"], r["caseChecks"]] for r in results.values()] + audits)
    for photo in manifest["photos"]:
        if photo["file"] in files:
            for value in [*photo["printed"].values(), *(photo["expected"]["mrz"] or {}).get("lines", [])]:
                assert str(value) not in public, photo["file"]

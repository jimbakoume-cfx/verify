"""The face worker against the real face Edge Function: supabase/functions/face/handler.ts, run in Deno
by tests/tools/server_face.ts with in-memory stand-ins for the database and storage.

Without the models: the TypeScript verifier checks the Python signatures for the face audience (the
shared RFC 8032 test key, at the current time) and refuses the AI worker's audience, a key of the
documents scope, replays and tampering; a ring with stand-in evidence passes the strict validation.
With the models (marked `models`): drawn faces through the real pipeline, decided by the real rules:
a genuine sequence passes, a tilted print fails its actions, the same drawn person matches.
"""

from __future__ import annotations

import hashlib
import json
import queue
import subprocess
import threading
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import pytest

import synthface as sf
from conftest import REPO, SPECIMENS, deno_or_skip, has_deno
from verify_face import pipeline
from verify_face.client import FaceClient, default_opener
from verify_face.runner import run_ring
from verify_face.signing import Signer

VECTORS = json.loads((REPO / "supabase" / "functions" / "worker" / "signature.vectors.json").read_text(encoding="utf-8"))
KID = "f1"
API_KEY = "sb_publishable_test"
SERVER = "worker-face/tests/tools/server_face.ts"
START_TIMEOUT_S = 120
STEPS = [0] + [1] * 4 + [2] * 4 + [3] * 4


class EdgeFunction:
    def __init__(self, workdir: Path, jobs: list[dict], other_keys: list[dict] | None = None):
        config = workdir / "server.json"
        config.write_text(json.dumps({"kid": KID, "publicKey": VECTORS["public"], "otherKeys": other_keys or [], "jobs": jobs}), encoding="utf-8")
        self.events: queue.Queue[dict] = queue.Queue()
        self.proc = subprocess.Popen(
            ["npx", "deno", "run", "--quiet", "--no-prompt", "--allow-net=127.0.0.1", f"--allow-read={workdir}", SERVER, str(config)],
            cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        threading.Thread(target=self._read, daemon=True).start()
        event = self.events.get(timeout=START_TIMEOUT_S)
        assert event["event"] == "listening", event
        self.url = f"http://127.0.0.1:{event['port']}/functions/v1/face"

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.events.put(json.loads(line))

    def drain(self) -> list[dict]:
        out = []
        while True:
            try:
                out.append(self.events.get_nowait())
            except queue.Empty:
                return out

    def close(self) -> None:
        self.proc.terminate()
        self.proc.wait(timeout=10)


@pytest.fixture
def edge(tmp_path):
    if not has_deno():
        deno_or_skip()
    started: list[EdgeFunction] = []

    def start(jobs: list[dict] | None = None, other_keys: list[dict] | None = None) -> EdgeFunction:
        function = EdgeFunction(tmp_path, jobs or [], other_keys)
        started.append(function)
        return function

    yield start
    for function in started:
        function.close()


def signer() -> Signer:
    return Signer.from_seed(KID, VECTORS["seed"])


def client_for(function: EdgeFunction, s: Signer | None = None) -> FaceClient:
    return FaceClient(function.url, API_KEY, s or signer(), opener=default_opener({}))


def job(tmp: Path, kind: str, frames: list, document=None, test_session: bool = True) -> dict:
    """A job whose inputs are written to files the stand-in storage serves."""
    inputs = []
    for i, picture in enumerate(frames):
        data = sf.jpeg(picture)
        path = tmp / f"{uuid.uuid4()}.jpg"
        path.write_bytes(data)
        inputs.append({"captureId": str(uuid.uuid4()), "role": "frame", "index": i, "step": STEPS[i], "atMs": 900 + i * 600,
                       "sha256": hashlib.sha256(data).hexdigest(), "byteSize": len(data), "width": picture.shape[1],
                       "height": picture.shape[0], "file": str(path)})
    if document is not None:
        data = sf.jpeg(document, 90)
        path = tmp / f"{uuid.uuid4()}.jpg"
        path.write_bytes(data)
        inputs.append({"captureId": str(uuid.uuid4()), "role": "document", "index": None, "step": None, "atMs": None,
                       "sha256": hashlib.sha256(data).hexdigest(), "byteSize": len(data), "width": document.shape[1],
                       "height": document.shape[0], "file": str(path)})
    return {"jobId": str(uuid.uuid4()), "kind": kind, "verificationId": str(uuid.uuid4()), "challengeId": str(uuid.uuid4()),
            "actions": ["turn_left", "blink", "smile"], "testSession": test_session, "inputs": inputs}


def plain_frames(n: int = 13) -> list:
    import numpy as np

    return [np.full((480, 360, 3), 40 + i, np.uint8) for i in range(n)]


def stand_in_analyse(claim: dict, images: dict) -> dict:
    """Evidence of the right shape without the models: every frame faceless."""
    frames = sorted((i for i in claim["inputs"] if i["role"] == "frame"), key=lambda i: i["index"])
    empty = {k: None for k in ("yaw", "pitch", "roll", "blink", "eyeOpenness", "smile", "mouthWidth", "faceSize", "centerX",
                               "centerY", "planarResidual", "shapeDistance", "moire", "glare", "detail")}
    return {"jobId": claim["jobId"], "attempt": claim["attempt"], "kind": claim["kind"], "engine": "face-1/stand-in",
            "liveness": {"referenceIndex": None, "frames": [{"index": f["index"], "faces": 0, **empty} for f in frames]},
            "faceMatch": None, "timing": {"ms": 1, "cold": False}}


def raw_post(function: EdgeFunction, path: str, headers: dict) -> int:
    request = urllib.request.Request(function.url + path, data=b"{}", method="POST",
                                     headers={"content-type": "application/json", "apikey": API_KEY, **headers})
    try:
        with default_opener({}).open(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as err:
        return err.code


def test_signatures_audience_scope_and_replay(edge):
    documents_key = Signer.from_seed("w1", VECTORS["seed"])
    function = edge(other_keys=[{"kid": "w1", "publicKey": VECTORS["public"], "scope": "documents"}])
    assert client_for(function).claim() is None  # signed by the face key: 204
    headers = signer().headers("/claim", b"{}")
    assert raw_post(function, "/claim", headers) == 204
    assert raw_post(function, "/claim", headers) == 401  # the same nonce again
    # The same key material registered for the AI worker (scope documents): refused.
    assert raw_post(function, "/claim", documents_key.headers("/claim", b"{}")) == 401
    # A signature for the AI worker's audience: refused (canonical line differs).
    from verify_face import signing

    worker_line_headers = signer().headers("/claim", b"{}")
    original = signing.FACE_WORKER_AUDIENCE
    try:
        signing.FACE_WORKER_AUDIENCE = "confiance-verify/worker"
        worker_line_headers = signer().headers("/claim", b"{}")
    finally:
        signing.FACE_WORKER_AUDIENCE = original
    assert raw_post(function, "/claim", worker_line_headers) == 401
    # Tampering: signed for /claim, sent to /result.
    assert raw_post(function, "/result", signer().headers("/claim", b"{}")) == 401


def test_a_ring_with_stand_in_evidence_is_validated_decided_and_audited(edge, tmp_path):
    function = edge([job(tmp_path, "liveness", plain_frames())])
    summary = run_ring(client_for(function), stand_in_analyse)
    assert (summary.claimed, summary.recorded) == (1, 1)
    events = function.drain()
    audits = [e for e in events if e["event"] == "audit"]
    assert len(audits) == 13 and all(a["action"] == "face.image" and a["actorId"] == KID for a in audits)
    result = next(e for e in events if e["event"] == "result")
    assert result["checkName"] == "liveness" and result["outcome"] == "flag"
    assert result["details"]["problems"] == ["action_unclear", "no_reference", "face_missing"]


@pytest.mark.models
def test_with_the_models_a_genuine_sequence_passes(edge, tmp_path):
    from test_models import sequence

    function = edge([job(tmp_path, "liveness", sequence(("turn_left", "blink", "smile")))])
    assert run_ring(client_for(function), pipeline.analyse).recorded == 1
    result = next(e for e in function.drain() if e["event"] == "result")
    assert result["outcome"] == "pass", result["details"]
    assert [a["result"] for a in result["details"]["actions"]] == ["pass", "pass", "pass"]
    assert result["details"]["flatPlane"] == "depth"


@pytest.mark.models
def test_with_the_models_a_tilted_print_fails(edge, tmp_path):
    front = sf.render()
    frames = [front] + [sf.tilted_print(front, angle) for angle in (5, 12, 20, 25, 0, 0, 0, 0, -8, -15, -20, -25)]
    function = edge([job(tmp_path, "liveness", frames)])
    assert run_ring(client_for(function), pipeline.analyse).recorded == 1
    result = next(e for e in function.drain() if e["event"] == "result")
    assert result["outcome"] == "fail", result["details"]
    assert "action_not_done" in result["details"]["problems"]


@pytest.mark.models
def test_with_the_models_the_turns_must_go_the_asked_way(edge, tmp_path):
    from test_models import sequence

    # Asked to turn left, the drawn rider turns right.
    function = edge([job(tmp_path, "liveness", sequence(("turn_right", "blink", "smile")))])
    run_ring(client_for(function), pipeline.analyse)
    result = next(e for e in function.drain() if e["event"] == "result")
    assert result["outcome"] == "fail"
    assert "wrong_direction" in result["details"]["problems"]


@pytest.mark.models
def test_with_the_models_a_face_match_is_recorded_review_only(edge, tmp_path):
    from test_models import PASSPORT_PORTRAIT_BOX, sequence

    document = sf.document_with_portrait(SPECIMENS / "passport-cmr.jpg", sf.render(sf.ALICE, size=(300, 380), face_width=200), PASSPORT_PORTRAIT_BOX)
    function = edge([job(tmp_path, "face_match", sequence(("turn_left", "blink", "smile")), document)])
    assert run_ring(client_for(function), pipeline.analyse).recorded == 1
    result = next(e for e in function.drain() if e["event"] == "result")
    details = result["details"]
    assert result["checkName"] == "face_match"
    assert details["calibrated"] is False and details["reviewOnly"] is True
    assert details["similarity"] is not None and details["portrait"]["box"] is not None
    assert result["outcome"] in ("pass", "flag")

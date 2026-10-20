"""The face worker's loop against a stand-in function that verifies every signature: claims validated
field by field, each input fetched and checked against the claim before any decoder sees it, results
sent, and every way a job can end."""

from __future__ import annotations

import hashlib
import io
import logging
import uuid

import numpy as np
import pytest
from PIL import Image

from fake_function import API_KEY, FakeFunction
from verify_face import log
from verify_face.client import FaceClient, WorkerApiError, default_opener, validate_claim
from verify_face.imaging import ImageRejected, decode_input
from verify_face.pipeline import NotAllowed
from verify_face.runner import ConfigError, client_from_env, run_ring
from verify_face.signing import Signer, b64url_encode

SEED = b64url_encode(bytes(range(32)))
KID = "f1"


def jpeg(width: int, height: int, shade: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (shade, shade, shade)).save(out, "JPEG", quality=90)
    return out.getvalue()


FRAMES = [jpeg(360, 480, 60 + i) for i in range(13)]
DOCUMENT = jpeg(1280, 900, 200)


def spec(capture_id: str, data: bytes, role: str, index: int | None, width: int, height: int) -> dict:
    return {
        "captureId": capture_id,
        "role": role,
        "index": index,
        "step": None if index is None else (0 if index == 0 else (index - 1) // 4 + 1),
        "atMs": None if index is None else 900 + index * 600,
        "sha256": hashlib.sha256(data).hexdigest(),
        "byteSize": len(data),
        "width": width,
        "height": height,
    }


def claim(kind: str = "liveness", test_session: bool = True) -> tuple[dict, dict[str, bytes]]:
    images = {}
    inputs = []
    for i, data in enumerate(FRAMES):
        cid = str(uuid.uuid4())
        images[cid] = data
        inputs.append(spec(cid, data, "frame", i, 360, 480))
    if kind == "face_match":
        cid = str(uuid.uuid4())
        images[cid] = DOCUMENT
        inputs.append(spec(cid, DOCUMENT, "document", None, 1280, 900))
    return {
        "jobId": str(uuid.uuid4()),
        "attempt": 1,
        "kind": kind,
        "testSession": test_session,
        "declaredDocument": "passport",
        "actions": ["turn_left", "blink", "smile"],
        "inputs": inputs,
    }, images


def fake_analyse(c: dict, images: dict[str, np.ndarray]) -> dict:
    assert set(images) == {i["captureId"] for i in c["inputs"]}
    if c["kind"] == "face_match" and not c["testSession"]:
        raise NotAllowed("face_match_real_session")
    return {"jobId": c["jobId"], "attempt": c["attempt"], "kind": c["kind"], "engine": "face-1/test",
            "liveness": None, "faceMatch": None, "timing": {"ms": 5, "cold": False}}


@pytest.fixture
def signer() -> Signer:
    return Signer.from_seed(KID, SEED)


@pytest.fixture
def fake(signer):
    with FakeFunction(KID, signer.public_key_b64url()) as f:
        yield f


@pytest.fixture
def client(fake, signer) -> FaceClient:
    return FaceClient(fake.url, API_KEY, signer, opener=default_opener(proxies={}))


@pytest.fixture
def logs():
    records: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    log.configure()
    handler = Collect()
    logger = logging.getLogger("verify_face")
    logger.addHandler(handler)
    yield records
    logger.removeHandler(handler)


def queue(fake: FakeFunction, *items: tuple[dict, dict[str, bytes]]) -> None:
    for c, images in items:
        fake.claims.append(c)
        fake.images.update(images)


def shared_face_check() -> tuple[tuple[dict, dict[str, bytes]], tuple[dict, dict[str, bytes]]]:
    """A face check's two jobs, as the database hands them out: the same frames, the document for the match."""
    live, images = claim("liveness")
    match, match_images = claim("face_match")
    document = match["inputs"][-1]
    match["inputs"] = [dict(i) for i in live["inputs"]] + [document]
    return (live, images), (match, {document["captureId"]: match_images[document["captureId"]]})


def test_a_face_check_s_two_jobs_fetch_the_frames_once_in_parallel(fake, client):
    """Fixes after the PM's first real test: the frames were fetched one by one, twice (about 20 s)."""
    first, second = shared_face_check()
    queue(fake, first, second)
    summary = run_ring(client, fake_analyse)
    assert (summary.claimed, summary.recorded) == (2, 2)
    # 13 frames for the liveness job; only the document for the face match (same captures, same SHA-256).
    assert len(fake.image_requests) == 13 + 1
    assert fake.image_requests[-1]["captureId"] == second[0]["inputs"][-1]["captureId"]
    for result in fake.results:
        assert set(result["timing"]) == {"ms", "cold", "fetchMs", "wallMs"}
        assert result["timing"]["wallMs"] >= result["timing"]["fetchMs"] >= 0


def test_a_cached_frame_is_reused_only_with_the_same_sha256(fake, client):
    first, second = shared_face_check()
    second[0]["inputs"][3]["sha256"] = "0" * 64  # another photo under the same id: fetched (and refused)
    queue(fake, first, second)
    summary = run_ring(client, fake_analyse)
    assert summary.recorded == 1 and summary.rejected == 1


def test_the_models_load_in_the_background_even_without_a_job(fake, client):
    calls = []
    summary = run_ring(client, fake_analyse, preload=lambda: calls.append("loaded"))
    assert summary.stopped == "no_job" and calls == ["loaded"]


def test_a_failed_preload_never_stops_the_ring(fake, client, logs):
    def broken():
        raise RuntimeError("no models")

    queue(fake, claim("liveness"))
    assert run_ring(client, fake_analyse, preload=broken).recorded == 1
    assert any("preload_failed" in line for line in logs)


def test_a_ring_processes_every_job_then_stops_on_204(fake, client):
    queue(fake, claim("liveness"), claim("face_match"))
    summary = run_ring(client, fake_analyse)
    assert (summary.claimed, summary.recorded, summary.stopped) == (2, 2, "no_job")
    assert [r["kind"] for r in fake.results] == ["liveness", "face_match"]
    # Each input fetched once, by the job's own id and attempt.
    assert len(fake.image_requests) == 13 + 14
    assert fake.refused == []


def test_an_input_gone_meanwhile_skips_the_job(fake, client):
    c, images = claim("liveness")
    images[c["inputs"][5]["captureId"]] = 410
    queue(fake, (c, images))
    summary = run_ring(client, fake_analyse)
    assert (summary.gone, summary.recorded) == (1, 0)
    # Fetched in parallel; nothing is analysed or sent for the job.
    assert len(fake.image_requests) == 13 and fake.results == []


def test_bytes_that_are_not_the_upload_are_never_decoded(fake, client, logs):
    c, images = claim("liveness")
    images[c["inputs"][2]["captureId"]] = FRAMES[3]  # another frame's bytes
    queue(fake, (c, images))
    summary = run_ring(client, fake_analyse)
    assert summary.rejected == 1 and fake.results == []
    assert "image_rejected.image_size_mismatch" in logs or "image_rejected.image_hash_mismatch" in logs


def test_a_face_match_for_a_real_session_is_refused_by_the_worker_too(fake, client, logs):
    queue(fake, claim("face_match", test_session=False))
    summary = run_ring(client, fake_analyse)
    assert summary.rejected == 1 and fake.results == []
    assert "job_refused.face_match_real_session" in logs


def test_a_malformed_claim_is_skipped_not_the_ring(fake, client):
    bad, _ = claim("liveness")
    bad["inputs"][0]["width"] = 4000
    queue(fake, (bad, {}), claim("liveness"))
    summary = run_ring(client, fake_analyse)
    assert (summary.rejected, summary.recorded) == (1, 1)


def test_an_api_error_stops_the_ring(fake, client):
    fake.claims.append(500)
    assert run_ring(client, fake_analyse).stopped == "claim_failed"


def test_a_result_for_a_superseded_job_is_gone(fake, client):
    fake.result_status = 410
    queue(fake, claim("liveness"))
    assert run_ring(client, fake_analyse).gone == 1


def test_the_window_closes_the_ring():
    ticks = iter([0.0, 100.0])

    class Never:
        def claim(self):
            raise AssertionError("no claim after the window")

    assert run_ring(Never(), fake_analyse, clock=lambda: next(ticks)).stopped == "window"


def test_logs_hold_event_codes_and_numbers_only(fake, client, logs):
    queue(fake, claim("liveness"))
    run_ring(client, fake_analyse)
    assert any(line.startswith("INFO job_done.liveness") or line.startswith("job_done.liveness") for line in logs)
    joined = " ".join(logs)
    assert "captureId" not in joined and "sha256" not in joined


@pytest.mark.parametrize(
    "mutate",
    [
        lambda c: c.update(kind="ocr"),
        lambda c: c.update(attempt=4),
        lambda c: c.update(actions=["dance"]),
        lambda c: c.update(testSession="yes"),
        lambda c: c["inputs"].append(dict(c["inputs"][0])),  # a repeated frame index
        lambda c: c["inputs"][0].update(byteSize=200_000),  # a frame over 100 KB
        lambda c: c["inputs"][0].update(role="selfie"),
        lambda c: c["inputs"][0].update(extra=1),
        lambda c: c.update(inputs=[]),
    ],
)
def test_validate_claim_refuses(mutate):
    c, _ = claim("liveness")
    mutate(c)
    with pytest.raises(WorkerApiError):
        validate_claim(c)


def test_validate_claim_needs_the_document_for_a_face_match_only():
    c, _ = claim("face_match")
    assert validate_claim(c) is c
    c["kind"] = "liveness"
    with pytest.raises(WorkerApiError):
        validate_claim(c)


def test_decode_input_checks_bytes_and_dimensions():
    item = spec("x", FRAMES[0], "frame", 0, 360, 480)
    assert decode_input(FRAMES[0], item).shape == (480, 360, 3)
    with pytest.raises(ImageRejected):
        decode_input(FRAMES[0], {**item, "width": 361})
    with pytest.raises(ImageRejected):
        decode_input(b"\xff\xd8 not a jpeg", {**item, "byteSize": 12, "sha256": hashlib.sha256(b"\xff\xd8 not a jpeg").hexdigest()})
    png = io.BytesIO()
    Image.new("RGB", (360, 480)).save(png, "PNG")
    data = png.getvalue()
    with pytest.raises(ImageRejected):
        decode_input(data, {**item, "byteSize": len(data), "sha256": hashlib.sha256(data).hexdigest()})


def test_config_from_the_environment():
    env = {"SUPABASE_FACE_URL": "https://ref.supabase.co/functions/v1/face", "SUPABASE_PUBLISHABLE_KEY": "pk",
           "FACE_WORKER_KEY_ID": "f1", "FACE_WORKER_SIGNING_KEY": SEED}
    assert isinstance(client_from_env(env), FaceClient)
    with pytest.raises(ConfigError):
        client_from_env({**env, "FACE_WORKER_SIGNING_KEY": ""})
    with pytest.raises(ConfigError):
        client_from_env({**env, "SUPABASE_FACE_URL": "http://ref.supabase.co/functions/v1/face"})

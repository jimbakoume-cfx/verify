"""The worker's loop against a stand-in Edge Function that verifies every signature."""

from __future__ import annotations

import hashlib
import io
import logging

import pytest
from PIL import Image

from fake_function import API_KEY, FakeFunction
from verify_worker import log
from verify_worker.client import WorkerApiError, WorkerClient, default_opener, validate_claim
from verify_worker.imaging import ImageRejected
from verify_worker.runner import ConfigError, client_from_env, run_ring
from verify_worker.signing import Signer, b64url_encode

SEED = b64url_encode(bytes(range(32)))
KID = "test-key"
JOB = "7b0c3c1e-1a59-4c55-9d40-2f6f2a0d9c1{}"


def jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (900, 570), (200, 190, 180)).save(buf, "JPEG")
    return buf.getvalue()


IMAGE = jpeg()


def claim(i: int, image: bytes = IMAGE) -> dict:
    return {
        "jobId": JOB.format(i),
        "attempt": 1,
        "captureId": "0a7f1f5e-5e2b-4f8a-9f53-0d0c4f9d2b10",
        "side": "document_front",
        "declaredDocument": "passport",
        "mrzExpectation": {"side": "document_front", "format": "TD3", "required": True},
        "image": {"sha256": hashlib.sha256(image).hexdigest(), "byteSize": len(image), "width": 900, "height": 570},
    }


def result_for(c: dict, data: bytes) -> dict:
    assert data == IMAGE
    return {"jobId": c["jobId"], "attempt": c["attempt"], "timing": {"ms": 1, "cold": False}, "quality": {"textLines": 0}, "classification": {"rotation": 0}}


@pytest.fixture
def signer() -> Signer:
    return Signer.from_seed(KID, SEED)


@pytest.fixture
def fake(signer):
    with FakeFunction(KID, signer.public_key_b64url()) as f:
        yield f


@pytest.fixture
def client(fake, signer) -> WorkerClient:
    return WorkerClient(fake.url, API_KEY, signer, opener=default_opener(proxies={}))


@pytest.fixture
def logs():
    records: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    log.configure()
    handler = Collect()
    logger = logging.getLogger("verify_worker")
    logger.addHandler(handler)
    yield records
    logger.removeHandler(handler)


def test_processes_jobs_until_none_are_left(fake, client, logs):
    fake.claims = [claim(1), claim(2)]
    fake.images = {JOB.format(1): IMAGE, JOB.format(2): IMAGE}
    summary = run_ring(client, result_for)
    assert (summary.claimed, summary.recorded, summary.stopped) == (2, 2, "no_job")
    assert fake.requests == ["/claim", "/image", "/result", "/claim", "/image", "/result", "/claim"]
    assert fake.refused == []
    assert [r["jobId"] for r in fake.results] == [JOB.format(1), JOB.format(2)]
    assert all(" " not in line.split(" ", 1)[0] for line in logs)


def test_no_job(fake, client):
    assert run_ring(client, result_for).stopped == "no_job"
    assert fake.requests == ["/claim"]


def test_a_photo_gone_meanwhile_is_skipped(fake, client):
    fake.claims = [claim(1), claim(2)]
    fake.images = {JOB.format(2): IMAGE}  # job 1: 410
    summary = run_ring(client, result_for)
    assert (summary.gone, summary.recorded) == (1, 1)


def test_a_lost_lease_is_skipped(fake, client):
    fake.claims = [claim(1)]
    fake.images = {JOB.format(1): 404}
    summary = run_ring(client, result_for)
    assert (summary.gone, summary.stopped) == (1, "no_job")


def test_a_result_for_a_superseded_photo_is_dropped(fake, client):
    fake.claims = [claim(1)]
    fake.images = {JOB.format(1): IMAGE}
    fake.result_status = 410
    summary = run_ring(client, result_for)
    assert (summary.gone, summary.recorded, summary.stopped) == (1, 0, "no_job")


def test_rejected_image_sends_no_result(fake, client, logs):
    fake.claims = [claim(1)]
    fake.images = {JOB.format(1): IMAGE}

    def reject(c, data):
        raise ImageRejected("image_hash_mismatch")

    summary = run_ring(client, reject)
    assert summary.rejected == 1 and fake.results == []
    assert "image_rejected.image_hash_mismatch" in logs


def test_a_malformed_claim_is_skipped_not_the_whole_ring(fake, client, logs):
    """A photo over the app's 1,600 px (uploaded before the server refused them) must not stop the
    ring: the jobs queued behind it are still processed."""
    oversized = claim(1)
    oversized["image"].update(width=2400, height=1800)
    fake.claims = [oversized, claim(2)]
    fake.images = {JOB.format(1): IMAGE, JOB.format(2): IMAGE}
    summary = run_ring(client, result_for)
    assert (summary.claimed, summary.rejected, summary.recorded, summary.stopped) == (2, 1, 1, "no_job")
    assert fake.requests == ["/claim", "/claim", "/image", "/result", "/claim"]
    assert [r["jobId"] for r in fake.results] == [JOB.format(2)]
    assert "claim_rejected" in logs


def test_only_malformed_claims_still_end_the_ring(fake, client):
    bad = claim(1)
    bad["image"].update(width=2400)
    fake.claims = [dict(bad) for _ in range(10)]
    summary = run_ring(client, result_for, max_jobs=3)
    assert (summary.claimed, summary.rejected, summary.stopped) == (3, 3, "max_jobs")
    assert fake.requests == ["/claim"] * 3


def test_server_error_on_claim_stops_the_ring(fake, client, logs):
    fake.claims = [500]
    summary = run_ring(client, result_for)
    assert summary.stopped == "claim_failed"
    assert any(line.startswith("claim_failed.server_error") for line in logs)


def test_wrong_key_is_refused_and_stops(fake):
    other = Signer.from_seed(KID, b64url_encode(bytes(32)))
    client = WorkerClient(fake.url, API_KEY, other, opener=default_opener(proxies={}))
    fake.claims = [claim(1)]
    summary = run_ring(client, result_for)
    assert summary.stopped == "claim_failed" and fake.refused == ["invalid_signature"]


def test_redirects_are_not_followed(fake, client):
    fake.redirect_claim = True
    with pytest.raises(WorkerApiError) as err:
        client.claim()
    assert err.value.status == 302
    assert fake.requests == ["/claim"]


def test_window_closes(fake, client):
    fake.claims = [claim(i) for i in range(5)]
    fake.images = {JOB.format(i): IMAGE for i in range(5)}
    ticks = iter([0, 10, 30, 51, 52, 53])
    summary = run_ring(client, result_for, window_s=50, clock=lambda: next(ticks))
    assert (summary.claimed, summary.stopped) == (2, "window")


def test_job_cap(fake, client):
    fake.claims = [claim(i) for i in range(5)]
    fake.images = {JOB.format(i): IMAGE for i in range(5)}
    assert run_ring(client, result_for, max_jobs=3).stopped == "max_jobs"


def test_nonces_are_never_reused(fake, client):
    fake.claims = [claim(1), claim(2)]
    fake.images = {JOB.format(1): IMAGE, JOB.format(2): IMAGE}
    run_ring(client, result_for)
    assert len(fake.nonces) == len(fake.requests)


@pytest.mark.parametrize(
    "change",
    [
        lambda c: c.pop("jobId"),
        lambda c: c.update(side="selfie"),
        lambda c: c.update(declaredDocument="library_card"),
        lambda c: c.update(attempt=True),
        lambda c: c["image"].update(sha256="xyz"),
        lambda c: c["image"].update(width=1601),
        lambda c: c["image"].update(byteSize=6 * 1024 * 1024),
        lambda c: c.update(mrzExpectation={"side": "document_front", "format": "TD2", "required": True}),
    ],
)
def test_malformed_claims_are_refused(change):
    c = claim(1)
    change(c)
    with pytest.raises(WorkerApiError):
        validate_claim(c)


def test_only_https_unless_loopback(signer):
    with pytest.raises(ValueError):
        WorkerClient("http://example.supabase.co/functions/v1/worker", API_KEY, signer)
    with pytest.raises(ValueError):
        WorkerClient("https://example.supabase.co/functions/v1/worker?x=1", API_KEY, signer)
    WorkerClient("https://example.supabase.co/functions/v1/worker", API_KEY, signer)


def test_settings_from_env():
    env = {"SUPABASE_WORKER_URL": "https://ref.supabase.co/functions/v1/worker", "SUPABASE_PUBLISHABLE_KEY": "pk", "WORKER_KEY_ID": KID, "WORKER_SIGNING_KEY": SEED}
    assert client_from_env(env).signer.kid == KID
    for missing in env:
        with pytest.raises(ConfigError) as err:
            client_from_env({k: v for k, v in env.items() if k != missing})
        assert err.value.code == "config_missing"
    with pytest.raises(ConfigError) as err:
        client_from_env({**env, "WORKER_SIGNING_KEY": "short"})
    assert err.value.code == "config_invalid"

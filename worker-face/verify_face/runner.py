"""What one ring of the face worker's doorbell does: claim and process face jobs until there are none,
or time is up. As the AI worker's ring (worker/verify_worker/runner.py): a ring carries no authority;
the worker asks the Edge Function for work with signed requests.
"""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from . import log
from .client import FaceClient, WorkerApiError
from .imaging import ImageRejected, decode_input
from .models import ModelIntegrityError
from .pipeline import NotAllowed
from .signing import Signer

# Claims start only within this window after the ring (the function may run 300 s; a face match with
# AuraFace loading takes a few seconds). The lease on a claimed job is 120 s.
CLAIM_WINDOW_S = 50.0
MAX_JOBS_PER_RING = 25
# Inputs fetched at once (fixes after the PM's first real test: 13 frames fetched one after the other took
# about 10 s of the rider's wait; each /image is a signed round trip of about 0.7 s).
FETCH_CONCURRENCY = 7
# The model preload a ring starts (a warm-up ring with no job loads the models, so that the ring that
# brings the face check finds them ready) is waited for at most this long before the ring answers.
PRELOAD_WAIT_S = 30.0

ENV_NAMES = ("SUPABASE_FACE_URL", "SUPABASE_PUBLISHABLE_KEY", "FACE_WORKER_KEY_ID", "FACE_WORKER_SIGNING_KEY")


class ConfigError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def client_from_env(env: dict[str, str] | None = None) -> FaceClient:
    env = dict(os.environ) if env is None else env
    if any(not env.get(name) for name in ENV_NAMES):
        raise ConfigError("config_missing")
    try:
        signer = Signer.from_seed(env["FACE_WORKER_KEY_ID"], env["FACE_WORKER_SIGNING_KEY"])
        return FaceClient(env["SUPABASE_FACE_URL"], env["SUPABASE_PUBLISHABLE_KEY"], signer)
    except ValueError as err:
        raise ConfigError("config_invalid") from err


@dataclass
class RingSummary:
    claimed: int = 0
    recorded: int = 0
    already_done: int = 0
    gone: int = 0
    rejected: int = 0
    stopped: str = "no_job"


@dataclass
class InputCache:
    """The decoded inputs of this ring, by capture id and SHA-256: a face check's liveness and face match
    jobs share their frames, so the second job fetches only its document (the frames were fetched, checked
    against their SHA-256 and audited for the first). Memory only, dropped when the ring ends."""

    images: dict[tuple[str, str], np.ndarray] = field(default_factory=dict)
    reused: int = 0

    def get(self, item: dict[str, Any]) -> np.ndarray | None:
        found = self.images.get((item["captureId"], item["sha256"]))
        if found is not None:
            self.reused += 1
        return found

    def put(self, item: dict[str, Any], rgb: np.ndarray) -> None:
        self.images[(item["captureId"], item["sha256"])] = rgb


def fetch_inputs(
    client: FaceClient,
    claim: dict[str, Any],
    cache: InputCache | None = None,
    concurrency: int = FETCH_CONCURRENCY,
) -> dict[str, np.ndarray] | None:
    """Every input of the job, decoded; None when one is gone (nothing to do for this job any more).
    Fetched in parallel; an input already in `cache` (same capture, same SHA-256) is not fetched again."""
    images: dict[str, np.ndarray] = {}
    missing = []
    for item in claim["inputs"]:
        cached = cache.get(item) if cache is not None else None
        if cached is not None:
            images[item["captureId"]] = cached
        else:
            missing.append(item)

    def one(item: dict[str, Any]) -> np.ndarray | None:
        data = client.image(claim["jobId"], claim["attempt"], item["captureId"])
        if data is None:
            return None
        try:
            return decode_input(data, item)
        finally:
            del data

    if missing:
        with ThreadPoolExecutor(max_workers=max(1, min(concurrency, len(missing)))) as pool:
            decoded = list(pool.map(one, missing))
        if any(rgb is None for rgb in decoded):
            return None
        for item, rgb in zip(missing, decoded):
            images[item["captureId"]] = rgb
            if cache is not None:
                cache.put(item, rgb)
    return images


def start_preload(preload: Callable[[], None] | None) -> threading.Thread | None:
    """Loads the models in the background while the ring claims and fetches (and on a warm-up ring)."""
    if preload is None:
        return None

    def run() -> None:
        try:
            preload()
        except Exception as err:  # noqa: BLE001 - a job loads the models again and reports any error itself
            log.event("preload_failed", error=err)

    thread = threading.Thread(target=run, name="face-preload", daemon=True)
    thread.start()
    return thread


def run_ring(
    client: FaceClient,
    analyse: Callable[[dict[str, Any], dict[str, np.ndarray]], dict[str, Any]],
    *,
    window_s: float = CLAIM_WINDOW_S,
    max_jobs: int = MAX_JOBS_PER_RING,
    clock: Callable[[], float] = time.monotonic,
    preload: Callable[[], None] | None = None,
) -> RingSummary:
    started = clock()
    summary = RingSummary()
    cache = InputCache()
    loading = start_preload(preload)
    try:
        _loop(client, analyse, summary, cache, started, window_s, max_jobs, clock)
    finally:
        cache.images.clear()
        if loading is not None:
            loading.join(PRELOAD_WAIT_S)
    return summary


def _loop(
    client: FaceClient,
    analyse: Callable[[dict[str, Any], dict[str, np.ndarray]], dict[str, Any]],
    summary: RingSummary,
    cache: InputCache,
    started: float,
    window_s: float,
    max_jobs: int,
    clock: Callable[[], float],
) -> None:
    while True:
        if clock() - started >= window_s:
            summary.stopped = "window"
            break
        if summary.claimed >= max_jobs:
            summary.stopped = "max_jobs"
            break
        try:
            claim = client.claim()
        except WorkerApiError as err:
            if err.code == "bad_claim":
                # Keeps its lease; the sweep retries it and gives up after the last attempt.
                log.event("claim_rejected")
                summary.claimed += 1
                summary.rejected += 1
                continue
            log.event(f"claim_failed.{err.code}", status=err.status or 0)
            summary.stopped = "claim_failed"
            break
        if claim is None:
            summary.stopped = "no_job"
            break
        summary.claimed += 1
        claimed_at = time.monotonic()
        try:
            images = fetch_inputs(client, claim, cache)
        except ImageRejected as err:
            log.event(f"image_rejected.{err.code}")
            summary.rejected += 1
            continue
        except WorkerApiError as err:
            log.event(f"image_failed.{err.code}", status=err.status or 0)
            summary.stopped = "image_failed"
            break
        if images is None:
            log.event("image_gone")
            summary.gone += 1
            continue
        fetch_ms = int(round((time.monotonic() - claimed_at) * 1000))
        try:
            result = analyse(claim, images)
        except NotAllowed as err:
            log.event(f"job_refused.{err}")
            summary.rejected += 1
            continue
        except ModelIntegrityError as err:
            log.event(f"models_invalid.{err.code}", error=err)
            summary.stopped = "models_invalid"
            break
        finally:
            del images
        # Wall-clock timings for the 10-second target (fixes after the PM's first real test).
        result["timing"] = {**result["timing"], "fetchMs": fetch_ms, "wallMs": int(round((time.monotonic() - claimed_at) * 1000))}
        try:
            outcome = client.result(result)
        except WorkerApiError as err:
            log.event(f"result_failed.{err.code}", status=err.status or 0)
            summary.stopped = "result_failed"
            break
        if outcome == "recorded":
            summary.recorded += 1
        elif outcome == "already_done":
            summary.already_done += 1
        else:
            log.event("result_gone")
            summary.gone += 1
            continue
        log.event(
            f"job_done.{claim['kind']}",
            ms=result["timing"]["ms"],
            cold=int(result["timing"]["cold"]),
            fetch_ms=result["timing"]["fetchMs"],
            wall_ms=result["timing"]["wallMs"],
            reused=cache.reused,
        )

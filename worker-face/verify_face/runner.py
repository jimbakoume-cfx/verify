"""What one ring of the face worker's doorbell does: claim and process face jobs until there are none,
or time is up. As the AI worker's ring (worker/verify_worker/runner.py): a ring carries no authority;
the worker asks the Edge Function for work with signed requests.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
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


def fetch_inputs(client: FaceClient, claim: dict[str, Any]) -> dict[str, np.ndarray] | None:
    """Every input of the job, decoded; None when one is gone (nothing to do for this job any more)."""
    images: dict[str, np.ndarray] = {}
    for item in claim["inputs"]:
        data = client.image(claim["jobId"], claim["attempt"], item["captureId"])
        if data is None:
            return None
        try:
            images[item["captureId"]] = decode_input(data, item)
        finally:
            del data
    return images


def run_ring(
    client: FaceClient,
    analyse: Callable[[dict[str, Any], dict[str, np.ndarray]], dict[str, Any]],
    *,
    window_s: float = CLAIM_WINDOW_S,
    max_jobs: int = MAX_JOBS_PER_RING,
    clock: Callable[[], float] = time.monotonic,
) -> RingSummary:
    started = clock()
    summary = RingSummary()
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
        try:
            images = fetch_inputs(client, claim)
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
        log.event(f"job_done.{claim['kind']}", ms=result["timing"]["ms"], cold=int(result["timing"]["cold"]))
    return summary

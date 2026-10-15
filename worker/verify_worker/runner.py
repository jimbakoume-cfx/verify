"""What one ring of the doorbell does: claim and process jobs until there are none, or time is up.

A ring (POST /api/process, empty body) carries no authority and no data: it only wakes the worker,
which then asks the Edge Function for work with signed requests. Anyone may ring; the worst they
can do is make the worker ask for jobs that do not exist (Vercel's firewall rate-limits rings).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Callable

from . import log
from .client import WorkerApiError, WorkerClient
from .imaging import ImageRejected
from .ocr import ModelIntegrityError
from .signing import Signer

# Claims start only within this window after the ring (the function may run 120 s; one job takes
# seconds, the first one longer while the models load). The lease on a claimed job is 120 s.
CLAIM_WINDOW_S = 50.0
# A safety net against a loop that never sees 204.
MAX_JOBS_PER_RING = 25


class ConfigError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def client_from_env(env: dict[str, str] | None = None) -> WorkerClient:
    """SUPABASE_WORKER_URL, SUPABASE_PUBLISHABLE_KEY, WORKER_KEY_ID and WORKER_SIGNING_KEY."""
    env = dict(os.environ) if env is None else env
    names = ("SUPABASE_WORKER_URL", "SUPABASE_PUBLISHABLE_KEY", "WORKER_KEY_ID", "WORKER_SIGNING_KEY")
    if any(not env.get(name) for name in names):
        raise ConfigError("config_missing")
    try:
        signer = Signer.from_seed(env["WORKER_KEY_ID"], env["WORKER_SIGNING_KEY"])
        return WorkerClient(env["SUPABASE_WORKER_URL"], env["SUPABASE_PUBLISHABLE_KEY"], signer)
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


def run_ring(
    client: WorkerClient,
    analyse: Callable[[dict[str, Any], bytes], dict[str, Any]],
    *,
    window_s: float = CLAIM_WINDOW_S,
    max_jobs: int = MAX_JOBS_PER_RING,
    clock: Callable[[], float] = time.monotonic,
) -> RingSummary:
    """Claims and processes jobs until a claim returns 204, the window closes, or the API fails."""
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
                # A job this worker will not process (a field out of range, such as a photo larger than
                # the app ever sends). It keeps its lease, so the next claim hands out other work: one
                # bad job must not hold up everyone else's. The sweep retries it and, after the last
                # attempt, staff see it unchecked. Counted as a claim, so max_jobs still bounds the loop.
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
            data = client.image(claim["jobId"], claim["attempt"])
        except WorkerApiError as err:
            log.event(f"image_failed.{err.code}", status=err.status or 0)
            summary.stopped = "image_failed"
            break
        if data is None:
            # Erased, retaken or superseded since it was claimed, or the lease ran out: nothing to do.
            log.event("image_gone")
            summary.gone += 1
            continue
        try:
            result = analyse(claim, data)
        except ImageRejected as err:
            # Not the uploaded JPEG: no result. The lease runs out, the sweep retries, and after the
            # last attempt the job fails and staff see "unchecked".
            log.event(f"image_rejected.{err.code}")
            summary.rejected += 1
            continue
        except ModelIntegrityError as err:
            log.event("models_invalid", error=err)
            summary.stopped = "models_invalid"
            break
        finally:
            del data
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
            "job_done",
            ms=result["timing"]["ms"],
            cold=int(result["timing"]["cold"]),
            lines=result["quality"]["textLines"],
            rotation=result["classification"]["rotation"],
        )
    return summary

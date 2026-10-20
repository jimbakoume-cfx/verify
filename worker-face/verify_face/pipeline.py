"""One face job, from its decoded inputs to the FaceResultRequest evidence.

liveness: every frame is measured (liveness.py). face_match: the document's portrait against the best
frame (facematch.py); AuraFace loads only then, and only once per process. Test sessions only for the
face match is enforced by the database (face jobs are never created or claimed otherwise); the claim's
testSession is checked again here, so a face_match claim for a real session is refused outright.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from . import ENGINE, facematch, liveness, models


class NotAllowed(Exception):
    """A claim this worker refuses to process (a face match for a real session)."""


def analyse(claim: dict[str, Any], images: dict[str, np.ndarray]) -> dict[str, Any]:
    """`images` maps each input's capture id to its RGB pixels (already checked against the claim)."""
    started = time.process_time()
    landmarker, load_s = models.landmarker()
    cold = load_s > 0
    frames = [
        liveness.Frame(item["index"], item["step"], images[item["captureId"]])
        for item in sorted((i for i in claim["inputs"] if i["role"] == "frame"), key=lambda i: i["index"])
    ]
    payload: dict[str, Any] = {
        "jobId": claim["jobId"],
        "attempt": claim["attempt"],
        "kind": claim["kind"],
        "engine": ENGINE,
        "liveness": None,
        "faceMatch": None,
    }
    if claim["kind"] == "liveness":
        payload["liveness"] = liveness.evaluate(frames, landmarker)
    else:
        if not claim["testSession"]:
            raise NotAllowed("face_match_real_session")
        document = next(i for i in claim["inputs"] if i["role"] == "document")
        frame_ids = {i["index"]: i["captureId"] for i in claim["inputs"] if i["role"] == "frame"}

        def recogniser() -> Any:
            nonlocal cold
            session, seconds = models.recogniser()
            cold = cold or seconds > 0
            return session

        payload["faceMatch"] = facematch.evaluate(images[document["captureId"]], frames, frame_ids, landmarker, recogniser)
    payload["timing"] = {"ms": int(round((time.process_time() - started) * 1000)), "cold": cold}
    return payload

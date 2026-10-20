"""One face job, from its decoded inputs to the FaceResultRequest evidence.

liveness: every frame is measured (liveness.py). face_match: the document's portrait against the best
frame (facematch.py); AuraFace loads only then, and only once per process. Test sessions only for the
face match is enforced by the database (face jobs are never created or claimed otherwise); the claim's
testSession is checked again here, so a face_match claim for a real session is refused outright.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any

import numpy as np

from . import ENGINE, facematch, liveness, models


class NotAllowed(Exception):
    """A claim this worker refuses to process (a face match for a real session)."""


# The faces found on each input, by its SHA-256: a face check's liveness and face match jobs run the face
# mesh on the same frames, so the second job reuses the first's (fixes after the PM's first real test).
# Memory only; a handful of face checks at most.
_FACES_CACHE: OrderedDict[tuple[str, int, bool], list[Any]] = OrderedDict()
FACES_CACHE_SIZE = 64


class CachedLandmarker:
    """The landmarker, remembering faces() of the job's inputs (by SHA-256); any other picture (the
    document's windows, crops) goes straight through."""

    def __init__(self, landmarker: Any, keys: dict[int, str]):
        self._landmarker = landmarker
        self._keys = keys

    def faces(self, rgb: np.ndarray, max_faces: int = 2, blendshapes: bool = True) -> list[Any]:
        sha = self._keys.get(id(rgb))
        if sha is None:
            return self._landmarker.faces(rgb, max_faces=max_faces, blendshapes=blendshapes)
        key = (sha, max_faces, blendshapes)
        if key in _FACES_CACHE:
            _FACES_CACHE.move_to_end(key)
            return _FACES_CACHE[key]
        found = self._landmarker.faces(rgb, max_faces=max_faces, blendshapes=blendshapes)
        _FACES_CACHE[key] = found
        while len(_FACES_CACHE) > FACES_CACHE_SIZE:
            _FACES_CACHE.popitem(last=False)
        return found

    def __getattr__(self, name: str) -> Any:
        return getattr(self._landmarker, name)


def analyse(claim: dict[str, Any], images: dict[str, np.ndarray]) -> dict[str, Any]:
    """`images` maps each input's capture id to its RGB pixels (already checked against the claim)."""
    started = time.process_time()
    loaded, load_s = models.landmarker()
    cold = load_s > 0
    landmarker = CachedLandmarker(loaded, {id(images[i["captureId"]]): i["sha256"] for i in claim["inputs"] if "sha256" in i})
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

"""The liveness job: measures on each frame of a face check, sent as evidence to the Edge Function,
which decides (supabase/functions/face/decide.ts). Nothing here judges.

Per frame (FaceFrameMeasure in contract.ts): how many faces; for the main face its pose, eye openness
and blink score, smile score and mouth width, size and position; the two geometry tests against the
reference frame (planar residual: is it a flat plane? shape distance: is it the same face?); and the
provisional passive cues (spoof.py). The reference is the first frame with exactly one face taken
before the actions start (step 0), else the first frame with exactly one face.

No landmark, no crop and no pixel leaves the worker: only these numbers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from . import geometry, spoof
from .landmarks import Face


@dataclass(frozen=True)
class Frame:
    index: int
    step: int
    rgb: np.ndarray


def _round(value: float | None, digits: int = 4) -> float | None:
    return None if value is None or not np.isfinite(value) else round(float(value), digits)


def main_face(faces: list[Face]) -> Face | None:
    """The largest face (by interocular distance): the person in front of the camera."""
    return max(faces, key=lambda f: geometry.interocular(f.points), default=None)


def frame_measure(frame: Frame, faces: list[Face], reference: Face | None) -> dict[str, Any]:
    face = main_face(faces)
    height, width = frame.rgb.shape[:2]
    measure: dict[str, Any] = {
        "index": frame.index,
        "faces": min(len(faces), 2),
        "yaw": None, "pitch": None, "roll": None,
        "blink": None, "eyeOpenness": None, "smile": None, "mouthWidth": None,
        "faceSize": None, "centerX": None, "centerY": None,
        "planarResidual": None, "shapeDistance": None,
        "moire": None, "glare": None, "detail": None,
    }
    if face is None:
        return measure
    yaw, pitch, roll = geometry.head_pose(face.points)
    bs = face.blendshapes
    x, y, w, h = face.detection.box
    measure.update({
        "yaw": _round(yaw, 2), "pitch": _round(pitch, 2), "roll": _round(roll, 2),
        "blink": _round((bs.get("eyeBlinkLeft", 0.0) + bs.get("eyeBlinkRight", 0.0)) / 2),
        "eyeOpenness": _round(geometry.eye_aspect_ratio(face.points)),
        "smile": _round((bs.get("mouthSmileLeft", 0.0) + bs.get("mouthSmileRight", 0.0)) / 2),
        "mouthWidth": _round(geometry.mouth_width(face.points)),
        "faceSize": _round(geometry.interocular(face.points) / width),
        "centerX": _round((x + w / 2) / width), "centerY": _round((y + h / 2) / height),
    })
    if reference is not None:
        measure["planarResidual"] = _round(geometry.planar_residual(reference.points, face.points), 5)
        measure["shapeDistance"] = _round(geometry.shape_distance(reference.points, face.points), 5)
    measure.update(spoof.measure(frame.rgb, face.detection.box))
    return measure


def choose_reference(frames: list[Frame], faces: list[list[Face]]) -> int | None:
    """Position (in `frames`) of the reference frame, or None when no frame has exactly one face."""
    single = [i for i, found in enumerate(faces) if len(found) == 1]
    before_actions = [i for i in single if frames[i].step == 0]
    if before_actions:
        return before_actions[0]
    return single[0] if single else None


def evaluate(frames: list[Frame], landmarker: Any) -> dict[str, Any]:
    """FaceLivenessEvidence for frames in index order."""
    faces = [landmarker.faces(frame.rgb, max_faces=2) for frame in frames]
    ref_pos = choose_reference(frames, faces)
    reference = faces[ref_pos][0] if ref_pos is not None else None
    return {
        "referenceIndex": frames[ref_pos].index if ref_pos is not None else None,
        "frames": [frame_measure(frame, found, reference) for frame, found in zip(frames, faces)],
    }

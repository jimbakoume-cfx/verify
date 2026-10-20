"""The face_match job: the ID portrait on the document photo against the best frame of the face check.

1. The portrait: BlazeFace runs on the whole document photo and on overlapping windows of it (the
   portrait is small: a card photographed at 1,280 px gives a face about 100 px wide, too small for
   the short-range detector on the whole picture). The largest confident face is the portrait; a
   smaller one (the "ghost" portrait of the new cards and passports) is only counted.
2. The selfie: every frame is analysed; the best one has exactly one face, looks straight at the
   camera with its eyes open, and is the largest.
3. Both faces are aligned on the 5 points of the ArcFace template (eyes, nose tip, mouth corners, from
   the face mesh; from the detector's keypoints when the mesh does not take, method "detector"), cut
   to 112 x 112 and embedded by AuraFace's glintr100. The similarity is the cosine of the two
   512-number embeddings.

Sent back (FaceMatchEvidence): the similarity, which frame was used, where each face is (boxes as
fractions of their image), sizes and methods. **Never the embeddings**: they are biometric templates
(PLAN.md Q4), computed in memory and dropped with the job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

from . import geometry
from .landmarks import Detection, Face, _iou
from .liveness import Frame

# ArcFace's 112 x 112 alignment template (InsightFace, arcface_dst; the numbers are a geometric
# convention, not a model).
TEMPLATE = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
])
ALIGNED_SIZE = 112
# Windows of the document photo searched for the portrait, as fractions of its short side.
WINDOW_FRACTIONS = (1.0, 0.75, 0.5, 0.35)
PORTRAIT_MIN_SCORE = 0.6
# The document's own faces are counted when this confident.
COUNT_MIN_SCORE = 0.7


@dataclass(frozen=True)
class FoundFace:
    detection: Detection
    face: Face | None

    @property
    def method(self) -> str:
        return "mesh" if self.face is not None else "detector"

    def five_points(self) -> np.ndarray:
        if self.face is not None:
            return geometry.five_points(self.face.points)
        kp = self.detection.keypoints
        mouth = kp[3]
        # No mouth corners from the detector: put them where the template has them around its centre.
        half = (TEMPLATE[4] - TEMPLATE[3]) / 2 * (np.linalg.norm(kp[1] - kp[0]) / np.linalg.norm(TEMPLATE[1] - TEMPLATE[0]))
        return np.stack([kp[0], kp[1], kp[2], mouth - half, mouth + half])


def windows(width: int, height: int) -> list[tuple[int, int, int]]:
    """(x, y, side) squares covering the image at each WINDOW_FRACTIONS size, half-overlapping."""
    short = min(width, height)
    out: list[tuple[int, int, int]] = [(0, 0, max(width, height))]
    for fraction in WINDOW_FRACTIONS[1:]:
        side = max(32, int(short * fraction))
        step = max(1, side // 2)
        xs = list(range(0, max(1, width - side) + 1, step)) or [0]
        ys = list(range(0, max(1, height - side) + 1, step)) or [0]
        if xs[-1] != max(0, width - side):
            xs.append(max(0, width - side))
        if ys[-1] != max(0, height - side):
            ys.append(max(0, height - side))
        out += [(x, y, side) for y in ys for x in xs]
    return out


def detect_document_faces(rgb: np.ndarray, landmarker: Any) -> list[Detection]:
    """Every face on the document photo, best first, after merging the windows' detections."""
    height, width = rgb.shape[:2]
    found: list[Detection] = []
    for x, y, side in windows(width, height):
        tile = rgb[y:y + side, x:x + side]
        for d in landmarker.detect(tile, PORTRAIT_MIN_SCORE):
            bx, by, bw, bh = d.box
            found.append(Detection(d.score, (bx + x, by + y, bw, bh), d.keypoints + np.array([x, y])))
    found.sort(key=lambda d: -d.score)
    kept: list[Detection] = []
    for d in found:
        box = np.array([d.box[0], d.box[1], d.box[0] + d.box[2], d.box[1] + d.box[3]])
        if kept:
            others = np.array([[k.box[0], k.box[1], k.box[0] + k.box[2], k.box[1] + k.box[3]] for k in kept])
            if (_iou(box, others) > 0.3).any():
                continue
        kept.append(d)
    return kept


def find_portrait(rgb: np.ndarray, landmarker: Any) -> tuple[FoundFace | None, int]:
    """(the portrait, how many confident faces the document shows)."""
    detections = detect_document_faces(rgb, landmarker)
    confident = [d for d in detections if d.score >= COUNT_MIN_SCORE]
    if not detections:
        return None, 0
    best = max(detections, key=lambda d: d.box[2] * d.box[3] * d.score)
    return FoundFace(best, landmarker.landmarks(rgb, best, blendshapes=False)), len(confident)


def selfie_score(face: Face, width: int) -> float:
    """Higher is better: straight at the camera, eyes open, large."""
    yaw, pitch, _ = geometry.head_pose(face.points)
    blink = (face.blendshapes.get("eyeBlinkLeft", 0.0) + face.blendshapes.get("eyeBlinkRight", 0.0)) / 2
    size = geometry.interocular(face.points) / width
    return -abs(yaw) - abs(pitch) - 40.0 * blink + 100.0 * min(size, 0.3)


def best_selfie(frames: list[Frame], landmarker: Any) -> tuple[Frame | None, Face | None]:
    best: tuple[float, Frame, Face] | None = None
    for frame in frames:
        faces = landmarker.faces(frame.rgb, max_faces=2)
        if len(faces) != 1:
            continue
        score = selfie_score(faces[0], frame.rgb.shape[1])
        if best is None or score > best[0]:
            best = (score, frame, faces[0])
    return (best[1], best[2]) if best else (None, None)


def align(rgb: np.ndarray, points: np.ndarray) -> np.ndarray:
    """The face warped so that its 5 points sit on the template, 112 x 112 RGB."""
    s, r, t = geometry.umeyama(points, TEMPLATE)
    forward = np.eye(3)
    forward[:2, :2] = s * r
    forward[:2, 2] = t
    inverse = np.linalg.inv(forward)
    # Pillow maps output pixel centres to input points with the inverse transform.
    coeffs = (inverse[0, 0], inverse[0, 1], inverse[0, 2], inverse[1, 0], inverse[1, 1], inverse[1, 2])
    out = Image.fromarray(rgb).transform((ALIGNED_SIZE, ALIGNED_SIZE), Image.AFFINE, coeffs, resample=Image.BILINEAR)
    return np.asarray(out)


def embed(aligned: np.ndarray, session: Any) -> np.ndarray:
    """AuraFace's 512-number embedding of an aligned face, L2-normalised (kept in memory only)."""
    tensor = ((aligned.astype(np.float32) - 127.5) / 127.5).transpose(2, 0, 1)[None]
    vector = session.run(None, {session.get_inputs()[0].name: tensor})[0][0].astype(np.float64)
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 0 else vector


def _box(detection: Detection, width: int, height: int) -> list[float]:
    x, y, w, h = detection.box
    x0, y0 = max(0.0, x / width), max(0.0, y / height)
    x1, y1 = min(1.0, (x + w) / width), min(1.0, (y + h) / height)
    return [round(x0, 4), round(y0, 4), round(max(0.0, x1 - x0), 4), round(max(0.0, y1 - y0), 4)]


def evaluate(document: np.ndarray, frames: list[Frame], frame_ids: dict[int, str], landmarker: Any, recogniser: Any) -> dict[str, Any]:
    """FaceMatchEvidence. `frame_ids` maps a frame's index to its capture id. `recogniser` is a
    callable returning the AuraFace session, so it is loaded only when both faces were found."""
    portrait, faces_on_document = find_portrait(document, landmarker)
    frame, selfie = best_selfie(frames, landmarker)
    dh, dw = document.shape[:2]
    evidence: dict[str, Any] = {
        "portrait": {
            "found": portrait is not None,
            "faces": faces_on_document,
            "box": _box(portrait.detection, dw, dh) if portrait else None,
            "faceSize": round(float(np.linalg.norm(portrait.five_points()[1] - portrait.five_points()[0])), 1) if portrait else None,
            "method": portrait.method if portrait else None,
            "detectionScore": round(portrait.detection.score, 4) if portrait else None,
        },
        "selfie": {
            "captureId": frame_ids.get(frame.index) if frame else None,
            "frameIndex": frame.index if frame else None,
            "found": selfie is not None,
            "box": None, "faceSize": None, "yaw": None, "pitch": None,
        },
        "similarity": None,
    }
    if frame is not None and selfie is not None:
        fh, fw = frame.rgb.shape[:2]
        yaw, pitch, _ = geometry.head_pose(selfie.points)
        evidence["selfie"].update({
            "box": _box(selfie.detection, fw, fh),
            "faceSize": round(geometry.interocular(selfie.points), 1),
            "yaw": round(yaw, 2), "pitch": round(pitch, 2),
        })
    if portrait is not None and selfie is not None and frame is not None:
        session = recogniser()
        a = embed(align(document, portrait.five_points()), session)
        b = embed(align(frame.rgb, geometry.five_points(selfie.points)), session)
        evidence["similarity"] = round(float(np.clip(a @ b, -1.0, 1.0)), 4)
        del a, b
    return evidence

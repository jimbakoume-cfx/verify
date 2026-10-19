"""Measures taken from the 478 face landmarks: head pose, eye openness, mouth width, and the two
geometry tests of the liveness check (is the face a flat plane? is it the same face?).

Pure numpy on landmark arrays (x, y in pixels with y down; z in pixels, smaller nearer the camera),
so every rule is tested on synthetic landmarks made from MediaPipe's canonical face model, without
any model or any real face.

Conventions (the Edge Function's decisions rely on them, contract.ts "Face worker API"):
- yaw: degrees, positive when the nose points towards the image's right. The frames are the camera's
  own picture (the rider app mirrors only its preview), so a rider turning to their own left turns
  towards the image's right: positive yaw.
- pitch: degrees, positive when the face looks up.
- roll: degrees, positive when the face tilts counter-clockwise in the image.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

# -- Landmark indices (MediaPipe Face Mesh) ---------------------------------------------------------
NOSE_TIP = 1
# The eye seen on the image's left (the subject's right eye) and on the image's right.
EYE_IMAGE_LEFT = {"outer": 33, "inner": 133, "top": (160, 158), "bottom": (144, 153)}
EYE_IMAGE_RIGHT = {"outer": 263, "inner": 362, "top": (387, 385), "bottom": (373, 380)}
MOUTH_LEFT, MOUTH_RIGHT = 61, 291
# Points that move with the skull, not with the expression (nose, forehead, cheekbones, temples, eye
# corners): the flat-plane and same-face tests use only these. They span the face's depth: the nose
# tip stands about 7 cm in front of the temples on the canonical model.
RIGID = (
    1, 4, 5, 6, 168, 197, 195, 2, 98, 327,  # nose bridge and tip, nostrils
    10, 151, 9, 108, 337, 67, 297,  # forehead
    234, 454, 127, 356, 162, 389,  # face sides, temples
    50, 280, 123, 352, 205, 425, 116, 345,  # cheeks
    33, 133, 263, 362,  # eye corners
)

_DATA = Path(__file__).resolve().parent / "data" / "canonical_face.json"


@lru_cache(maxsize=1)
def canonical_face() -> np.ndarray:
    """MediaPipe's canonical face model (468 points, centimetres, y up, z towards the viewer), from
    face_landmarker.task's geometry metadata (Apache-2.0)."""
    return np.asarray(json.loads(_DATA.read_text(encoding="utf-8")), dtype=np.float64)


def to_model_frame(points: np.ndarray) -> np.ndarray:
    """Image landmarks to the canonical model's axes: x right, y up, z towards the camera."""
    out = np.asarray(points, dtype=np.float64)[:, :3].copy()
    out[:, 1] = -out[:, 1]
    out[:, 2] = -out[:, 2]
    return out


def umeyama(src: np.ndarray, dst: np.ndarray, *, scale: bool = True) -> tuple[float, np.ndarray, np.ndarray]:
    """The similarity (s, R, t) minimising |dst - (s R src + t)|, R a proper rotation (Umeyama 1991).
    Works in any dimension (2-D for alignment, 3-D for pose)."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    mu_s, mu_d = src.mean(axis=0), dst.mean(axis=0)
    a, b = src - mu_s, dst - mu_d
    cov = b.T @ a / len(src)
    u, d, vt = np.linalg.svd(cov)
    sign = np.eye(src.shape[1])
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[-1, -1] = -1
    r = u @ sign @ vt
    var = (a ** 2).sum() / len(src)
    s = float(np.trace(np.diag(d) @ sign) / var) if scale and var > 0 else 1.0
    t = mu_d - s * r @ mu_s
    return s, r, t


def head_pose(points: np.ndarray) -> tuple[float, float, float]:
    """(yaw, pitch, roll) in degrees: the rotation that best aligns the canonical model with the
    face's 468 mesh points."""
    observed = to_model_frame(points[:468])
    _, r, _ = umeyama(canonical_face(), observed)
    forward = r @ np.array([0.0, 0.0, 1.0])
    right = r @ np.array([1.0, 0.0, 0.0])
    yaw = math.degrees(math.atan2(forward[0], forward[2]))
    pitch = math.degrees(math.atan2(forward[1], math.hypot(forward[0], forward[2])))
    # Roll: how far the face's left-right axis turns about its forward axis away from the horizontal.
    level = np.cross(np.array([0.0, 1.0, 0.0]), forward)
    norm = np.linalg.norm(level)
    if norm < 1e-9:
        return yaw, pitch, 0.0
    level /= norm
    up = np.cross(forward, level)
    roll = math.degrees(math.atan2(float(right @ up), float(right @ level)))
    return yaw, pitch, roll


def interocular(points: np.ndarray) -> float:
    """Distance between the outer eye corners, in pixels (the face's scale for every ratio here)."""
    return float(np.linalg.norm(points[EYE_IMAGE_LEFT["outer"], :2] - points[EYE_IMAGE_RIGHT["outer"], :2]))


def eye_aspect_ratio(points: np.ndarray) -> float:
    """Mean eye aspect ratio of both eyes (Soukupová and Čech 2016): eyelid opening over eye width.
    About 0.25-0.35 open, under 0.15 closed."""
    ratios = []
    for eye in (EYE_IMAGE_LEFT, EYE_IMAGE_RIGHT):
        width = np.linalg.norm(points[eye["outer"], :2] - points[eye["inner"], :2])
        opening = sum(np.linalg.norm(points[t, :2] - points[b, :2]) for t, b in zip(eye["top"], eye["bottom"]))
        ratios.append(opening / (2 * width) if width > 0 else 0.0)
    return float(np.mean(ratios))


def mouth_width(points: np.ndarray) -> float:
    """Distance between the mouth corners over the interocular distance (wider when smiling)."""
    iod = interocular(points)
    return float(np.linalg.norm(points[MOUTH_LEFT, :2] - points[MOUTH_RIGHT, :2]) / iod) if iod > 0 else 0.0


def five_points(points: np.ndarray) -> np.ndarray:
    """The 5 points of ArcFace-style alignment, in the template's order: the eye on the image's left,
    the eye on the image's right, the nose tip, the mouth corner on the left, on the right."""
    def centre(eye: dict) -> np.ndarray:
        return (points[eye["outer"], :2] + points[eye["inner"], :2]) / 2

    return np.stack([centre(EYE_IMAGE_LEFT), centre(EYE_IMAGE_RIGHT), points[NOSE_TIP, :2],
                     points[MOUTH_LEFT, :2], points[MOUTH_RIGHT, :2]])


def _homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares homography (normalised DLT) mapping src to dst (n x 2 each, n >= 4)."""
    def normaliser(p: np.ndarray) -> np.ndarray:
        mean = p.mean(axis=0)
        spread = np.sqrt(((p - mean) ** 2).sum(axis=1)).mean() or 1.0
        k = math.sqrt(2) / spread
        return np.array([[k, 0, -k * mean[0]], [0, k, -k * mean[1]], [0, 0, 1]])

    ts, td = normaliser(src), normaliser(dst)
    s = (ts @ np.c_[src, np.ones(len(src))].T).T
    d = (td @ np.c_[dst, np.ones(len(dst))].T).T
    rows = []
    for (x, y, _), (u, v, _) in zip(s, d):
        rows.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        rows.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vt = np.linalg.svd(np.asarray(rows))
    h = vt[-1].reshape(3, 3)
    return np.linalg.inv(td) @ h @ ts


def planar_residual(reference: np.ndarray, frame: np.ndarray) -> float:
    """How far the rigid points of `frame` are from where a flat plane would put them: the RMS error
    of the best homography from the reference frame's rigid points, over the reference's interocular
    distance. A photo or a screen, however it is moved or tilted, is one plane: its image moves by a
    homography and the error stays at the landmark noise (about 0.01). A real head turning shows
    parallax (the nose moves against the cheeks and temples) that no homography explains."""
    src = reference[list(RIGID), :2]
    dst = frame[list(RIGID), :2]
    h = _homography(src, dst)
    mapped = (h @ np.c_[src, np.ones(len(src))].T).T
    mapped = mapped[:, :2] / mapped[:, 2:3]
    iod = interocular(reference)
    return float(np.sqrt(((mapped - dst) ** 2).sum(axis=1).mean()) / iod) if iod > 0 else float("inf")


def shape_distance(reference: np.ndarray, frame: np.ndarray) -> float:
    """How different the two faces' 3-D shapes are once pose and scale are removed: the RMS error of
    the best 3-D similarity between their rigid points, over the interocular distance. The same face
    in two poses stays near the landmark noise; another face (a cut to someone else) does not."""
    src = to_model_frame(reference[list(RIGID)])
    dst = to_model_frame(frame[list(RIGID)])
    s, r, t = umeyama(src, dst)
    fitted = (s * (r @ src.T)).T + t
    iod = interocular(frame)
    return float(np.sqrt(((fitted - dst) ** 2).sum(axis=1).mean()) / iod) if iod > 0 else float("inf")


# -- Synthetic faces for the tests (and nothing else) ----------------------------------------------
def render_canonical(
    yaw: float = 0.0,
    pitch: float = 0.0,
    roll: float = 0.0,
    *,
    size: int = 480,
    face_width: float = 180.0,
    distance_cm: float = 40.0,
    centre: tuple[float, float] | None = None,
    flat: bool = False,
    shape: np.ndarray | None = None,
) -> np.ndarray:
    """The canonical face (or `shape`) posed and projected through a pinhole camera, as 468 image
    landmarks (x, y, z in pixels). `flat=True` squashes it into a plane first: a printed photo."""
    model = canonical_face() if shape is None else np.asarray(shape, dtype=np.float64)
    model = model - model.mean(axis=0)
    if flat:
        model = model * np.array([1.0, 1.0, 0.0])
    # Positive pitch looks up: the nose rises (+y in the model's axes), so the rotation about x is -pitch.
    y, p, r = math.radians(yaw), math.radians(-pitch), math.radians(roll)
    ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    # A head: tilted up or down about its own left-right axis, turned about the vertical, then rolled.
    posed = (rz @ ry @ rx @ model.T).T
    width_cm = np.ptp(canonical_face()[:, 0])
    focal = face_width * distance_cm / width_cm
    depth = distance_cm - posed[:, 2]
    cx, cy = centre if centre is not None else (size / 2, size / 2)
    x = cx + focal * posed[:, 0] / depth
    yy = cy - focal * posed[:, 1] / depth
    z = -posed[:, 2] * focal / distance_cm
    return np.stack([x, yy, z], axis=1)

"""Face detection and the 478-point face mesh, with MediaPipe Face Landmarker's own models.

The models are the three files inside Google's `face_landmarker.task` (Apache-2.0, see NOTICE):
BlazeFace short-range (detection), Face Mesh V2 (478 landmarks) and Blendshapes V2 (52 expression
scores). They run on LiteRT (`ai-edge-litert`, the TensorFlow Lite runtime), not on the `mediapipe`
Python package: that package's single native library is 112 MB, which with AuraFace (261 MB) would not
fit in Vercel's 500 MB function limit (see README.md, "Bundle size"). This module is the same pipeline
as MediaPipe's graphs (face_detector_graph.cc, face_landmarks_detector_graph.cc,
face_blendshapes_graph.cc): letterboxed detection, SSD anchors and weighted non-maximum suppression,
a rotated square crop of 1.5 times the face box, then the landmarks projected back into the image.

Everything here is geometry on pixels in memory: no landmark ever leaves the worker (only the scores
derived from them, see liveness.py and facematch.py).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

# -- Detector (BlazeFace short range): face_detector_graph.cc ----------------------------------------
DETECTOR_SIZE = 128
NUM_ANCHORS = 896
MIN_DETECTION_SCORE = 0.5
MIN_SUPPRESSION_IOU = 0.3
SCORE_CLIP = 100.0
# Keypoints of a detection, in model order. "left"/"right" are the observer's, as MediaPipe says.
KEYPOINTS = ("eye_left", "eye_right", "nose_tip", "mouth_center", "ear_left", "ear_right")

# -- Landmarks (Face Mesh V2): face_landmarks_detector_graph.cc ----------------------------------------
LANDMARKS_SIZE = 256
NUM_LANDMARKS = 478
ROI_SCALE = 1.5
MIN_PRESENCE = 0.5

# -- Blendshapes V2: face_blendshapes_graph.cc ---------------------------------------------------------
BLENDSHAPE_LANDMARKS = (
    0, 1, 4, 5, 6, 7, 8, 10, 13, 14, 17, 21, 33, 37, 39,
    40, 46, 52, 53, 54, 55, 58, 61, 63, 65, 66, 67, 70, 78, 80,
    81, 82, 84, 87, 88, 91, 93, 95, 103, 105, 107, 109, 127, 132, 133,
    136, 144, 145, 146, 148, 149, 150, 152, 153, 154, 155, 157, 158, 159, 160,
    161, 162, 163, 168, 172, 173, 176, 178, 181, 185, 191, 195, 197, 234, 246,
    249, 251, 263, 267, 269, 270, 276, 282, 283, 284, 285, 288, 291, 293, 295,
    296, 297, 300, 308, 310, 311, 312, 314, 317, 318, 321, 323, 324, 332, 334,
    336, 338, 356, 361, 362, 365, 373, 374, 375, 377, 378, 379, 380, 381, 382,
    384, 385, 386, 387, 388, 389, 390, 397, 398, 400, 402, 405, 409, 415, 454,
    466, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477,
)
BLENDSHAPE_NAMES = (
    "_neutral", "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
    "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft",
    "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight",
    "jawForward", "jawLeft", "jawOpen", "jawRight", "mouthClose", "mouthDimpleLeft", "mouthDimpleRight",
    "mouthFrownLeft", "mouthFrownRight", "mouthFunnel", "mouthLeft", "mouthLowerDownLeft",
    "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker", "mouthRight",
    "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft",
    "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    "noseSneerLeft", "noseSneerRight",
)
# The scores the liveness checks use (the others are never computed into evidence).
USED_BLENDSHAPES = ("eyeBlinkLeft", "eyeBlinkRight", "mouthSmileLeft", "mouthSmileRight", "jawOpen")


@dataclass(frozen=True)
class Detection:
    """A face found by BlazeFace, in pixels of the analysed image."""

    score: float
    # x, y, width, height
    box: tuple[float, float, float, float]
    # 6 x 2, KEYPOINTS order
    keypoints: np.ndarray


@dataclass
class Face:
    """One face: its detection, the 478 landmarks (x, y in pixels; z in pixels at the face's scale,
    smaller is nearer the camera), the presence score and the blendshapes used here."""

    detection: Detection
    points: np.ndarray
    presence: float
    blendshapes: dict[str, float] = field(default_factory=dict)


def _sigmoid(x: np.ndarray | float) -> np.ndarray | float:
    return 1.0 / (1.0 + np.exp(-np.clip(np.asarray(x, dtype=np.float64), -SCORE_CLIP, SCORE_CLIP)))


def ssd_anchors() -> np.ndarray:
    """The detector's 896 anchor centres (x, y), normalised: SsdAnchorsCalculator with the short-range
    options (4 layers, strides 8, 16, 16, 16, fixed anchor size, one interpolated scale)."""
    strides = (8, 16, 16, 16)
    anchors: list[tuple[float, float]] = []
    layer = 0
    while layer < len(strides):
        # Layers that share a stride share one feature map: their anchors are emitted together.
        last = layer
        while last < len(strides) and strides[last] == strides[layer]:
            last += 1
        per_cell = 2 * (last - layer)  # aspect ratio 1.0 plus the interpolated scale, per layer
        size = math.ceil(DETECTOR_SIZE / strides[layer])
        for y in range(size):
            for x in range(size):
                for _ in range(per_cell):
                    anchors.append(((x + 0.5) / size, (y + 0.5) / size))
        layer = last
    out = np.asarray(anchors, dtype=np.float32)
    assert out.shape == (NUM_ANCHORS, 2)
    return out


_ANCHORS = ssd_anchors()


def letterbox(rgb: np.ndarray, size: int) -> tuple[np.ndarray, float, float, float]:
    """The image scaled to fit a size x size square, centred, zero-padded (keep_aspect_ratio).
    Returns the square and (scale, pad_x, pad_y) in pixels of the square."""
    h, w = rgb.shape[:2]
    scale = size / max(h, w)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = np.asarray(Image.fromarray(rgb).resize((nw, nh), Image.BILINEAR))
    out = np.zeros((size, size, 3), dtype=np.uint8)
    pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
    out[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
    return out, scale, float(pad_x), float(pad_y)


def _iou(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """IoU of box a (x0, y0, x1, y1) with boxes b (n x 4)."""
    x0 = np.maximum(a[0], b[:, 0])
    y0 = np.maximum(a[1], b[:, 1])
    x1 = np.minimum(a[2], b[:, 2])
    y1 = np.minimum(a[3], b[:, 3])
    inter = np.clip(x1 - x0, 0, None) * np.clip(y1 - y0, 0, None)
    area = lambda r: (r[..., 2] - r[..., 0]) * (r[..., 3] - r[..., 1])  # noqa: E731
    union = area(a) + area(b) - inter
    return np.where(union > 0, inter / np.maximum(union, 1e-12), 0.0)


def decode_detections(regressors: np.ndarray, scores: np.ndarray, min_score: float = MIN_DETECTION_SCORE) -> list[tuple[float, np.ndarray]]:
    """Raw outputs (896 x 16, 896) to (score, [x0, y0, x1, y1, kx0, ky0, ...]) in the 128-pixel
    square, after weighted non-maximum suppression (TensorsToDetections + NonMaxSuppression WEIGHTED)."""
    probs = _sigmoid(np.clip(scores.reshape(-1), -SCORE_CLIP, SCORE_CLIP))
    keep = np.nonzero(probs >= min_score)[0]
    if keep.size == 0:
        return []
    reg = regressors.reshape(NUM_ANCHORS, 16)[keep] / DETECTOR_SIZE
    anchors = _ANCHORS[keep]
    cx = reg[:, 0] + anchors[:, 0]
    cy = reg[:, 1] + anchors[:, 1]
    w, h = reg[:, 2], reg[:, 3]
    boxes = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)
    kps = reg[:, 4:16].reshape(-1, 6, 2) + anchors[:, None, :]
    data = np.concatenate([boxes, kps.reshape(-1, 12)], axis=1) * DETECTOR_SIZE
    order = np.argsort(-probs[keep], kind="stable")
    data, sc = data[order], probs[keep][order]
    out: list[tuple[float, np.ndarray]] = []
    remaining = np.arange(len(sc))
    while remaining.size:
        first = remaining[0]
        overlap = _iou(data[first, :4], data[remaining, :4]) > MIN_SUPPRESSION_IOU
        group = remaining[overlap]
        weights = sc[group]
        merged = (data[group] * weights[:, None]).sum(axis=0) / weights.sum()
        out.append((float(sc[first]), merged))
        remaining = remaining[~overlap]
    return out


class FaceLandmarker:
    """The three models on LiteRT, one thread (Vercel has one vCPU). `models` maps the member names of
    face_landmarker.task to their bytes (models.py checks them before they get here)."""

    def __init__(self, models: dict[str, bytes], threads: int = 1):
        from ai_edge_litert.interpreter import Interpreter

        def make(name: str):
            it = Interpreter(model_content=models[name], num_threads=threads)
            it.allocate_tensors()
            return it

        self._det = make("face_detector.tflite")
        self._lm = make("face_landmarks_detector.tflite")
        self._bs = make("face_blendshapes.tflite")
        self._det_in = self._det.get_input_details()[0]["index"]
        outs = {tuple(d["shape"]): d["index"] for d in self._det.get_output_details()}
        self._det_reg, self._det_score = outs[(1, NUM_ANCHORS, 16)], outs[(1, NUM_ANCHORS, 1)]
        self._lm_in = self._lm.get_input_details()[0]["index"]
        lm_outs = {tuple(d["shape"]): d["index"] for d in self._lm.get_output_details()}
        # Landmarks, then the face presence flag (the third output is not used by MediaPipe either).
        self._lm_points, self._lm_presence = lm_outs[(1, 1, 1, NUM_LANDMARKS * 3)], lm_outs[(1, 1, 1, 1)]
        self._bs_in = self._bs.get_input_details()[0]["index"]
        self._bs_out = self._bs.get_output_details()[0]["index"]

    # -- detection ---------------------------------------------------------------------------------
    def detect(self, rgb: np.ndarray, min_score: float = MIN_DETECTION_SCORE) -> list[Detection]:
        square, scale, pad_x, pad_y = letterbox(rgb, DETECTOR_SIZE)
        tensor = (square.astype(np.float32) / 127.5 - 1.0)[None]
        self._det.set_tensor(self._det_in, tensor)
        self._det.invoke()
        found = decode_detections(self._det.get_tensor(self._det_reg)[0], self._det.get_tensor(self._det_score)[0], min_score)
        out = []
        for score, d in found:
            xs = (d[0::2] - pad_x) / scale
            ys = (d[1::2] - pad_y) / scale
            x0, x1, y0, y1 = xs[0], xs[1], ys[0], ys[1]
            kps = np.stack([xs[2:], ys[2:]], axis=1)
            out.append(Detection(score, (float(x0), float(y0), float(x1 - x0), float(y1 - y0)), kps))
        return out

    # -- landmarks ---------------------------------------------------------------------------------
    @staticmethod
    def roi(detection: Detection) -> tuple[float, float, float, float]:
        """(centre x, centre y, side, rotation in radians): the eyes level, 1.5 times the face box,
        square on its long side (DetectionsToRects + RectTransformation)."""
        x, y, w, h = detection.box
        (x0, y0), (x1, y1) = detection.keypoints[0], detection.keypoints[1]
        rotation = -math.atan2(-(y1 - y0), x1 - x0)
        rotation = (rotation + math.pi) % (2 * math.pi) - math.pi
        return x + w / 2, y + h / 2, max(w, h) * ROI_SCALE, rotation

    @staticmethod
    def crop(rgb: np.ndarray, cx: float, cy: float, side: float, rotation: float, size: int) -> np.ndarray:
        """The rotated square (centre, side, rotation) resampled to size x size (bilinear, zero outside)."""
        c, s = math.cos(rotation), math.sin(rotation)
        k = side / size
        # Pillow maps each output pixel centre p to the input point (a, b, tx; d, e, ty) . p, both in
        # continuous coordinates: the image point is centre + R * (p * k - side / 2).
        a, b = c * k, -s * k
        d, e = s * k, c * k
        tx = cx - (c - s) * side / 2
        ty = cy - (s + c) * side / 2
        img = Image.fromarray(rgb)
        out = img.transform((size, size), Image.AFFINE, (a, b, tx, d, e, ty), resample=Image.BILINEAR, fillcolor=(0, 0, 0))
        return np.asarray(out)

    def landmarks(self, rgb: np.ndarray, detection: Detection, blendshapes: bool = True) -> Face | None:
        cx, cy, side, rotation = self.roi(detection)
        patch = self.crop(rgb, cx, cy, side, rotation, LANDMARKS_SIZE)
        self._lm.set_tensor(self._lm_in, (patch.astype(np.float32) / 255.0)[None])
        self._lm.invoke()
        presence = float(_sigmoid(float(self._lm.get_tensor(self._lm_presence).reshape(-1)[0])))
        if presence < MIN_PRESENCE:
            return None
        raw = self._lm.get_tensor(self._lm_points).reshape(NUM_LANDMARKS, 3) / LANDMARKS_SIZE
        u, v = raw[:, 0] - 0.5, raw[:, 1] - 0.5
        c, s = math.cos(rotation), math.sin(rotation)
        points = np.empty((NUM_LANDMARKS, 3), dtype=np.float64)
        points[:, 0] = (c * u - s * v) * side + cx
        points[:, 1] = (s * u + c * v) * side + cy
        points[:, 2] = raw[:, 2] * side
        face = Face(detection, points, presence)
        if blendshapes:
            subset = points[list(BLENDSHAPE_LANDMARKS), :2].astype(np.float32)[None]
            self._bs.set_tensor(self._bs_in, subset)
            self._bs.invoke()
            scores = self._bs.get_tensor(self._bs_out).reshape(-1)
            face.blendshapes = {name: float(scores[BLENDSHAPE_NAMES.index(name)]) for name in USED_BLENDSHAPES}
        return face

    def faces(self, rgb: np.ndarray, max_faces: int = 2, blendshapes: bool = True) -> list[Face]:
        """Every face the detector finds (at most max_faces, best first) that the mesh confirms."""
        out = []
        for detection in self.detect(rgb)[:max_faces]:
            face = self.landmarks(rgb, detection, blendshapes)
            if face is not None:
                out.append(face)
        return out

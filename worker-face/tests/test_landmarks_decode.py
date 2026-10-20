"""The pipeline around Face Landmarker's models, without the models: anchors, decoding and weighted
non-maximum suppression, the letterbox, the rotated crop and its inverse (landmarks.py)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from verify_face import landmarks as lm
from verify_face.landmarks import Detection, FaceLandmarker


def test_anchors_are_the_896_short_range_centres():
    anchors = lm.ssd_anchors()
    assert anchors.shape == (896, 2)
    # 16 x 16 cells with 2 anchors each, then 8 x 8 cells with 6 each.
    assert np.allclose(anchors[0], [0.5 / 16, 0.5 / 16]) and np.allclose(anchors[1], anchors[0])
    assert np.allclose(anchors[512], [0.5 / 8, 0.5 / 8]) and np.allclose(anchors[517], anchors[512])
    assert np.allclose(anchors[-1], [7.5 / 8, 7.5 / 8])


def test_blendshape_subset_is_mediapipes():
    assert len(lm.BLENDSHAPE_LANDMARKS) == 146
    assert len(set(lm.BLENDSHAPE_LANDMARKS)) == 146
    assert len(lm.BLENDSHAPE_NAMES) == 52
    assert set(lm.USED_BLENDSHAPES) <= set(lm.BLENDSHAPE_NAMES)


def _raw(anchor: int, dx: float, dy: float, size: float, logit: float):
    reg = np.zeros((896, 16), dtype=np.float32)
    scores = np.full((896, 1), -10.0, dtype=np.float32)
    reg[anchor, :4] = [dx, dy, size, size]
    for k in range(6):
        reg[anchor, 4 + 2 * k] = dx + (k - 2.5) * 3
        reg[anchor, 5 + 2 * k] = dy
    scores[anchor] = logit
    return reg, scores


def test_decode_one_detection_in_the_128_pixel_square():
    anchors = lm.ssd_anchors()
    reg, scores = _raw(600, 4.0, -2.0, 40.0, 3.0)
    found = lm.decode_detections(reg, scores)
    assert len(found) == 1
    score, data = found[0]
    assert score == pytest.approx(1 / (1 + math.exp(-3.0)))
    cx, cy = anchors[600] * 128 + [4.0, -2.0]
    assert data[:4] == pytest.approx([cx - 20, cy - 20, cx + 20, cy + 20], abs=1e-3)


def test_weighted_nms_merges_overlapping_boxes_and_keeps_separate_ones():
    reg, scores = _raw(600, 0.0, 0.0, 40.0, 4.0)
    reg2, scores2 = _raw(601, 2.0, 0.0, 40.0, 2.0)  # same cell, shifted 2 px: one face
    reg3, scores3 = _raw(10, 0.0, 0.0, 20.0, 1.0)  # far away: another face
    for i in (601, 10):
        source = reg2 if i == 601 else reg3
        reg[i] = source[i]
        scores[i] = (scores2 if i == 601 else scores3)[i]
    found = lm.decode_detections(reg, scores)
    assert len(found) == 2
    (s1, d1), (s2, _) = found
    assert s1 > s2
    # Weighted by score: the merged box sits between the two, nearer the stronger one.
    stronger = lm.ssd_anchors()[600] * 128
    assert stronger[0] - 20 < d1[0] < stronger[0] - 20 + 2


def test_low_scores_are_dropped():
    reg, scores = _raw(100, 0, 0, 30, -1.0)
    assert lm.decode_detections(reg, scores) == []


def test_letterbox_keeps_the_aspect_ratio():
    rgb = np.full((480, 360, 3), 200, dtype=np.uint8)
    square, scale, pad_x, pad_y = lm.letterbox(rgb, 128)
    assert square.shape == (128, 128, 3)
    assert scale == pytest.approx(128 / 480)
    assert pad_y == 0 and pad_x == pytest.approx((128 - 96) / 2)
    assert square[:, : int(pad_x) - 1].max() == 0 and square[64, 64, 0] == 200


def test_roi_is_square_on_the_long_side_and_levels_the_eyes():
    eyes_level = Detection(0.9, (100, 100, 80, 60), np.array([[120, 130], [160, 130], [140, 150], [140, 170], [100, 140], [180, 140]], float))
    cx, cy, side, rotation = FaceLandmarker.roi(eyes_level)
    assert (cx, cy) == (140, 130)
    assert side == pytest.approx(80 * lm.ROI_SCALE)
    assert rotation == pytest.approx(0)
    tilted = Detection(0.9, (100, 100, 80, 80), np.array([[120, 120], [160, 160], [0, 0], [0, 0], [0, 0], [0, 0]], float))
    assert FaceLandmarker.roi(tilted)[3] == pytest.approx(math.pi / 4)


@pytest.mark.parametrize("rotation", [0.0, 0.5, -1.0])
def test_crop_samples_the_rotated_square(rotation):
    """A bright dot at a known offset from the centre lands where the rotated frame puts it."""
    rgb = np.zeros((400, 400, 3), dtype=np.uint8)
    cx, cy, side = 200.0, 210.0, 160.0
    # In the crop's frame the dot is at (+40, -20) from the centre.
    u, v = 40.0, -20.0
    c, s = math.cos(rotation), math.sin(rotation)
    x, y = cx + c * u - s * v, cy + s * u + c * v
    rgb[int(y) - 2:int(y) + 3, int(x) - 2:int(x) + 3] = 255
    crop = FaceLandmarker.crop(rgb, cx, cy, side, rotation, 64)
    ys, xs = np.nonzero(crop[:, :, 0] > 100)
    k = 64 / side
    assert xs.mean() == pytest.approx(32 + u * k, abs=1.2)
    assert ys.mean() == pytest.approx(32 + v * k, abs=1.2)

"""Quality measurements on whole photos (what the worker reports), and helpers' edge cases."""

from __future__ import annotations

import numpy as np
import pytest

from conftest import SPECIMENS
from verify_worker.imaging import decode_jpeg, to_gray
from verify_worker.quality import (
    Rect,
    analysis_image,
    estimate_noise,
    glare,
    guide_in_still,
    js_round,
    laplacian_detail,
    laplacian_variance,
    luma_stats,
    measure,
    pixel_bounds,
)


def gray_of(name: str) -> np.ndarray:
    return to_gray(decode_jpeg((SPECIMENS / name).read_bytes()).rgb)


def test_js_round_rounds_halves_up():
    assert [js_round(v) for v in (0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4999)] == [1, 2, 3, 0, -1, -2, 2]


def test_pixel_bounds_clamp_and_round():
    assert pixel_bounds(100, 50, Rect(-3.5, 2.5, 200, 10), 1) == (1, 3, 99, 13)
    assert pixel_bounds(100, 50, None) == (0, 0, 100, 50)
    # Like the TypeScript, a region outside the image is empty (its start is not clamped).
    assert pixel_bounds(100, 50, Rect(120, 60, 5, 5)) == (120, 60, 120, 60)


def test_analysis_image_is_480_wide():
    small = analysis_image(np.zeros((1009, 1600), dtype=np.uint8))
    assert small.shape == (303, 480)
    narrow = np.zeros((300, 400), dtype=np.uint8)
    assert analysis_image(narrow) is narrow


def test_guide_in_still():
    g = guide_in_still(1040, 520)
    assert (round(g.x), round(g.y), round(g.width), round(g.height)) == (20, 10, 1000, 500)


def test_flat_image():
    flat = np.full((60, 80), 120, dtype=np.uint8)
    assert laplacian_variance(flat) == 0
    assert laplacian_detail(flat) == 0
    # The median of an all-zero response is interpolated inside bin 0, as in the TypeScript.
    assert estimate_noise(flat) < 0.1
    assert luma_stats(flat) == (120.0, 0.0, 4800)
    assert glare(flat) == (0.0, 0.0)


def test_glare_hotspot_in_one_tile():
    img = np.full((80, 80), 100, dtype=np.uint8)
    img[0:10, 0:10] = 255
    ratio, worst = glare(img)
    assert ratio == pytest.approx(100 / 6400)
    assert worst > ratio


def test_empty_regions():
    img = np.full((10, 10), 100, dtype=np.uint8)
    empty = Rect(5, 5, 0, 0)
    assert laplacian_variance(img, empty) == 0
    assert luma_stats(img, empty) == (0.0, 0.0, 0)
    assert glare(img, empty) == (0.0, 0.0)


def test_clean_card():
    q = measure(gray_of("cni-old-front.jpg"))
    assert q.document_found and q.document_confidence == 1.0
    assert q.sharpness > 5  # the phone's minSharpness
    assert q.glare_ratio <= 0.02
    assert 50 <= q.mean_luma <= 225
    assert q.long_side == 1280


def test_no_document():
    q = measure(gray_of("no-document.jpg"))
    assert not q.document_found and q.document_confidence < 0.5


def test_glare_and_blur_are_measured():
    assert measure(gray_of("cni-old-front-glare.jpg")).glare_ratio > 0.02
    assert measure(gray_of("passport-cmr-blur.jpg")).sharpness < 5
    assert measure(gray_of("blank-card.jpg")).sharpness < 5

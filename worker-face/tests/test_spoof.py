"""The provisional passive cues (spoof.py) on drawn pictures: a pixel-grid pattern stands out as moire,
a blur loses detail, a blown-out patch is glare. No face needed: the cues are measured on a box."""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

from synthface import render, screen
from verify_face import spoof

BOX = (95.0, 120.0, 170.0, 190.0)


def face() -> np.ndarray:
    return render()


def test_moire_a_screen_stands_out_from_a_camera_picture():
    plain = spoof.measure(face(), BOX)["moire"]
    filmed = spoof.measure(screen(face()), BOX)["moire"]
    assert plain < 0.8
    assert filmed > 1.2  # face/decide.ts MOIRE_MIN is 1.0
    assert filmed > plain + 0.8


def test_moire_is_not_fooled_by_blur():
    blurred = np.asarray(Image.fromarray(face()).filter(ImageFilter.GaussianBlur(2.2)))
    assert spoof.measure(blurred, BOX)["moire"] < 0.8


def test_detail_a_blurred_print_loses_it():
    sharp = spoof.measure(face(), BOX)["detail"]
    printed = spoof.measure(np.asarray(Image.fromarray(face()).filter(ImageFilter.GaussianBlur(2.2))), BOX)["detail"]
    assert printed < 0.002 < sharp  # face/decide.ts LOW_DETAIL_MAX


def test_glare_counts_blown_out_pixels_only():
    picture = face().copy()
    assert spoof.measure(picture, BOX)["glare"] == 0
    picture[150:200, 150:220] = 250
    assert spoof.measure(picture, BOX)["glare"] > 0.04  # face/decide.ts SCREEN_GLARE_MIN


def test_measures_do_not_depend_on_the_distance():
    near = spoof.measure(render(face_width=220), (60.0, 100.0, 240.0, 260.0))
    far = spoof.measure(render(face_width=130), (115.0, 160.0, 130.0, 150.0))
    assert abs(near["detail"] - far["detail"]) < 0.02


def test_a_box_outside_the_picture_gives_zeros_not_errors():
    out = spoof.measure(face(), (-500.0, -500.0, 10.0, 10.0))
    assert out == {"moire": 0.0, "glare": 0.0, "detail": 0.0}

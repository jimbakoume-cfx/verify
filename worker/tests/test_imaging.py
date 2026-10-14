"""Decoding: only the uploaded JPEG, checked against the claim, within the rider app's sizes."""

from __future__ import annotations

import hashlib
import io

import numpy as np
import pytest
from PIL import Image

from conftest import SPECIMENS
from verify_worker.imaging import ImageRejected, check_bytes, decode_jpeg, rotate_clockwise, to_gray


def encode(img: Image.Image, fmt: str = "JPEG") -> bytes:
    buf = io.BytesIO()
    img.save(buf, fmt)
    return buf.getvalue()


def test_decodes_a_specimen():
    data = (SPECIMENS / "cni-new-back.jpg").read_bytes()
    check_bytes(data, hashlib.sha256(data).hexdigest(), len(data))
    img = decode_jpeg(data)
    assert img.rgb.dtype == np.uint8 and img.rgb.shape == (img.height, img.width, 3)
    assert max(img.width, img.height) == 1280


def test_bytes_must_match_the_claim():
    data = (SPECIMENS / "cni-new-back.jpg").read_bytes()
    with pytest.raises(ImageRejected) as err:
        check_bytes(data, hashlib.sha256(data).hexdigest(), len(data) + 1)
    assert err.value.code == "image_size_mismatch"
    with pytest.raises(ImageRejected) as err:
        check_bytes(data[:-1] + b"\x00", hashlib.sha256(data).hexdigest(), len(data))
    assert err.value.code == "image_hash_mismatch"


@pytest.mark.parametrize("fmt", ["PNG", "WEBP", "TIFF", "BMP", "GIF"])
def test_only_jpeg_is_decoded(fmt):
    data = encode(Image.new("RGB", (800, 500), (200, 200, 200)), fmt)
    with pytest.raises(ImageRejected) as err:
        decode_jpeg(data)
    assert err.value.code == "image_undecodable"


def test_garbage_is_refused():
    with pytest.raises(ImageRejected):
        decode_jpeg(b"\xff\xd8\xff\xe0 not really a jpeg")


def test_larger_than_the_rider_app_produces_is_refused():
    data = encode(Image.new("RGB", (1601, 900)))
    with pytest.raises(ImageRejected) as err:
        decode_jpeg(data)
    assert err.value.code == "image_dimensions"
    # A decompression bomb is refused before it is decoded.
    huge = encode(Image.new("L", (6000, 6000)))
    with pytest.raises(ImageRejected):
        decode_jpeg(huge)


def test_size_must_match_the_claim():
    data = encode(Image.new("RGB", (1000, 630)))
    assert decode_jpeg(data, 1000, 630).width == 1000
    with pytest.raises(ImageRejected) as err:
        decode_jpeg(data, 1000, 631)
    assert err.value.code == "image_dimensions_mismatch"


def test_grayscale_jpeg_becomes_rgb():
    data = encode(Image.new("L", (900, 600), 128))
    assert decode_jpeg(data).rgb.shape == (600, 900, 3)


def test_gray_uses_the_phone_weights():
    rgb = np.array([[[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [10, 20, 30]]], dtype=np.uint8)
    expected = [(77 * r + 150 * g + 29 * b + 128) >> 8 for r, g, b in rgb[0].tolist()]
    assert to_gray(rgb)[0].tolist() == expected


def test_rotation_is_clockwise():
    a = np.array([[1, 2], [3, 4]])
    assert rotate_clockwise(a, 90).tolist() == [[3, 1], [4, 2]]
    assert rotate_clockwise(a, 180).tolist() == [[4, 3], [2, 1]]
    assert rotate_clockwise(a, 270).tolist() == [[2, 4], [1, 3]]
    assert rotate_clockwise(a, 0) is a

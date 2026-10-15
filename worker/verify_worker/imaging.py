"""Decoding the photo safely, and the small image operations the pipeline shares.

The bytes come from the Edge Function, which relays what the rider uploaded. They are checked
against the claim (size and SHA-256 recorded at upload) before any decoder sees them, and only
Pillow's JPEG decoder may open them: the other formats Pillow and OpenCV understand (TIFF, WebP,
AVIF, JPEG 2000...) are attack surface we do not need. Nothing is written to disk.
"""

from __future__ import annotations

import hashlib
import io
import warnings
from dataclasses import dataclass

import numpy as np
from PIL import Image

from .contract import MAX_CAPTURE_BYTES, MAX_LONG_SIDE

# The rider app never uploads a longer side than this, so a larger image is not one of ours. Pillow
# only warns between MAX_IMAGE_PIXELS and twice that, and raises above: the warning is made an error
# below, so the bound holds exactly.
Image.MAX_IMAGE_PIXELS = MAX_LONG_SIDE * MAX_LONG_SIDE


class ImageRejected(Exception):
    """The bytes are not the expected JPEG; `code` says why (logged, never the bytes)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class DecodedImage:
    """RGB pixels, row-major, as decoded from the JPEG (EXIF orientation is ignored: the rider app
    draws its photos on a canvas, which writes none, and the rotation is worked out from the text)."""

    rgb: np.ndarray

    @property
    def width(self) -> int:
        return int(self.rgb.shape[1])

    @property
    def height(self) -> int:
        return int(self.rgb.shape[0])


def check_bytes(data: bytes, expected_sha256: str, expected_size: int) -> None:
    """The bytes must be exactly what was uploaded: same length, same SHA-256."""
    if len(data) > MAX_CAPTURE_BYTES:
        raise ImageRejected("image_too_large")
    if len(data) != expected_size:
        raise ImageRejected("image_size_mismatch")
    if hashlib.sha256(data).hexdigest() != expected_sha256.lower():
        raise ImageRejected("image_hash_mismatch")


def decode_jpeg(data: bytes, expected_width: int | None = None, expected_height: int | None = None) -> DecodedImage:
    """Decodes a baseline or progressive JPEG to RGB. Refuses anything else, anything larger than the
    rider app produces, and an image whose size differs from the one recorded at upload."""
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with Image.open(io.BytesIO(data), formats=["JPEG"]) as im:
                width, height = im.size
                if width < 1 or height < 1 or max(width, height) > MAX_LONG_SIDE:
                    raise ImageRejected("image_dimensions")
                if expected_width is not None and (width, height) != (expected_width, expected_height):
                    raise ImageRejected("image_dimensions_mismatch")
                rgb = np.asarray(im.convert("RGB"), dtype=np.uint8)
        except ImageRejected:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as err:
            raise ImageRejected("image_dimensions") from err
        except Exception as err:  # Pillow raises many types for a broken file; all mean the same here.
            raise ImageRejected("image_undecodable") from err
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ImageRejected("image_undecodable")
    return DecodedImage(np.ascontiguousarray(rgb))


def to_gray(rgb: np.ndarray) -> np.ndarray:
    """Rec. 601 luma with the rider app's integer weights (packages/capture toGray): 77/150/29 of 256."""
    r = rgb[:, :, 0].astype(np.uint32)
    g = rgb[:, :, 1].astype(np.uint32)
    b = rgb[:, :, 2].astype(np.uint32)
    return ((77 * r + 150 * g + 29 * b + 128) >> 8).astype(np.uint8)


def rotate_clockwise(pixels: np.ndarray, degrees: int) -> np.ndarray:
    """Rotates an image (H x W or H x W x C) clockwise by a multiple of 90 degrees."""
    if degrees % 90 != 0:
        raise ValueError("rotation must be a multiple of 90")
    turns = (degrees // 90) % 4
    # np.rot90 turns counter-clockwise for positive k.
    return np.ascontiguousarray(np.rot90(pixels, k=-turns)) if turns else pixels

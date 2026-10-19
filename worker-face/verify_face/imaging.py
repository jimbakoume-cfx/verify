"""Decoding the images safely: the bytes must be exactly what was uploaded (size and SHA-256 recorded at
upload, given in the claim) before any decoder sees them, and only Pillow's JPEG decoder may open them.
Frames are at most 640 px and 100 KB (LIVENESS_LIMITS), the document photo at most 1,600 px and
5 MB (CAPTURE_LIMITS). Nothing is written to disk.
"""

from __future__ import annotations

import hashlib
import io
import warnings
from typing import Any

import numpy as np
from PIL import Image

from .contract import MAX_CAPTURE_BYTES, MAX_FRAME_BYTES, MAX_FRAME_LONG_SIDE, MAX_LONG_SIDE

Image.MAX_IMAGE_PIXELS = MAX_LONG_SIDE * MAX_LONG_SIDE


class ImageRejected(Exception):
    """The bytes are not the expected JPEG; `code` says why (logged, never the bytes)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def limits(role: str) -> tuple[int, int]:
    """(max bytes, max long side) of an input of this role."""
    return (MAX_FRAME_BYTES, MAX_FRAME_LONG_SIDE) if role == "frame" else (MAX_CAPTURE_BYTES, MAX_LONG_SIDE)


def decode_input(data: bytes, spec: dict[str, Any]) -> np.ndarray:
    """RGB pixels of one claimed input, after checking its bytes and dimensions against the claim."""
    max_bytes, max_side = limits(spec["role"])
    if len(data) > max_bytes:
        raise ImageRejected("image_too_large")
    if len(data) != spec["byteSize"]:
        raise ImageRejected("image_size_mismatch")
    if hashlib.sha256(data).hexdigest() != spec["sha256"]:
        raise ImageRejected("image_hash_mismatch")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            with Image.open(io.BytesIO(data), formats=["JPEG"]) as im:
                width, height = im.size
                if width < 1 or height < 1 or max(width, height) > max_side:
                    raise ImageRejected("image_dimensions")
                if (width, height) != (spec["width"], spec["height"]):
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
    return np.ascontiguousarray(rgb)

"""The gray analysis images the quality port is compared on (tests/test_quality_parity.py) and the
TypeScript reference was computed from (tests/tools/make_quality_reference.py): specimen photos,
some changed to cover more cases (a tilted card, a small card, a dark photo)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from verify_worker.imaging import decode_jpeg, to_gray
from verify_worker.quality import analysis_image

SPECIMENS = Path(__file__).resolve().parent.parent.parent / "e2e" / "fixtures" / "specimens"

# (reference name, specimen file, change)
CASES = (
    ("cni-new-back", "cni-new-back.jpg", None),
    ("cni-new-front", "cni-new-front.jpg", None),
    ("passport-cmr", "passport-cmr.jpg", None),
    ("glare", "cni-old-front-glare.jpg", None),
    ("blur", "passport-cmr-blur.jpg", None),
    ("no-document", "no-document.jpg", None),
    ("blank-card", "blank-card.jpg", None),
    ("tilted", "voter-card-front.jpg", "tilt6"),
    ("small-card", "driving-licence-front.jpg", "small"),
    ("dark", "cni-old-back.jpg", "dark"),
    ("faint", "permit-old-front.jpg", "faint"),
    ("off-centre", "passport-uto.jpg", "shift"),
    ("faint-tilted", "refugee-old-back.jpg", "faint-tilt"),
)

TABLE_GRAY = 80


def full_gray(file: str, change: str | None) -> np.ndarray:
    gray = to_gray(decode_jpeg((SPECIMENS / file).read_bytes()).rgb)
    if change == "tilt6":
        gray = np.asarray(Image.fromarray(gray).rotate(6, resample=Image.Resampling.BILINEAR, fillcolor=TABLE_GRAY))
    elif change == "small":
        h, w = gray.shape
        small = Image.fromarray(gray).resize((round(w * 0.78), round(h * 0.78)), Image.Resampling.BILINEAR)
        canvas = Image.new("L", (w, h), TABLE_GRAY)
        canvas.paste(small, ((w - small.width) // 2, (h - small.height) // 2))
        gray = np.asarray(canvas)
    elif change == "dark":
        gray = (gray.astype(np.uint16) * 35 // 100).astype(np.uint8)
    elif change in ("faint", "faint-tilt"):
        # Contrast cut to a sixth around mid-grey: the card's edges barely stand out.
        gray = (128 + (gray.astype(np.int16) - 128) // 6).astype(np.uint8)
        if change == "faint-tilt":
            gray = np.asarray(Image.fromarray(gray).rotate(-9, resample=Image.Resampling.BILINEAR, fillcolor=128))
    elif change == "shift":
        h, w = gray.shape
        canvas = np.full_like(gray, TABLE_GRAY)
        dx = round(w * 0.1)
        canvas[:, dx:] = gray[:, : w - dx]
        gray = canvas
    return np.ascontiguousarray(gray)


def analysis_gray(file: str, change: str | None) -> np.ndarray:
    return np.ascontiguousarray(analysis_image(full_gray(file, change)))

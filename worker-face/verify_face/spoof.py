"""Passive presentation-attack cues measured on the face, PROVISIONAL.

We have no attack photos yet to train our own screen and print detectors on (training/antispoof/
explains what to collect). Until then these three hand-made measures are reported for each frame, and
the Edge Function turns them into hints with provisional cut-offs; none of them can fail a case.

- moire: a phone or laptop screen filmed by a camera shows a fine periodic pattern (the pixel grid
  beating against the camera's sensor). In the spectrum of the face area, at the photo's own
  resolution, that is an isolated peak far above the rest of the high-frequency band. The measure is
  log10(peak / 95th percentile) of that band.
- glare: the share of the face area that is blown out white (every channel at 245 or more). Glossy
  prints and screens reflect light sources as large flat patches; skin rarely saturates that much.
- detail: high-frequency energy of the face (the variance of its Laplacian over its mean brightness
  squared). A print or a screen re-photographed loses fine detail; very low values hint at a recapture.

Glare and detail are measured on the face box enlarged by 20%, resampled to 128 x 128, so that they do
not depend on how far the phone is; moire on the face's centre at the photo's own resolution.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

CROP = 128
# Radial band of the spectrum searched for a moiré peak, as a fraction of the Nyquist frequency.
MOIRE_BAND = (0.35, 0.95)


def face_crop(rgb: np.ndarray, box: tuple[float, float, float, float], size: int = CROP) -> np.ndarray:
    """The face box (x, y, w, h in pixels) enlarged by 20%, clipped to the image, as size x size RGB."""
    x, y, w, h = box
    cx, cy, side = x + w / 2, y + h / 2, max(w, h) * 1.2
    height, width = rgb.shape[:2]
    x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
    x1, y1 = int(min(width, cx + side / 2)), int(min(height, cy + side / 2))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return np.zeros((size, size, 3), dtype=np.uint8)
    return np.asarray(Image.fromarray(rgb[y0:y1, x0:x1]).resize((size, size), Image.BILINEAR))


def _grey(rgb: np.ndarray) -> np.ndarray:
    return rgb.astype(np.float64) @ np.array([0.299, 0.587, 0.114])


def moire_score(grey: np.ndarray) -> float:
    """log10(highest peak / 95th percentile) of the windowed spectrum within MOIRE_BAND: how far the
    strongest periodic component stands out from the band. Blur lowers the whole band and leaves this
    ratio alone; a screen's pixel grid makes one or two isolated peaks."""
    grey = grey - grey.mean()
    window = np.outer(np.hanning(grey.shape[0]), np.hanning(grey.shape[1]))
    spectrum = np.abs(np.fft.fftshift(np.fft.fft2(grey * window)))
    h, w = grey.shape
    yy, xx = np.mgrid[0:h, 0:w]
    radius = np.hypot((xx - w // 2) / (w / 2), (yy - h // 2) / (h / 2))
    band = spectrum[(radius >= MOIRE_BAND[0]) & (radius <= MOIRE_BAND[1])]
    if band.size == 0:
        return 0.0
    reference = float(np.percentile(band, 95))
    return float(np.log10(band.max() / reference)) if reference > 0 else 0.0


def native_crop(rgb: np.ndarray, box: tuple[float, float, float, float], size: int = 160) -> np.ndarray:
    """The face's central area at the photo's own resolution (no resampling, which would hide or fake a
    pixel-grid pattern): a square of at most `size` pixels around the face box's centre, in grey."""
    x, y, w, h = box
    side = int(min(size, max(16, min(w, h) * 0.8)))
    cx, cy = int(x + w / 2), int(y + h / 2)
    height, width = rgb.shape[:2]
    if not (0 <= cx < width and 0 <= cy < height):
        return np.zeros((0, 0))
    x0, y0 = max(0, cx - side // 2), max(0, cy - side // 2)
    x1, y1 = min(width, x0 + side), min(height, y0 + side)
    return _grey(rgb[y0:y1, x0:x1])


def glare_ratio(crop: np.ndarray) -> float:
    """Share of pixels whose three channels are all at 245 or more."""
    return float((crop.min(axis=2) >= 245).mean())


def detail_score(crop: np.ndarray) -> float:
    """Variance of the 4-neighbour Laplacian over the squared mean brightness (scale-free)."""
    grey = _grey(crop)
    lap = (grey[1:-1, :-2] + grey[1:-1, 2:] + grey[:-2, 1:-1] + grey[2:, 1:-1] - 4 * grey[1:-1, 1:-1])
    mean = grey.mean()
    return float(lap.var() / (mean * mean)) if mean > 1 else 0.0


def measure(rgb: np.ndarray, box: tuple[float, float, float, float]) -> dict[str, float]:
    crop = face_crop(rgb, box)
    native = native_crop(rgb, box)
    return {
        "moire": round(moire_score(native) if min(native.shape) >= 16 else 0.0, 4),
        "glare": round(glare_ratio(crop), 4),
        "detail": round(detail_score(crop), 5),
    }

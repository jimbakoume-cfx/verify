"""Renders single MRZ text lines in OCR-B with Pillow and NumPy, with the damage a phone photo does.

Two uses:
- "grey" lines: cropped here as Tesseract crops a text line before its LSTM reads it (the ink's
  bounding box, a little room above and below, 4 px of padding at 32 px capitals), and written as
  PNG. These keep their grey levels.
- "band" lines: drawn with a loose margin, like the band the rider's locate step cuts out, and
  written as PGM for node/cutLines.ts, which runs the rider's real prepare step (scale to 32 px
  capitals, contrast stretch, local or Otsu threshold) and then crops the line the same way.

Presets set the damage: "train" (everything, wide ranges), and the held-out G1 sets "clean",
"degraded" and "lowres" (capitals 14-16 px), which use other seeds.

Augmentations (from the research): capital height 10-42 px (log-uniform), pitch +-7%, character
jitter, stroke weight, paper and ink levels, low contrast, guilloche, light gradient, glare,
rotation, keystone, blur up to 0.1 x capital height, resolution loss, noise, sharpening (phone
image processing), JPEG quality 25-95.
"""

from __future__ import annotations

import io
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from mrztext import CHARSET, MrzText

# ICAO 9303: 10 characters per inch (2.54 mm) and capitals about 2.4 mm tall.
PITCH_PER_CAP = 2.54 / 2.4

PRESETS = {
    # cap: capital height range in px; blur: max Gaussian radius as a share of the capital height;
    # jpeg: probability, q: quality range; glare: probability; rot: max degrees; key: max keystone
    # (share of the height); noise: max sigma; lowc: probability of low contrast; tex: probability
    # of background texture; sharpen: probability of an unsharp mask; weight: stroke weight changes;
    # loss: probability of a resolution loss (downscale and back).
    "train": dict(cap=(10, 42), blur=0.10, jpeg=0.6, q=(25, 95), glare=0.3, rot=1.5, key=0.12, noise=12,
                  lowc=0.25, tex=0.5, sharpen=0.25, weight=True, loss=0.3),
    "clean": dict(cap=(22, 36), blur=0.0, jpeg=0.0, q=(90, 95), glare=0.0, rot=0.0, key=0.0, noise=1,
                  lowc=0.0, tex=0.0, sharpen=0.0, weight=False, loss=0.0),
    "degraded": dict(cap=(12, 30), blur=0.11, jpeg=1.0, q=(30, 70), glare=0.6, rot=1.5, key=0.12, noise=12,
                     lowc=0.4, tex=0.7, sharpen=0.2, weight=False, loss=0.3),
    "lowres": dict(cap=(14, 16), blur=0.06, jpeg=1.0, q=(60, 80), glare=0.2, rot=0.8, key=0.05, noise=6,
                   lowc=0.1, tex=0.5, sharpen=0.0, weight=False, loss=0.3),
}


class Fonts:
    """OCR-B at any capital height (cached per pixel size)."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        probe = ImageFont.truetype(self.path, 200)
        _, top, _, bottom = probe.getbbox("H", anchor="ls")
        self.cap_per_px = (bottom - top) / 200
        self.cache: dict[int, ImageFont.FreeTypeFont] = {}

    def at_cap(self, cap_px: float) -> ImageFont.FreeTypeFont:
        size = max(4, round(cap_px / self.cap_per_px))
        if size not in self.cache:
            self.cache[size] = ImageFont.truetype(self.path, size)
        return self.cache[size]


def log_uniform(r: random.Random, lo: float, hi: float) -> float:
    return math.exp(r.uniform(math.log(lo), math.log(hi)))


def to_image(a: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "L")


def jpeg(im: Image.Image, quality: int) -> Image.Image:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return Image.open(io.BytesIO(buf.getvalue())).convert("L")


def render_line(text: str, fonts: Fonts, r: random.Random, p: dict, margins: tuple[float, float, float, float],
                neighbours: bool, specks: bool, max_rotation: float) -> tuple[Image.Image, float]:
    """Draws `text` with the preset's damage and crops it to the ink's bounding box plus `margins`
    (left, top, right, bottom, in capital heights). The box is measured after the rotation and
    keystone, as Tesseract measures the line it finds. Clutter Tesseract's crop can contain:
    `neighbours`, parts of the next code line at the top or bottom edge; `specks`, a dot before the
    first character (then counted in the box, as Tesseract counts it in the line). Returns the
    image and the capital height in its pixels."""
    cap = log_uniform(r, *p["cap"])
    ss = max(2, min(6, int(120 / cap)))
    capss = cap * ss
    font = fonts.at_cap(capss)
    pitch = capss * PITCH_PER_CAP * r.uniform(0.93, 1.07)
    room = 2.2 * capss
    w = int(2 * room + pitch * (len(text) - 1) + capss)
    h = int(2 * room + capss)
    main = Image.new("L", (w, h), 0)
    clutter = Image.new("L", (w, h), 0)
    dm, dc = ImageDraw.Draw(main), ImageDraw.Draw(clutter)
    base = room + capss
    for i, ch in enumerate(text):
        jx = r.gauss(0, 0.02) * pitch
        jy = r.gauss(0, 0.015) * capss
        dm.text((room + i * pitch + jx, base + jy), ch, font=font, fill=255, anchor="ls")
    if neighbours and r.random() < 0.3:
        # A neighbouring code line above or below (code lines are 1.8-1.9 capital heights apart;
        # Tesseract's crop reaches below the baseline, so the next line's tops can show).
        other = MrzText(r).random_line(len(text))
        yb = base + capss * r.uniform(1.75, 1.95) * (-1 if r.random() < 0.5 else 1)
        for i, ch in enumerate(other):
            dc.text((room + i * pitch, yb), ch, font=font, fill=255, anchor="ls")
    if specks and r.random() < 0.08:
        # A speck just before the first character (dust, a dot of the security print). Only round
        # dots: a stroke there could be a real I or 1, and a model taught to drop it would drop a
        # real first letter of the names line, which no check digit covers.
        x = room - r.uniform(0.2, 0.6) * capss
        y0 = base - capss * r.uniform(0.1, 1.0)
        rad = capss * r.uniform(0.03, 0.09)
        dm.ellipse((x - rad, y0 - rad, x + rad, y0 + rad), fill=255)
    mask = Image.fromarray(np.maximum(np.asarray(main), np.asarray(clutter)))
    weight = r.choice([0, 0, 0, -1, 1]) if p["weight"] else 0
    if weight > 0:
        # Bolder: grow the strokes by about 3-6% of the capital height.
        k = max(3, int(capss * r.uniform(0.03, 0.06)) | 1)
        mask = mask.filter(ImageFilter.MaxFilter(k))
    out_w, out_h = max(8, round(w / ss)), max(8, round(h / ss))
    m = np.asarray(mask.resize((out_w, out_h), Image.Resampling.BOX), dtype=np.float32) / 255.0
    if weight < 0:
        # Thinner: eat into the antialiased edges.
        cut = r.uniform(0.15, 0.4)
        m = np.clip((m - cut) / (1 - cut), 0, 1)
    main = main.resize((out_w, out_h), Image.Resampling.BOX)

    # Paper and ink levels, background texture, uneven light.
    paper = r.uniform(165, 250)
    ink = r.uniform(0, 75)
    if r.random() < p["lowc"]:
        ink = paper - r.uniform(45, 90)
    yy, xx = np.ogrid[0:out_h, 0:out_w]
    yy, xx = yy.astype(np.float32), xx.astype(np.float32)
    bg = np.full((out_h, out_w), paper, np.float32)
    if r.random() < p["tex"]:
        # Guilloche-like curves of the security print.
        amp = r.uniform(8, 35)
        f1, f2 = r.uniform(0.02, 0.15), r.uniform(0.05, 0.4)
        g = np.sin(xx * f1 + np.sin(yy * f2 + r.uniform(0, 6.28)) * r.uniform(1, 4))
        bg -= amp * (g > r.uniform(0.85, 0.97))
    gx, gy = r.uniform(-0.6, 0.6), r.uniform(-0.6, 0.6)
    bg *= 1 + 0.25 * (gx * (xx / out_w - 0.5) + gy * (yy / out_h - 0.5))
    img = bg * (1 - m) + ink * m
    if r.random() < p["glare"]:
        cx, cy = r.uniform(0, out_w), r.uniform(0, out_h)
        sx, sy = r.uniform(0.05, 0.4) * out_w, r.uniform(0.3, 2) * cap
        a = r.uniform(0.4, 0.9)
        img = img + (255 - img) * a * np.exp(-(((xx - cx) / sx) ** 2 + ((yy - cy) / sy) ** 2))
    im = to_image(img)

    # Geometry: a slight rotation (what the rider's deskew leaves) and keystone, applied to the
    # main text's mask too so the crop follows the ink.
    angle = r.uniform(-max_rotation, max_rotation) if max_rotation else 0.0
    if angle:
        im = im.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=int(paper))
        main = main.rotate(angle, resample=Image.Resampling.BILINEAR, fillcolor=0)
    if p["key"] and r.random() < 0.5:
        k = r.uniform(-p["key"], p["key"]) * cap
        quad = (0, -max(0, k) / 2, 0, out_h + max(0, k) / 2, out_w, out_h + max(0, -k) / 2, out_w, -max(0, -k) / 2)
        im = im.transform((out_w, out_h), Image.Transform.QUAD, quad, Image.Resampling.BICUBIC, fillcolor=int(paper))
        main = main.transform((out_w, out_h), Image.Transform.QUAD, quad, Image.Resampling.BILINEAR, fillcolor=0)
    # Optics and sensor.
    if p["blur"]:
        rad = r.uniform(0, p["blur"]) * cap
        if rad > 0.2:
            im = im.filter(ImageFilter.GaussianBlur(rad))
    if r.random() < p["loss"]:
        f = r.uniform(0.6, 0.9)
        small = im.resize((max(8, int(out_w * f)), max(8, int(out_h * f))), Image.Resampling.BILINEAR)
        im = small.resize((out_w, out_h), Image.Resampling.BILINEAR)
    if r.random() < p["sharpen"]:
        im = im.filter(ImageFilter.UnsharpMask(radius=r.uniform(0.6, 2.0), percent=r.randint(60, 200), threshold=2))
    if p["noise"]:
        a = np.asarray(im, np.float32)
        a = a + np.random.default_rng(r.randrange(1 << 30)).normal(0, r.uniform(0, p["noise"]), a.shape)
        im = to_image(a)

    # Crop to the main ink plus the margins.
    ys, xs = np.nonzero(np.asarray(main) > 96)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    ml, mt, mr, mb = margins
    box = (max(0, round(x0 - ml * cap)), max(0, round(y0 - mt * cap)),
           min(out_w, round(x1 + mr * cap)), min(out_h, round(y1 + mb * cap)))
    im = im.crop(box)
    # JPEG last, as a phone compresses the whole picture.
    if r.random() < p["jpeg"]:
        im = jpeg(im, r.randint(*p["q"]))
    return im, cap


def tesseract_margins(r: random.Random) -> tuple[float, float, float, float]:
    """Margins of the crop Tesseract hands its LSTM for one line of a 32 px band, in capital
    heights around the ink: 4 px of padding (0.125), a little room above the capitals and more
    below the baseline (hOCR on prepared bands shows 5-14 px of descender room at 32 px
    capitals). One crop in ten is looser, for robustness."""
    if r.random() < 0.1:
        return (r.uniform(0.3, 1.2), r.uniform(0.25, 0.8), r.uniform(0.3, 1.2), r.uniform(0.25, 0.8))
    pad = 0.125 * r.uniform(0.6, 1.6)
    return (pad, pad + r.uniform(0.0, 0.12), pad, pad + r.uniform(0.12, 0.5))


def band_margins(r: random.Random) -> tuple[float, float, float, float]:
    """Margins of a band as the rider's locate step cuts it: about 0.8 character heights all round
    (packages/capture/src/mrz/locate.ts), give or take the measuring error."""
    return tuple(r.uniform(0.6, 1.1) for _ in range(4))  # type: ignore[return-value]


def write_box(path: Path, text: str, width: int, height: int) -> None:
    """A line box file as tesstrain's generate_line_box.py writes it (ASCII text: one box per
    character covering the whole image, then a tab line), in this process: one Python process per
    file would take about an hour for 25k lines."""
    rows = [f"{c} 0 0 {width} {height} 0" for c in text] + [f"\t 0 0 {width} {height} 0"]
    path.write_text("\n".join(rows) + "\n")


def write_pgm(im: Image.Image, path: Path) -> None:
    im = im.convert("L")
    path.write_bytes(f"P5\n{im.width} {im.height}\n255\n".encode("ascii") + im.tobytes())


def check_text(text: str) -> None:
    if not text or any(c not in CHARSET for c in text):
        raise ValueError(f"not an MRZ line: {text!r}")

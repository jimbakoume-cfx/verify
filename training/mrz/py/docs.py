"""Renders whole fictitious documents as the rider's camera still shows them: the back of a TD1 card
(identity or residence card, 3 code lines) or a TD3 passport page (2 code lines), lying on a table,
photographed by a phone.

This is the TRAINING document renderer. The G2/G3 benchmark uses a different one on purpose
(py/bench.py, built on scripts/make-mrz-fixtures.py), so the gates measure what the model learned,
not this renderer's habits.

Every document is made up: random names, numbers and dates (mrztext.py), "SPECIMEN"-style
headings, abstract security print. Nothing is copied from a real document design.

The stills go to node/cutLines.ts, which runs the rider's own locate and prepare steps on them and
cuts the code lines out as Tesseract would. That is what makes these lines "realistic": the model
learns exactly the images the phone will feed it.

Output (one shard): <out>/<name>.pgm stills and <out>/jobs.jsonl, one job per still:
{"kind": "still", "file", "format", "lines", "binarization", "out"}.
"""

from __future__ import annotations

import io
import json
import math
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from lines import Fonts, log_uniform, to_image, write_pgm
from mrztext import ALPHA, DIGITS, MrzText

# Sizes in mm (ICAO 9303 Parts 4 and 5) and code-line placement: the left edge of the first
# character, and the baselines above the bottom edge, bottom line first.
DOC_MM = {"TD1": (85.6, 53.98), "TD3": (125.0, 88.0)}
MRZ = {
    "TD1": {"left": 4.7, "baselines": [3.6, 7.9, 12.2]},
    "TD3": {"left": 6.6, "baselines": [4.6, 9.2]},
}
PITCH_MM = 2.54
CAP_MM = 2.4
# The still is the capture guide plus 4% (packages/capture: STILL_CROP_EXPANSION).
STILL_EXPANSION = 1.04
SS = 3

WORDS = ["REPUBLIQUE", "REPUBLIC", "CARTE", "CARD", "TITRE", "SEJOUR", "RESIDENT", "IDENTITE", "NATIONALE",
         "PASSEPORT", "PASSPORT", "NOM", "SURNAME", "PRENOMS", "GIVEN", "NAMES", "NE", "LE", "BORN", "ON",
         "SEXE", "SEX", "TAILLE", "HEIGHT", "PROFESSION", "AUTORITE", "AUTHORITY", "DELIVRANCE", "ISSUE",
         "EXPIRATION", "EXPIRY", "ADRESSE", "ADDRESS", "SPECIMEN", "UTOPIE", "UTOPIA", "VALABLE", "VALID"]


def solve_perspective(src: list[tuple[float, float]], dst: list[tuple[float, float]]) -> tuple[float, ...]:
    """Coefficients for Image.transform(PERSPECTIVE) that map output points `dst` to input `src`."""
    a, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b += [u, v]
    return tuple(np.linalg.solve(np.array(a, float), np.array(b, float)))


def apply_perspective(c: tuple[float, ...], x: float, y: float) -> tuple[float, float]:
    d = c[6] * x + c[7] * y + 1
    return (c[0] * x + c[1] * y + c[2]) / d, (c[3] * x + c[4] * y + c[5]) / d


def smooth_noise(r: random.Random, w: int, h: int, cells: int, amp: float) -> np.ndarray:
    """Low-frequency variation: a coarse random grid, upscaled smoothly."""
    gw, gh = max(2, cells), max(2, round(cells * h / max(1, w)) + 1)
    grid = np.random.default_rng(r.randrange(1 << 30)).uniform(-amp, amp, (gh, gw)).astype(np.float32)
    return np.asarray(Image.fromarray(grid, "F").resize((w, h), Image.Resampling.BICUBIC), np.float32)


class DocumentRenderer:
    def __init__(self, ocrb_path: str | Path):
        self.ocrb = Fonts(ocrb_path)
        probe = ImageFont.load_default(200)
        _, top, _, bottom = probe.getbbox("H", anchor="ls")
        self.sans_cap_per_px = (bottom - top) / 200

    def sans(self, cap_px: float) -> ImageFont.FreeTypeFont:
        """Pillow's bundled sans-serif (Aileron, CC0), so no system font is needed."""
        return ImageFont.load_default(max(4, round(cap_px / self.sans_cap_per_px)))

    # -- the document, flat ---------------------------------------------------------------------
    def document(self, r: random.Random, fmt: str, lines: list[str], width_px: int) -> tuple[Image.Image, tuple[float, ...]]:
        """The document seen flat, `width_px` wide. Returns it and where its code lines are (mm:
        left, top and bottom measured up from the bottom edge, right)."""
        wmm, hmm = DOC_MM[fmt]
        ppm = width_px / wmm
        w, h = width_px, round(hmm * ppm)
        paper = r.uniform(150, 245)
        bg = np.full((h, w), paper, np.float32)
        bg += smooth_noise(r, w, h, r.randint(2, 6), r.uniform(0, 18))
        yy, xx = np.ogrid[0:h, 0:w]
        yy, xx = yy.astype(np.float32), xx.astype(np.float32)
        # Guilloche: fine interfering waves of the security print, often reaching under the code
        # lines (as on the new Cameroonian cards).
        if r.random() < 0.8:
            for _ in range(r.randint(1, 3)):
                f1, f2 = r.uniform(0.6, 3.0) / ppm, r.uniform(0.2, 1.5) / ppm
                g = np.sin(xx * f1 + r.uniform(1, 6) * np.sin(yy * f2 + r.uniform(0, 6.3)) + r.uniform(0, 6.3))
                lines_mask = np.abs(g) < r.uniform(0.04, 0.18)
                strength = r.uniform(8, 45)
                if r.random() < 0.4:
                    # Plain zone behind the code lines.
                    top = h - (MRZ[fmt]["baselines"][-1] + CAP_MM + r.uniform(1.0, 3.0)) * ppm
                    lines_mask &= yy < top
                bg -= strength * lines_mask
        if r.random() < 0.3:
            # A large faint emblem (a ring) somewhere on the document.
            cx, cy, rad = r.uniform(0, w), r.uniform(0, h), r.uniform(0.15, 0.4) * h
            ring = np.abs(np.hypot(xx - cx, yy - cy) - rad) < r.uniform(0.01, 0.05) * h
            bg -= r.uniform(10, 40) * ring
        img = bg

        # Printed matter, drawn supersampled into ink masks: dark text and graphics, then the code
        # lines on their own (they get their own ink level).
        sw, sh = w * SS, h * SS
        sp = ppm * SS
        text_mask = Image.new("L", (sw, sh), 0)
        d = ImageDraw.Draw(text_mask)
        heading = " ".join(r.choice(WORDS) for _ in range(r.randint(2, 5)))
        d.text((r.uniform(3, 8) * sp, r.uniform(4, 7) * sp), heading, font=self.sans(r.uniform(1.4, 2.4) * sp),
               fill=r.randint(150, 255), anchor="ls")
        mrz_top_mm = MRZ[fmt]["baselines"][-1] + CAP_MM + 1.0
        field_bottom = hmm - mrz_top_mm - 1.5
        if fmt == "TD3":
            # Portrait: background, shoulders and a head.
            x0, y0, pw, ph = r.uniform(4, 8) * sp, r.uniform(11, 15) * sp, r.uniform(28, 34) * sp, r.uniform(36, 42) * sp
            d.rectangle((x0, y0, x0 + pw, y0 + ph), fill=r.randint(40, 110))
            d.ellipse((x0 + 0.1 * pw, y0 + 0.62 * ph, x0 + 0.9 * pw, y0 + 1.3 * ph), fill=r.randint(170, 240))
            d.rectangle((x0, y0 + ph, x0 + pw, y0 + 1.4 * ph), fill=0)
            d.ellipse((x0 + 0.3 * pw, y0 + 0.18 * ph, x0 + 0.7 * pw, y0 + 0.66 * ph), fill=r.randint(120, 220))
            fields_x = [44 + r.uniform(-2, 2), 88 + r.uniform(-3, 3)]
        else:
            fields_x = [r.uniform(3, 6)]
            if r.random() < 0.85:
                # QR-like block (the new cards carry a QR code on the back).
                n = 25
                size = r.uniform(14, 22) * sp
                qx = r.uniform(55, 64) * sp if r.random() < 0.7 else r.uniform(3, 8) * sp
                if qx < 20 * sp:
                    fields_x = [qx / sp + size / sp + 3]
                qy = r.uniform(3, max(3.5, field_bottom - 22)) * sp
                m = size / n
                for j in range(n):
                    for i in range(n):
                        if r.random() < 0.45:
                            d.rectangle((qx + i * m, qy + j * m, qx + (i + 1) * m - 1, qy + (j + 1) * m - 1), fill=255)
        label_font = self.sans(r.uniform(1.0, 1.5) * sp)
        value_font = self.sans(r.uniform(1.6, 2.3) * sp) if r.random() < 0.7 else self.ocrb.at_cap(r.uniform(1.6, 2.2) * sp)
        for fx in fields_x:
            row_mm = r.uniform(11, 14)
            step = r.uniform(6.5, 8.5)
            while row_mm + 3.5 < field_bottom:
                label = " / ".join(r.choice(WORDS) for _ in range(r.randint(1, 2)))
                value = " ".join("".join(r.choice(ALPHA + (DIGITS if r.random() < 0.3 else ""))
                                         for _ in range(r.randint(2, 9))) for _ in range(r.randint(1, 3)))
                d.text((fx * sp, row_mm * sp), label, font=label_font, fill=r.randint(120, 200), anchor="ls")
                d.text((fx * sp, (row_mm + 3.2) * sp), value, font=value_font, fill=255, anchor="ls")
                row_mm += step
        if r.random() < 0.6:
            # A signature.
            sx, sy = r.uniform(40, 60) * sp if fmt == "TD3" else r.uniform(30, 50) * sp, (field_bottom - 2) * sp
            pts = [(sx + t * sp, sy + r.uniform(1, 3) * sp * math.sin(t / r.uniform(1.5, 3))) for t in range(0, r.randint(15, 30))]
            d.line(pts, fill=r.randint(150, 255), width=max(1, round(0.3 * sp)))

        mrz_mask = Image.new("L", (sw, sh), 0)
        dm = ImageDraw.Draw(mrz_mask)
        cap = CAP_MM * r.uniform(0.92, 1.08) * sp
        pitch = PITCH_MM * r.uniform(0.96, 1.04) * sp
        font = self.ocrb.at_cap(cap)
        left = (MRZ[fmt]["left"] + r.uniform(-1.0, 1.0)) * sp
        shift = r.uniform(-0.6, 0.6)
        spacing = r.uniform(0.95, 1.05)
        baselines = [sh - (b * spacing + shift) * sp for b in reversed(MRZ[fmt]["baselines"])]
        # Stroke weight: bolder with an outline in the ink's own colour, thinner by eating into
        # the antialiased edges after the reduction (cheaper than a min/max filter at this size).
        weight = r.choice([0, 0, 0, 1, -1])
        stroke = max(1, round(cap * r.uniform(0.02, 0.05))) if weight > 0 else 0
        for line, base in zip(lines, baselines):
            for i, ch in enumerate(line):
                dm.text((left + i * pitch + r.gauss(0, 0.015) * pitch, base + r.gauss(0, 0.01) * cap), ch,
                        font=font, fill=255, anchor="ls", stroke_width=stroke, stroke_fill=255)

        tm = np.asarray(text_mask.resize((w, h), Image.Resampling.BOX), np.float32) / 255.0
        mm = np.asarray(mrz_mask.resize((w, h), Image.Resampling.BOX), np.float32) / 255.0
        if weight < 0:
            cut = r.uniform(0.15, 0.4)
            mm = np.clip((mm - cut) / (1 - cut), 0, 1)
        text_ink = r.uniform(10, 90)
        mrz_ink = r.uniform(0, 70)
        if r.random() < 0.15:
            # Faded or light print.
            mrz_ink = paper - r.uniform(70, 120)
        img = img * (1 - tm) + text_ink * tm
        img = img * (1 - mm) + mrz_ink * mm
        # Where the code lines are, in mm: left, top and bottom (from the bottom edge), right.
        top_mm = (sh - baselines[0]) / sp + cap / sp
        bottom_mm = (sh - baselines[-1]) / sp
        right_mm = (left + pitch * len(lines[0])) / sp
        return to_image(img), (left / sp, top_mm, right_mm, bottom_mm)

    # -- on the table, through the phone --------------------------------------------------------
    def still(self, r: random.Random, fmt: str, lines: list[str]) -> Image.Image:
        """The phone's still of the document; drawn again until the code lines fall inside it."""
        for _ in range(20):
            still = self.try_still(r, fmt, lines)
            if still is not None:
                return still
        raise RuntimeError("could not place the document")

    def try_still(self, r: random.Random, fmt: str, lines: list[str]) -> Image.Image | None:
        wmm, hmm = DOC_MM[fmt]
        width = round(log_uniform(r, 640, 1700))
        height = round(width * hmm / wmm)
        guide_w = width / STILL_EXPANSION
        scale = r.uniform(0.82, 1.0)
        doc_w = guide_w * scale
        # Draw the flat document a bit larger than it appears, then let the warp reduce it.
        flat, mrz_box = self.document(r, fmt, lines, max(200, round(doc_w * r.uniform(1.0, 1.3))))

        # Table: dark or light, plain or textured.
        table = r.choice([r.uniform(15, 90), r.uniform(90, 170), r.uniform(170, 235)])
        t = np.full((height, width), table, np.float32)
        t += smooth_noise(r, width, height, r.randint(3, 10), r.uniform(0, 25))
        if r.random() < 0.5:
            yy = np.arange(height, dtype=np.float32)[:, None]
            xx = np.arange(width, dtype=np.float32)[None, :]
            t += r.uniform(3, 15) * np.sin((xx * r.uniform(-0.2, 0.2) + yy) * r.uniform(0.05, 0.4)
                                           + 3 * np.sin(xx * r.uniform(0.002, 0.02)))
        still = to_image(t)

        # Where the document's corners land: centred near the guide, turned up to 4 degrees, with a
        # little perspective.
        dw, dh = doc_w, doc_w * hmm / wmm
        cx = width / 2 + r.uniform(-0.03, 0.03) * width
        cy = height / 2 + r.uniform(-0.03, 0.03) * height
        a = math.radians(r.uniform(-4, 4))
        corners = []
        k = r.uniform(-0.03, 0.03)
        kx = r.uniform(-0.03, 0.03)
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            x = sx * dw / 2 * (1 + k * sy)
            y = sy * dh / 2 * (1 + kx * sx)
            corners.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
        fw, fh = flat.size
        coeffs = solve_perspective([(0, 0), (fw, 0), (fw, fh), (0, fh)], corners)
        # The code lines must stay inside the still with some room, or their labels would lie.
        to_still = solve_perspective(corners, [(0, 0), (fw, 0), (fw, fh), (0, fh)])
        fppm = fw / wmm
        x0, x1 = (mrz_box[0] - 1.5) * fppm, (mrz_box[2] + 1.5) * fppm
        y0, y1 = fh - mrz_box[1] * fppm, fh - (mrz_box[3] - 1.0) * fppm
        for px, py in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
            qx, qy = apply_perspective(to_still, px, py)
            if not (2 <= qx <= width - 3 and 2 <= qy <= height - 3):
                return None
        warped = flat.transform((width, height), Image.Transform.PERSPECTIVE, coeffs, Image.Resampling.BICUBIC)
        shape = Image.new("L", flat.size, 0)
        ImageDraw.Draw(shape).rounded_rectangle((0, 0, fw - 1, fh - 1), round(0.035 * fw), fill=255)
        alpha = shape.transform((width, height), Image.Transform.PERSPECTIVE, coeffs, Image.Resampling.BILINEAR)
        still.paste(warped, (0, 0), alpha)

        a_img = np.asarray(still, np.float32)
        yy, xx = np.ogrid[0:height, 0:width]
        yy, xx = yy.astype(np.float32), xx.astype(np.float32)
        # Uneven light, sometimes a soft shadow (a hand or the phone), sometimes glare on the
        # laminate. Glare is kept from wiping the characters out: the labels must stay true.
        gx, gy = r.uniform(-1, 1), r.uniform(-1, 1)
        a_img *= 1 + r.uniform(0.05, 0.35) * (gx * (xx / width - 0.5) + gy * (yy / height - 0.5))
        if r.random() < 0.3:
            nx, ny = math.cos(r.uniform(0, 6.3)), math.sin(r.uniform(0, 6.3))
            d0 = r.uniform(-0.3, 0.3) * width
            dist = (xx - width / 2) * nx + (yy - height / 2) * ny - d0
            soft = r.uniform(0.01, 0.08) * width
            a_img *= 1 - r.uniform(0.15, 0.45) / (1 + np.exp(np.clip(-dist / soft, -60, 60)))
        if r.random() < 0.35:
            gcx, gcy = r.uniform(0, width), r.uniform(0, height)
            gsx, gsy = r.uniform(0.05, 0.3) * width, r.uniform(0.05, 0.3) * height
            a_img += (255 - a_img) * r.uniform(0.2, 0.7) * np.exp(-(((xx - gcx) / gsx) ** 2 + ((yy - gcy) / gsy) ** 2))
        im = to_image(a_img)

        # The phone: focus, motion, sensor noise, sharpening, sometimes JPEG.
        cap_px = CAP_MM * doc_w / wmm
        blur = r.uniform(0, 0.09) * cap_px
        if blur > 0.25:
            im = im.filter(ImageFilter.GaussianBlur(blur))
        if r.random() < 0.1:
            # A little hand shake: a short straight smear (3 or 5 px), level or slanted.
            n = r.choice([3, 5])
            kernel = [0.0] * (n * n)
            for i in range(n):
                kernel[(n // 2) * n + i if r.random() < 0.6 else i * n + i] = 1.0
            im = im.filter(ImageFilter.Kernel((n, n), kernel, scale=sum(kernel)))
        if r.random() < 0.4:
            im = im.filter(ImageFilter.UnsharpMask(radius=r.uniform(0.8, 2.5), percent=r.randint(50, 180), threshold=r.randint(0, 3)))
        noise = r.uniform(0.5, 7)
        a_img = np.asarray(im, np.float32) + np.random.default_rng(r.randrange(1 << 30)).normal(0, noise, (height, width))
        im = to_image(a_img)
        if r.random() < 0.3:
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=r.randint(55, 95))
            im = Image.open(io.BytesIO(buf.getvalue())).convert("L")
        return im


def main() -> None:
    """usage: docs.py OCRB_FONT OUT_DIR COUNT SEED PREFIX"""
    font, out, count, seed, prefix = sys.argv[1], Path(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    out.mkdir(parents=True, exist_ok=True)
    r = random.Random(seed)
    text = MrzText(r)
    renderer = DocumentRenderer(font)
    with (out / "jobs.jsonl").open("w") as jobs:
        for i in range(count):
            fmt = "TD1" if r.random() < 0.55 else "TD3"
            lines = text.document(fmt)
            name = f"{prefix}_{i:05d}"
            write_pgm(renderer.still(r, fmt, lines), out / f"{name}.pgm")
            # The rider reads with the local threshold first and Otsu's on the second pass.
            binarization = "local" if r.random() < 0.8 else "otsu"
            jobs.write(json.dumps({"kind": "still", "file": f"{name}.pgm", "format": fmt, "lines": lines,
                                   "binarization": binarization, "out": name}) + "\n")


if __name__ == "__main__":
    main()

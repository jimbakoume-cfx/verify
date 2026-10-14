#!/usr/bin/env python3
"""Renders the MRZ ("code lines") test fixtures: fictitious SPECIMEN documents of the made-up state
"UTO" (ICAO's Utopia), with obviously fake names and valid check digits, drawn in Matthew Skala's
OCR-B (scripts/fonts/ocr-b/OCRB.otf). Nothing here resembles a real person or a real document.

Outputs (8-bit binary PGM, "P5", so TypeScript and standard-library Python can read them without
an image library), plus manifest.json with the expected lines and the physical sizes:

    td1-card.pgm           back of a new-style ID card (TD1, 3 x 30), as the rider's still:
                           800 x 505, the card nearly fills it (guide + 4%), upright, 9 px/mm
    td1-card-degraded.pgm  the same, slightly out of focus, noisy and JPEG-compressed (q70)
    td1-card-smudged.pgm   a smudge over the code lines, at the smallest still the server
                           accepts (720 px): must NOT read as valid
    td3-page.pgm           passport data page (TD3, 2 x 44), 816 x 575 at 6.4 px/mm
                           (characters about 15 px tall, as a passport held upright gives)
    td3-page-degraded.pgm  the same at 760 x 535 (6 px/mm, 14 px characters), slightly out of
                           focus, noisy and JPEG-compressed (q70)
    td1-strip.pgm          code lines only (black on white, 8 px/mm), for the E2E fake camera
    td1-strip-smudged.pgm  the same, smudged
    td3-strip.pgm          passport code lines only

The strips' physical size and where they sit on the document are in the manifest, so the fake
camera script can paste them at the right scale.

Dev only (Pillow is not needed at runtime or in CI). The output is committed; run again only when
the fixtures must change, then commit the result:

    python3 scripts/make-mrz-fixtures.py [OUT_DIR]     (default: e2e/fixtures/mrz)
"""

from __future__ import annotations

import io
import json
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "scripts" / "fonts" / "ocr-b" / "OCRB.otf"
DEFAULT_OUT = ROOT / "e2e" / "fixtures" / "mrz"

# ICAO 9303 Part 3: 10 characters per inch. OCR-B size 1 capitals are about 2.4 mm tall.
CHAR_PITCH_MM = 2.54
CAP_HEIGHT_MM = 2.4
# Supersampling factor: everything is drawn this much larger, then reduced (antialiasing).
SS = 4

# Card and page sizes (ID-1 card; TD3 passport page).
TD1_MM = (85.6, 53.98)
TD3_MM = (125.0, 88.0)
# Code-line placement: left edge of the first character, and baselines above the bottom edge
# (bottom line first). Close to ICAO 9303 Parts 4 and 5.
TD1_MRZ = {"leftMm": 4.7, "baselinesFromBottomMm": [3.6, 7.9, 12.2]}
TD3_MRZ = {"leftMm": 6.6, "baselinesFromBottomMm": [4.6, 9.2]}

INK = 28
PAPER = 226
TABLE = 72


# ---------------------------------------------------------------------------------------------
# MRZ data with valid check digits
# ---------------------------------------------------------------------------------------------
def char_value(c: str) -> int:
    if c.isdigit():
        return int(c)
    if "A" <= c <= "Z":
        return ord(c) - 55
    if c == "<":
        return 0
    raise ValueError(c)


def check_digit(field: str) -> str:
    weights = (7, 3, 1)
    return str(sum(char_value(c) * weights[i % 3] for i, c in enumerate(field)) % 10)


def pad(text: str, length: int) -> str:
    assert len(text) <= length, text
    return text + "<" * (length - len(text))


def td1_lines() -> list[str]:
    number = "SP0123456"
    birth, expiry = "900215", "350101"
    l1 = pad("IDUTO" + number + check_digit(number), 30)
    l2 = birth + check_digit(birth) + "F" + expiry + check_digit(expiry) + "UTO"
    l2 = pad(l2, 29)
    composite = l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29]
    l2 += check_digit(composite)
    l3 = pad("SPECIMEN<<TEST<CARD", 30)
    return [l1, l2, l3]


def td3_lines() -> list[str]:
    number = "SP7654321"
    birth, expiry = "850704", "330630"
    personal = pad("TEST0042", 14)
    l1 = pad("P<UTOSPECIMEN<<TEST<PASSPORT", 44)
    l2 = (number + check_digit(number) + "UTO" + birth + check_digit(birth) + "M"
          + expiry + check_digit(expiry) + personal + check_digit(personal))
    composite = l2[0:10] + l2[13:20] + l2[21:43]
    l2 += check_digit(composite)
    assert len(l2) == 44
    return [l1, l2]


# ---------------------------------------------------------------------------------------------
# Drawing helpers (on a supersampled canvas, units in mm converted with `px`)
# ---------------------------------------------------------------------------------------------
def ocrb(cap_px: float) -> ImageFont.FreeTypeFont:
    """OCR-B at the size whose capitals are `cap_px` tall."""
    probe = ImageFont.truetype(str(FONT), 200)
    _, top, _, bottom = probe.getbbox("H", anchor="ls")
    return ImageFont.truetype(str(FONT), max(1, round(200 * cap_px / (bottom - top))))


def sans(cap_px: float) -> ImageFont.FreeTypeFont:
    """Pillow's bundled sans-serif font, so the script needs no system fonts."""
    probe = ImageFont.load_default(200)
    _, top, _, bottom = probe.getbbox("H", anchor="ls")
    return ImageFont.load_default(max(1, round(200 * cap_px / (bottom - top))))


def draw_mrz(draw: ImageDraw.ImageDraw, lines: list[str], left: float, baselines: list[float], ppm: float,
             fill: int) -> None:
    """Code lines at the ICAO pitch, one character at a time (the font's own advance differs).
    `baselines` are y positions in pixels, top line first."""
    font = ocrb(CAP_HEIGHT_MM * ppm)
    pitch = CHAR_PITCH_MM * ppm
    for line, base in zip(lines, baselines):
        for i, char in enumerate(line):
            draw.text((left + i * pitch, base), char, font=font, fill=fill, anchor="ls")


def reduce(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    return img.resize(size, Image.Resampling.BOX)


def add_noise(img: Image.Image, sigma: float, rng: random.Random) -> Image.Image:
    data = bytes(max(0, min(255, round(v + rng.gauss(0, sigma)))) for v in img.tobytes())
    return Image.frombytes("L", img.size, data)


def shade(img: Image.Image, low: float, high: float) -> Image.Image:
    """Uneven light: brightness falls from `high` (top left) to `low` (bottom right)."""
    w, h = img.size
    src = img.tobytes()
    out = bytearray(len(src))
    for y in range(h):
        for x in range(w):
            t = (x / w + y / h) / 2
            out[y * w + x] = max(0, min(255, round(src[y * w + x] * (high + (low - high) * t))))
    return Image.frombytes("L", img.size, bytes(out))


def jpeg(img: Image.Image, quality: int) -> Image.Image:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    buf.seek(0)
    return Image.open(buf).convert("L")


def degrade(img: Image.Image, blur: float, rng: random.Random) -> Image.Image:
    """Slightly out of focus, a little sensor noise, then a phone-like JPEG round trip."""
    img = img.filter(ImageFilter.GaussianBlur(blur))
    img = add_noise(img, 2.5, rng)
    return jpeg(img, 70)


def smudge(img: Image.Image, box: tuple[float, float, float, float]) -> Image.Image:
    """A greasy smear over `box` (x0, y0, x1, y1 in pixels): heavily blurred and hazed inside a
    soft ellipse, so the characters there cannot be read."""
    w, h = img.size
    blurred = img.filter(ImageFilter.GaussianBlur(max(3.0, (box[3] - box[1]) / 10)))
    haze = Image.new("L", img.size, 168)
    smeared = Image.blend(blurred, haze, 0.55)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse(box, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(2.0, (box[3] - box[1]) / 12)))
    return Image.composite(smeared, img, mask)


def write_pgm(img: Image.Image, path: Path) -> None:
    img = img.convert("L")
    w, h = img.size
    path.write_bytes(f"P5\n{w} {h}\n255\n".encode("ascii") + img.tobytes())


def pseudo_qr(draw: ImageDraw.ImageDraw, x: float, y: float, size: float, rng: random.Random, ink: int) -> None:
    """A QR-like block of random modules with three finder squares (not a real code)."""
    n = 25
    m = size / n
    for j in range(n):
        for i in range(n):
            if rng.random() < 0.45:
                draw.rectangle((x + i * m, y + j * m, x + (i + 1) * m - 1, y + (j + 1) * m - 1), fill=ink)
    for fx, fy in ((0, 0), (n - 7, 0), (0, n - 7)):
        x0, y0 = x + fx * m, y + fy * m
        draw.rectangle((x0, y0, x0 + 7 * m - 1, y0 + 7 * m - 1), fill=255)
        draw.rectangle((x0, y0, x0 + 7 * m - 1, y0 + 7 * m - 1), outline=ink, width=max(1, round(m)))
        draw.rectangle((x0 + 2 * m, y0 + 2 * m, x0 + 5 * m - 1, y0 + 5 * m - 1), fill=ink)


def on_table(document: Image.Image, still_size: tuple[int, int], rng: random.Random) -> tuple[Image.Image, tuple[int, int]]:
    """Places the document in the middle of a still of `still_size` over a dark table."""
    still = Image.new("L", still_size, TABLE)
    tex = ImageDraw.Draw(still)
    for _ in range(400):
        x, y = rng.uniform(0, still_size[0]), rng.uniform(0, still_size[1])
        tex.line((x, y, x + rng.uniform(-30, 30), y + rng.uniform(-3, 3)), fill=TABLE + rng.randint(-10, 10))
    offset = ((still_size[0] - document.width) // 2, (still_size[1] - document.height) // 2)
    mask = Image.new("L", document.size, 0)
    radius = round(0.035 * document.width)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, document.width - 1, document.height - 1), radius, fill=255)
    still.paste(document, offset, mask)
    return still, offset


# ---------------------------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------------------------
def render_td1(width_px: int, lines: list[str], rng: random.Random) -> Image.Image:
    """Back of a TD1 card, `width_px` wide: plain light background, a few lines of text, a
    QR-like block, and the code lines at the bottom."""
    ppm = width_px / TD1_MM[0] * SS
    w, h = round(TD1_MM[0] * ppm), round(TD1_MM[1] * ppm)
    img = Image.new("L", (w, h), PAPER)
    d = ImageDraw.Draw(img)
    small, value = sans(1.6 * ppm), sans(2.1 * ppm)
    d.text((4 * ppm, 5 * ppm), "REPUBLIQUE D'UTOPIE - REPUBLIC OF UTOPIA", font=small, fill=90, anchor="ls")
    d.text((4 * ppm, 9.5 * ppm), "SPECIMEN - NOT A REAL DOCUMENT", font=value, fill=INK, anchor="ls")
    rows = [
        ("ADRESSE / ADDRESS", "12 RUE DE L'EXEMPLE, UTOVILLE"),
        ("DELIVRE LE / ISSUED", "01.01.2025"),
        ("AUTORITE / AUTHORITY", "SPECIMEN OFFICE"),
    ]
    for i, (label, text) in enumerate(rows):
        base = (15 + i * 7) * ppm
        d.text((4 * ppm, base), label, font=small, fill=110, anchor="ls")
        d.text((4 * ppm, base + 3.2 * ppm), text, font=value, fill=INK, anchor="ls")
    pseudo_qr(d, 63 * ppm, 8 * ppm, 18 * ppm, rng, INK)
    baselines = [h - b * ppm for b in reversed(TD1_MRZ["baselinesFromBottomMm"])]
    draw_mrz(d, lines, TD1_MRZ["leftMm"] * ppm, baselines, ppm, INK)
    return reduce(img, (width_px, round(width_px * TD1_MM[1] / TD1_MM[0])))


def render_td3(width_px: int, lines: list[str], rng: random.Random) -> Image.Image:
    """Passport data page, `width_px` wide: faint guilloche, a portrait, printed fields and the
    code lines at the bottom."""
    ppm = width_px / TD3_MM[0] * SS
    w, h = round(TD3_MM[0] * ppm), round(TD3_MM[1] * ppm)
    img = Image.new("L", (w, h), PAPER)
    px = img.load()
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            v = PAPER - 7 * (1 + math.sin(x / (9 * ppm) * 2 * math.pi + 2 * math.sin(y / (13 * ppm) * 2 * math.pi)))
            for dy in (0, 1):
                for dx in (0, 1):
                    if x + dx < w and y + dy < h:
                        px[x + dx, y + dy] = round(v)
    d = ImageDraw.Draw(img)
    small, value = sans(1.5 * ppm), sans(2.2 * ppm)
    d.text((6 * ppm, 7 * ppm), "PASSEPORT / PASSPORT", font=value, fill=INK, anchor="ls")
    d.text((62 * ppm, 7 * ppm), "UTOPIE / UTOPIA - SPECIMEN", font=small, fill=90, anchor="ls")
    # Portrait: background, shoulders, face.
    x0, y0, pw, ph = 6 * ppm, 13 * ppm, 32 * ppm, 42 * ppm
    d.rectangle((x0, y0, x0 + pw, y0 + ph), fill=185)
    d.ellipse((x0 + 0.1 * pw, y0 + 0.62 * ph, x0 + 0.9 * pw, y0 + 1.3 * ph), fill=70)
    d.rectangle((x0, y0 + ph, x0 + pw, y0 + 1.3 * ph), fill=PAPER)
    d.ellipse((x0 + 0.3 * pw, y0 + 0.18 * ph, x0 + 0.7 * pw, y0 + 0.66 * ph), fill=150)
    fields = [
        ("Type / Type", "P"), ("Code / Code", "UTO"), ("No du passeport / Passport No.", "SP7654321"),
        ("Nom / Surname", "SPECIMEN"), ("Prenoms / Given names", "TEST PASSPORT"),
        ("Date de naissance / Date of birth", "04 JUL 1985"), ("Sexe / Sex", "M"),
        ("Date d'expiration / Date of expiry", "30 JUN 2033"),
    ]
    for i, (label, text) in enumerate(fields):
        col, row = (44, i) if i < 5 else (88, i - 5)
        base = (14 + row * 8) * ppm
        d.text((col * ppm, base), label, font=small, fill=105, anchor="ls")
        d.text((col * ppm, base + 3.4 * ppm), text, font=value, fill=INK, anchor="ls")
    # A signature.
    pts = [(46 * ppm + t * ppm, 60 * ppm + 2.5 * ppm * math.sin(t / 2.3)) for t in range(0, 30)]
    d.line(pts, fill=60, width=max(1, round(0.3 * ppm)))
    baselines = [h - b * ppm for b in reversed(TD3_MRZ["baselinesFromBottomMm"])]
    draw_mrz(d, lines, TD3_MRZ["leftMm"] * ppm, baselines, ppm, INK)
    return reduce(img, (width_px, round(width_px * TD3_MM[1] / TD3_MM[0])))


def render_strip(lines: list[str], mrz: dict, ppm: float, margin_mm: float = 1.5) -> tuple[Image.Image, dict]:
    """Code lines only, black on white, with `margin_mm` of white around the characters."""
    count, length = len(lines), len(lines[0])
    bases = mrz["baselinesFromBottomMm"]
    width_mm = length * CHAR_PITCH_MM + 2 * margin_mm
    # From the top line's capitals to the bottom baseline, plus the margins.
    height_mm = (bases[-1] - bases[0]) + CAP_HEIGHT_MM + 2 * margin_mm
    s = ppm * SS
    img = Image.new("L", (round(width_mm * s), round(height_mm * s)), 255)
    d = ImageDraw.Draw(img)
    bottom_base = (height_mm - margin_mm) * s
    baselines = [bottom_base - (b - bases[0]) * s for b in reversed(bases)]
    draw_mrz(d, lines, margin_mm * s, baselines, s, 0)
    out = reduce(img, (round(width_mm * ppm), round(height_mm * ppm)))
    placement = {
        # Where the strip goes on the document: its left and bottom edges, in mm from the
        # document's left and bottom edges.
        "leftMm": round(mrz["leftMm"] - margin_mm, 3),
        "bottomMm": round(bases[0] - margin_mm, 3),
    }
    return out, {"widthMm": round(width_mm, 3), "heightMm": round(height_mm, 3), "placementFromBottomLeft": placement}


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261014)
    td1, td3 = td1_lines(), td3_lines()
    stills = []

    # TD1 card back: the still is the guide plus 4%, the card fills the guide.
    def td1_still(width: int) -> tuple[Image.Image, dict, tuple[int, int, Image.Image]]:
        size = (width, round(width * TD1_MM[1] / TD1_MM[0]))
        card_w = round(width / 1.04)
        card = shade(render_td1(card_w, td1, rng), 0.9, 1.0)
        still, (ox, oy) = on_table(card, size, rng)
        common = {"document": "td1", "format": "TD1", "pxPerMm": round(card_w / TD1_MM[0], 3),
                  "documentRect": [ox, oy, card.width, card.height]}
        return still, common, (ox, oy, card)

    still, common, _ = td1_still(800)
    write_pgm(add_noise(still, 2.0, rng), out_dir / "td1-card.pgm")
    stills.append({"file": "td1-card.pgm", **common, "variant": "clean", "expect": "valid"})
    write_pgm(degrade(still, 1.0, rng), out_dir / "td1-card-degraded.pgm")
    stills.append({"file": "td1-card-degraded.pgm", **common, "variant": "blur 1.0 px, noise, JPEG q70",
                   "expect": "valid"})
    # The smear covers the middle of all three lines (document number, dates, names).
    still, common, (ox, oy, card) = td1_still(720)
    ppm = common["pxPerMm"]
    top = oy + card.height - (TD1_MRZ["baselinesFromBottomMm"][2] + CAP_HEIGHT_MM + 1.5) * ppm
    bottom = oy + card.height - (TD1_MRZ["baselinesFromBottomMm"][0] - 1.5) * ppm
    box = (ox + 9 * ppm, top, ox + 72 * ppm, bottom)
    write_pgm(add_noise(smudge(still, box), 2.0, rng), out_dir / "td1-card-smudged.pgm")
    stills.append({"file": "td1-card-smudged.pgm", **common, "variant": "smudged code lines",
                   "expect": "not_valid"})

    # TD3 passport page, as a passport held upright gives it (characters 14-15 px tall).
    for name, width, variant in (("td3-page.pgm", 816, "clean"), ("td3-page-degraded.pgm", 760, "degraded")):
        size = (width, round(width * TD3_MM[1] / TD3_MM[0]))
        page_w = round(width / 1.02)
        page = shade(render_td3(page_w, td3, rng), 0.88, 1.0)
        still, (ox, oy) = on_table(page, size, rng)
        common = {"document": "td3", "format": "TD3", "pxPerMm": round(page_w / TD3_MM[0], 3),
                  "documentRect": [ox, oy, page.width, page.height]}
        if variant == "clean":
            write_pgm(add_noise(still, 2.0, rng), out_dir / name)
        else:
            write_pgm(degrade(still, 0.8, rng), out_dir / name)
            variant = "blur 0.8 px, noise, JPEG q70"
        stills.append({"file": name, **common, "variant": variant, "expect": "valid"})

    # Bare code-line strips for the E2E fake camera.
    strips = []
    strip_ppm = 8.0
    for name, lines, mrz, smudged in (("td1-strip", td1, TD1_MRZ, False), ("td1-strip-smudged", td1, TD1_MRZ, True),
                                      ("td3-strip", td3, TD3_MRZ, False)):
        img, size = render_strip(lines, mrz, strip_ppm)
        if smudged:
            w, h = img.size
            img = smudge(img, (0.1 * w, -0.1 * h, 0.85 * w, 1.1 * h))
        write_pgm(img, out_dir / f"{name}.pgm")
        strips.append({"file": f"{name}.pgm", "document": name[:3], "format": name[:3].upper(),
                       "pxPerMm": strip_ppm, "smudged": smudged, **size})

    manifest = {
        "about": "Fictitious SPECIMEN documents (state UTO) for MRZ tests. Generated by "
                 "scripts/make-mrz-fixtures.py; do not edit by hand.",
        "font": "scripts/fonts/ocr-b/OCRB.otf",
        "charPitchMm": CHAR_PITCH_MM,
        "capHeightMm": CAP_HEIGHT_MM,
        "documents": {
            "td1": {"format": "TD1", "sizeMm": list(TD1_MM), "lines": td1, "mrz": TD1_MRZ},
            "td3": {"format": "TD3", "sizeMm": list(TD3_MM), "lines": td3, "mrz": TD3_MRZ},
        },
        "stills": stills,
        "strips": strips,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    total = sum(p.stat().st_size for p in out_dir.iterdir())
    print(f"wrote {len(stills) + len(strips)} images to {out_dir} ({total / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Renders the worker's test photos: our own fictitious documents, each marked SPECIMEN.

Every document type and side the worker may see, drawn from scratch with fake data: flat colours,
plain boxes and text in Inter (OFL-1.1, scripts/fonts/inter/) with code lines in OCR-B
(scripts/fonts/ocr-b/). No real security design is copied (no guilloches, emblems, holograms or
official layouts): the bilingual labels follow the decrees' field lists (see the M3 research notes),
the rest is invented. Names and numbers are obviously fake ("SPÉCIMEN", "ESSAI"...), code lines
have valid check digits, and the QR code (OpenCV's encoder) only says it is a test.

Each photo is what the worker receives from the rider app: the card on a table, cut as the capture
guide plus 2% on each side, as a JPEG. The new cards' upright fronts are turned sideways to fit the
landscape guide, as a rider would hold them.

These images test the plumbing (decoding, rotation, code-line candidates, keyword evidence, field
reading). Because we drew the keywords ourselves, they prove nothing about accuracy on real cards.

Outputs (committed): e2e/fixtures/specimens/*.jpg and manifest.json, with each photo's expected
document family, code lines, fields and orientation. Dev only, run with the worker's environment:

    cd worker && uv run python ../scripts/make-specimens.py [OUT_DIR]
"""

from __future__ import annotations

import io
import json
import random
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "scripts" / "fonts"
SANS = FONTS / "inter" / "Inter-Regular.ttf"
SANS_BOLD = FONTS / "inter" / "Inter-Bold.ttf"
OCRB = FONTS / "ocr-b" / "OCRB.otf"
DEFAULT_OUT = ROOT / "e2e" / "fixtures" / "specimens"

CARD_MM = (85.6, 53.98)
TD3_MM = (125.0, 88.0)
# ICAO 9303: 10 characters per inch; OCR-B capitals about 2.4 mm tall.
CHAR_PITCH_MM = 2.54
CAP_HEIGHT_MM = 2.4
TD1_MRZ = {"left": 4.7, "baselines_from_bottom": [12.2, 7.9, 3.6]}
TD3_MRZ = {"left": 6.6, "baselines_from_bottom": [9.2, 4.6]}
# Drawing resolution, and the long side of the photos written.
PX_PER_MM = 16
OUTPUT_LONG_SIDE = 1280
JPEG_QUALITY = 80
EXPOSURE = 0.92
QR_TEXT = "SPECIMEN - CONFIANCE VERIFY TEST - NOT A REAL DOCUMENT"

INK = (24, 28, 32)
LABEL_INK = (70, 76, 84)
RED = (196, 30, 36)
TABLE = (92, 78, 66)


# ---------------------------------------------------------------------------------------------
# Code lines with valid check digits
# ---------------------------------------------------------------------------------------------
def char_value(c: str) -> int:
    if c.isdigit():
        return int(c)
    if "A" <= c <= "Z":
        return ord(c) - 55
    if c == "<":
        return 0
    raise ValueError(c)


def check_digit(text: str) -> str:
    return str(sum(char_value(c) * (7, 3, 1)[i % 3] for i, c in enumerate(text)) % 10)


def pad(text: str, length: int) -> str:
    assert len(text) <= length, text
    return text + "<" * (length - len(text))


def mrz_name(surname: str, given: str) -> str:
    def clean(s: str) -> str:
        table = str.maketrans("ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ-' ", "AAACEEEEIIOOUUUY<<<")
        return s.upper().translate(table)

    return clean(surname) + "<<" + clean(given)


def td1(code: str, state: str, number: str, birth: str, sex: str, expiry: str, nationality: str, surname: str, given: str) -> list[str]:
    l1 = pad(code + state + number + check_digit(number), 30)
    l2 = pad(birth + check_digit(birth) + sex + expiry + check_digit(expiry) + nationality, 29)
    l2 += check_digit(l1[5:30] + l2[0:7] + l2[8:15] + l2[18:29])
    l3 = pad(mrz_name(surname, given), 30)[:30]
    return [l1, l2, l3]


def td3(state: str, number: str, nationality: str, birth: str, sex: str, expiry: str, surname: str, given: str, personal: str = "") -> list[str]:
    l1 = pad("P<" + state + mrz_name(surname, given), 44)[:44]
    personal = pad(personal, 14)
    l2 = number + check_digit(number) + nationality + birth + check_digit(birth) + sex + expiry + check_digit(expiry) + personal + check_digit(personal)
    l2 += check_digit(l2[0:10] + l2[13:20] + l2[21:43])
    assert len(l2) == 44
    return [l1, l2]


# ---------------------------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------------------------
_font_cache: dict[tuple[Path, int], ImageFont.FreeTypeFont] = {}


def font(path: Path, cap_px: float) -> ImageFont.FreeTypeFont:
    """The font at the size whose capitals are `cap_px` tall."""
    probe = _font_cache.get((path, 200)) or ImageFont.truetype(str(path), 200)
    _font_cache[(path, 200)] = probe
    _, top, _, bottom = probe.getbbox("H", anchor="ls")
    size = max(1, round(200 * cap_px / (bottom - top)))
    key = (path, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(str(path), size)
    return _font_cache[key]


class Side:
    """One face of a document, drawn in millimetres."""

    def __init__(self, size_mm: tuple[float, float], background: tuple[int, int, int], accent: tuple[int, int, int]):
        self.w_mm, self.h_mm = size_mm
        self.img = Image.new("RGB", (round(self.w_mm * PX_PER_MM), round(self.h_mm * PX_PER_MM)), background)
        self.draw = ImageDraw.Draw(self.img)
        self.accent = accent
        # Label type size; a passport page is bigger than a card, so the same type is smaller in a photo.
        self.label_cap = 1.05 if size_mm[0] < 100 else 1.35
        # A plain, darker frame line and a soft colour wash (no security pattern).
        wash = Image.new("RGB", self.img.size, accent)
        mask = Image.linear_gradient("L").resize(self.img.size).point(lambda v: v // 9)
        self.img.paste(Image.composite(wash, self.img, mask))
        self.draw = ImageDraw.Draw(self.img)

    def px(self, mm: float) -> int:
        return round(mm * PX_PER_MM)

    def text(self, x: float, y: float, text: str, cap_mm: float = 1.7, bold: bool = False, fill=INK, anchor: str = "ls") -> None:
        """Text with its baseline at y (mm)."""
        self.draw.text((self.px(x), self.px(y)), text, font=font(SANS_BOLD if bold else SANS, cap_mm * PX_PER_MM), fill=fill, anchor=anchor)

    def field(self, x: float, y: float, label: str, value: str | None, value_cap: float = 1.9) -> float:
        """A bilingual label in small type with its value below; returns the y of the next field."""
        self.text(x, y, label, cap_mm=self.label_cap, fill=LABEL_INK)
        if value is not None:
            self.text(x, y + 2.9, value, cap_mm=value_cap, bold=True)
        return y + 6.2

    def field2(self, x: float, y: float, label_fr: str, label_en: str, value: str, value_cap: float = 1.8) -> float:
        """A label stacked in two lines (French above English), then its value."""
        self.text(x, y, label_fr, cap_mm=1.05, fill=LABEL_INK)
        self.text(x, y + 2.1, label_en, cap_mm=1.05, fill=LABEL_INK)
        self.text(x, y + 5.0, value, cap_mm=value_cap, bold=True)
        return y + 8.3

    def inline(self, x: float, y: float, label: str, value: str, value_x: float) -> None:
        """Label and value on one row (older documents)."""
        self.text(x, y, label, cap_mm=1.15, fill=LABEL_INK)
        self.text(value_x, y, value, cap_mm=1.7, bold=True)

    def band(self, y0: float, y1: float, colour: tuple[int, int, int]) -> None:
        self.draw.rectangle((0, self.px(y0), self.img.width, self.px(y1)), fill=colour)

    def header(self, lines: list[str], y: float = 4.6, cap: float = 1.55, x: float | None = None) -> None:
        for i, line in enumerate(lines):
            if x is None:
                self.text(self.w_mm / 2, y + i * 2.9, line, cap_mm=cap, bold=True, anchor="ms")
            else:
                self.text(x, y + i * 2.9, line, cap_mm=cap, bold=True)

    def photo(self, x: float, y: float, w: float, h: float) -> None:
        """A grey portrait placeholder with a plain silhouette, stamped SPECIMEN."""
        x0, y0, x1, y1 = self.px(x), self.px(y), self.px(x + w), self.px(y + h)
        self.draw.rectangle((x0, y0, x1, y1), fill=(196, 200, 204), outline=(120, 124, 130), width=2)
        cx = (x0 + x1) / 2
        r = (x1 - x0) * 0.22
        self.draw.ellipse((cx - r, y0 + (y1 - y0) * 0.18, cx + r, y0 + (y1 - y0) * 0.18 + 2.4 * r), fill=(150, 154, 160))
        self.draw.rounded_rectangle((x0 + (x1 - x0) * 0.12, y0 + (y1 - y0) * 0.68, x1 - (x1 - x0) * 0.12, y1 - 2), radius=int(r), fill=(150, 154, 160))
        self.stamp(x + w / 2, y + h / 2, cap_mm=2.0, angle=30)

    def stamp(self, x: float, y: float, cap_mm: float = 2.2, angle: float = 0) -> None:
        """A red SPECIMEN mark centred at (x, y)."""
        f = font(SANS_BOLD, cap_mm * PX_PER_MM)
        box = f.getbbox("SPECIMEN")
        tile = Image.new("RGBA", (box[2] + 20, box[3] + 20), (0, 0, 0, 0))
        ImageDraw.Draw(tile).text((10, 10), "SPECIMEN", font=f, fill=RED + (230,))
        tile = tile.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
        self.img.paste(tile, (self.px(x) - tile.width // 2, self.px(y) - tile.height // 2), tile)
        self.draw = ImageDraw.Draw(self.img)

    def mrz(self, lines: list[str], layout: dict) -> None:
        f = font(OCRB, CAP_HEIGHT_MM * PX_PER_MM)
        pitch = CHAR_PITCH_MM * PX_PER_MM
        clear_top = self.h_mm - layout["baselines_from_bottom"][0] - CAP_HEIGHT_MM - 2.0
        self.draw.rectangle((0, self.px(clear_top), self.img.width, self.img.height), fill=(236, 236, 228))
        for line, from_bottom in zip(lines, layout["baselines_from_bottom"], strict=True):
            base = self.px(self.h_mm - from_bottom)
            for i, char in enumerate(line):
                self.draw.text((self.px(layout["left"]) + i * pitch, base), char, font=f, fill=INK, anchor="ls")

    def qr(self, x: float, y: float, size: float) -> None:
        code = cv2.QRCodeEncoder.create().encode(QR_TEXT)
        side = self.px(size)
        img = Image.fromarray(code).resize((side, side), Image.Resampling.NEAREST).convert("RGB")
        self.img.paste(img, (self.px(x), self.px(y)))
        self.draw = ImageDraw.Draw(self.img)


# ---------------------------------------------------------------------------------------------
# Capture simulation
# ---------------------------------------------------------------------------------------------
def capture(card: Image.Image, rng: random.Random, turn: int = 0, fill: float = 0.965) -> Image.Image:
    """The card (turned `turn` degrees clockwise first) on a table, cut as the guide plus 2% per side.
    The card fills `fill` of the guide, slightly off centre, then the photo is reduced and noised."""
    if turn:
        card = card.rotate(-turn, expand=True)
    gw = card.width / fill
    gh = card.height / fill
    w = round(gw * 1.04)
    h = round(gh * 1.04)
    out = table_only(w, h, rng)
    # A soft shadow under the card, then the card.
    x = round((w - card.width) / 2 + rng.uniform(-0.006, 0.006) * w)
    y = round((h - card.height) / 2 + rng.uniform(-0.006, 0.006) * h)
    shadow = Image.new("L", out.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x + 8, y + 10, x + card.width + 8, y + card.height + 10), radius=40, fill=120)
    out = Image.composite(Image.new("RGB", out.size, (40, 34, 30)), out, shadow.filter(ImageFilter.GaussianBlur(12)))
    mask = Image.new("L", card.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, card.width - 1, card.height - 1), radius=round(3.18 * PX_PER_MM), fill=255)
    out.paste(card, (x, y), mask)
    scale = OUTPUT_LONG_SIDE / max(out.size)
    out = out.resize((round(out.width * scale), round(out.height * scale)), Image.Resampling.LANCZOS)
    # Indoor exposure: a white card averages about 200 rather than 230.
    noisy = np.asarray(out, dtype=np.float32) * EXPOSURE + np.random.default_rng(rng.randrange(1 << 30)).normal(0, 2.0, (out.height, out.width, 1))
    return Image.fromarray(np.clip(noisy, 0, 255).astype(np.uint8))


def table_only(w: int, h: int, rng: random.Random) -> Image.Image:
    """A plain, slightly grainy table top."""
    table = np.full((h, w, 3), TABLE, dtype=np.float32)
    table += np.random.default_rng(rng.randrange(1 << 30)).normal(0, 6, (h, w, 1)).astype(np.float32)
    return Image.fromarray(np.clip(table, 0, 255).astype(np.uint8))


def glare(img: Image.Image, cx: float, cy: float, r: float) -> Image.Image:
    """A blown-out reflection centred at (cx, cy) (fractions of the photo), radius r of its width."""
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot(xx - cx * w, (yy - cy * h)) / (r * w)
    boost = np.clip(1.6 - d, 0, 1)[..., None] * 255
    out = np.clip(np.asarray(img, dtype=np.float32) + boost, 0, 255)
    return Image.fromarray(out.astype(np.uint8))


def jpeg_bytes(img: Image.Image, quality: int = JPEG_QUALITY) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------------------------
# The documents (all data fictitious)
# ---------------------------------------------------------------------------------------------
REPUBLIC = ["RÉPUBLIQUE DU CAMEROUN", "REPUBLIC OF CAMEROON"]


@dataclass
class Photo:
    file: str
    document: str
    side: str
    declared: str
    family: str
    basis: str
    image: Image.Image
    rotation: int = 0
    orientation: str = "landscape"
    mrz: dict | None = None
    printed: dict = field(default_factory=dict)
    expect_fields: dict = field(default_factory=dict)
    subtype: str | None = None
    qr: bool = False
    variant: str = "clean"
    expect: dict = field(default_factory=dict)
    # Values printed for fields the worker must never read (parents, place of birth...).
    never: list = field(default_factory=list)


MRZ_FIELDS = ("surname", "givenNames", "issueDate")
ALL_FIELDS = ("surname", "givenNames", "documentNumber", "birthDate", "expiryDate", "issueDate")


def ascii_upper(text: str) -> str:
    """Names as the worker sends them: upper-case ASCII (the server accepts nothing else)."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).upper()


def expected(printed: dict, has_mrz: bool) -> dict:
    """The fields the worker should read from a side: names and the issue date when the document has
    code lines, every printed field it reads otherwise."""
    keep = MRZ_FIELDS if has_mrz else ALL_FIELDS
    return {k: ascii_upper(v) if k in ("surname", "givenNames") else v for k, v in printed.items() if k in keep}


def new_card_front(title: list[str], colours, person: dict, number: str) -> Image.Image:
    """Front of the 2025-style cards: upright (portrait)."""
    s = Side((CARD_MM[1], CARD_MM[0]), *colours)
    s.band(0, 11.5, colours[1])
    s.header(REPUBLIC, y=4.4, cap=1.45)
    s.text(s.w_mm / 2, 15.6, title[0], cap_mm=1.75, bold=True, anchor="ms")
    s.text(s.w_mm / 2, 18.6, title[1], cap_mm=1.45, bold=True, anchor="ms", fill=LABEL_INK)
    s.photo(4, 22, 19, 24)
    s.text(4, 50.5, number, cap_mm=1.6, bold=True)
    y = 25.0
    y = s.field(25.5, y, "NOM / SURNAME", person["surname"])
    y = s.field(25.5, y, "PRÉNOMS / GIVEN NAMES", person["given"], value_cap=1.6)
    y = s.field(25.5, y, "SEXE / SEX", person["sex"])
    s.field2(25.5, y, "DATE DE NAISSANCE", "DATE OF BIRTH", person["birth_print"])
    s.text(4, 60, "DATE D'EXPIRATION / DATE OF EXPIRY", cap_mm=1.05, fill=LABEL_INK)
    s.text(4, 63, person["expiry_print"], cap_mm=1.8, bold=True)
    s.text(4, 70, "SIGNATURE", cap_mm=1.0, fill=LABEL_INK)
    s.draw.line((s.px(4), s.px(76), s.px(30), s.px(74)), fill=INK, width=3)
    s.stamp(s.w_mm / 2, 81.5, cap_mm=2.6)
    return s.img


def new_card_back(colours, person: dict, extra: list[tuple[str, str]], lines: list[str]) -> Image.Image:
    """Back of the 2025-style cards: landscape, QR code top left, code lines at the bottom."""
    s = Side(CARD_MM, *colours)
    s.qr(3.5, 3.5, 17)
    y = 5.5
    x = 24
    for label, value in extra:
        s.text(x, y, label, cap_mm=1.0, fill=LABEL_INK)
        s.text(x, y + 2.7, value, cap_mm=1.6, bold=True)
        y += 5.6
        if y > 30:
            y = 5.5
            x = 56
    s.stamp(12, 26, cap_mm=1.6)
    s.mrz(lines, TD1_MRZ)
    return s.img


def build(rng: random.Random) -> list[Photo]:
    photos: list[Photo] = []

    # --- New CNI (2025 model): portrait front, TD1 back (CMR / CMR), QR code ---------------------
    cni = {
        "surname": "SPÉCIMEN",
        "given": "HÉLÈNE TEST",
        "sex": "F",
        "birth_print": "15.02.1990",
        "expiry_print": "02.03.2035",
    }
    green = ((222, 238, 218), (110, 170, 120))
    cni_lines = td1("ID", "CMR", "SPC000123", "900215", "F", "350302", "CMR", cni["surname"], cni["given"])
    front = new_card_front(["CARTE NATIONALE D'IDENTITÉ", "NATIONAL IDENTITY CARD"], green, cni, "SPC000123")
    printed = {"surname": "SPÉCIMEN", "givenNames": "HÉLÈNE TEST", "documentNumber": "SPC000123", "birthDate": "1990-02-15", "expiryDate": "2035-03-02"}
    photos.append(Photo("cni-new-front.jpg", "cni_new", "document_front", "cni_biometric", "cni_biometric", "mrz",
                        capture(front, rng, turn=-90), rotation=90, orientation="portrait", printed=printed,
                        expect_fields=expected(printed, True)))
    # The parents' names are long capitals starting like a code line (P..., C...), with the length of
    # one: the worker must still never send them anywhere, code-line candidates included. They sit
    # on rows of their own (the second column holds only two fields).
    father, mother = "PAPA ESSAI SPECIMEN EXEMPLAIRE", "CHRISTELLE ESSAI MAMAN SPECIMEN"
    back = new_card_back(green, cni, [
        ("LIEU DE NAISSANCE / PLACE OF BIRTH", "VILLE-TEST"),
        ("PROFESSION / OCCUPATION", "TESTEUSE"),
        ("PÈRE / FATHER", father),
        ("MÈRE / MOTHER", mother),
        ("TAILLE / HEIGHT", "1,65 M"),
        ("DATE DE DÉLIVRANCE / DATE OF ISSUE", "02.03.2025"),
        ("IDENTIFIANT UNIQUE / UNIQUE IDENTIFIER", "12345678901234567"),
    ], cni_lines)
    printed = {"issueDate": "2025-03-02"}
    photos.append(Photo("cni-new-back.jpg", "cni_new", "document_back", "cni_biometric", "cni_biometric", "mrz",
                        capture(back, rng), mrz={"format": "TD1", "lines": cni_lines}, printed=printed,
                        expect_fields=expected(printed, True), qr=True,
                        never=[father, mother, "VILLE-TEST", "TESTEUSE", "1,65 M", "12345678901234567"]))
    photos.append(Photo("cni-new-back-jpeg.jpg", "cni_new", "document_back", "cni_biometric", "cni_biometric", "mrz",
                        _small(capture(back, rng), 1000),
                        mrz={"format": "TD1", "lines": cni_lines}, printed=printed, expect_fields={}, qr=True,
                        variant="1000 px, JPEG q35", expect={"jpegQuality": 35}))

    # --- Old CNI (2016 model): landscape, no code lines, no QR --------------------------------------
    old = Side(CARD_MM, (232, 236, 226), (150, 180, 150))
    old.header(REPUBLIC, y=4.2, cap=1.5)
    old.text(42.8, 10.6, "CARTE NATIONALE D'IDENTITÉ / NATIONAL IDENTITY CARD", cap_mm=1.35, bold=True, anchor="ms", fill=(40, 90, 50))
    old.photo(4, 14, 20, 26)
    y = 15.5
    for label, value in (("NOM / SURNAME", "EXEMPLE"), ("PRÉNOMS / GIVEN NAMES", "JEAN-PAUL ESSAI"), ("DATE DE NAISSANCE / DATE OF BIRTH", "07.11.1984"),
                         ("LIEU DE NAISSANCE / PLACE OF BIRTH", "VILLE-TEST"), ("SEXE / SEX", "M")):
        y = old.field(27, y, label, value)
    old.text(27, y, "TAILLE / HEIGHT", cap_mm=1.05, fill=LABEL_INK)
    old.text(27, y + 2.9, "1,78 M", cap_mm=1.8, bold=True)
    old.text(52, y, "PROFESSION / OCCUPATION", cap_mm=1.05, fill=LABEL_INK)
    old.text(52, y + 2.9, "TESTEUR", cap_mm=1.8, bold=True)
    old.stamp(66, 20, cap_mm=2.6, angle=12)
    old.text(4, 50, "SIGNATURE", cap_mm=1.0, fill=LABEL_INK)
    printed = {"surname": "EXEMPLE", "givenNames": "JEAN-PAUL ESSAI", "birthDate": "1984-11-07"}
    old_front = capture(old.img, rng)
    photos.append(Photo("cni-old-front.jpg", "cni_old", "document_front", "cni_legacy", "cni_legacy", "keywords",
                        old_front, printed=printed, expect_fields=expected(printed, False), never=["VILLE-TEST", "1,78 M", "TESTEUR"]))
    photos.append(Photo("cni-old-front-glare.jpg", "cni_old", "document_front", "cni_legacy", "cni_legacy", "keywords",
                        glare(old_front, 0.72, 0.38, 0.11), printed=printed, expect_fields={}, variant="glare",
                        expect={"glare": True}))
    oldb = Side(CARD_MM, (232, 236, 226), (150, 180, 150))
    y = 5.5
    for label, value in (("PÈRE / FATHER", "ESSAI PÈRE"), ("MÈRE / MOTHER", "ESSAI MÈRE"), ("ADRESSE / ADDRESS", "RUE DU TEST"),
                         ("SIGNES PARTICULIERS / DISTINGUISHING MARKS", "NÉANT")):
        y = oldb.field(4, y, label, value, value_cap=1.6)
    oldb.field(4, y, "DATE DE DÉLIVRANCE / DATE OF ISSUE", "12.05.2019")
    oldb.field(44, y, "DATE D'EXPIRATION / DATE OF EXPIRY", "12.05.2029")
    y += 6.2
    oldb.field(4, y, "IDENTIFIANT UNIQUE / UNIQUE IDENTIFIER", "98765432109876543", value_cap=1.6)
    oldb.field(52, 8, "N° DE CARTE / CARD No", "100200300")
    oldb.stamp(62, 22, cap_mm=2.4, angle=-10)
    oldb.text(42.8, 51.5, "CAMEROUN", cap_mm=2.4, bold=True, anchor="ms", fill=(40, 90, 50))
    printed = {"issueDate": "2019-05-12", "expiryDate": "2029-05-12", "documentNumber": "100200300"}
    photos.append(Photo("cni-old-back.jpg", "cni_old", "document_back", "cni_legacy", "cni_legacy", "keywords",
                        capture(oldb.img, rng), printed=printed, expect_fields=expected(printed, False),
                        never=["ESSAI PÈRE", "ESSAI MÈRE", "RUE DU TEST", "NÉANT", "98765432109876543"]))

    # --- Cameroonian passport data page (TD3) -----------------------------------------------------
    pp = Side(TD3_MM, (226, 238, 228), (120, 170, 130))
    pp.band(0, 9, (120, 170, 130))
    pp.header(REPUBLIC, y=3.8, cap=1.5)
    pp.text(62.5, 13.6, "PASSEPORT / PASSPORT", cap_mm=2.0, bold=True, anchor="ms")
    pp.photo(5, 17, 30, 40)
    pp.field(40, 18, "TYPE", "P")
    pp.field(49, 18, "CODE DU PAYS / COUNTRY CODE", "CMR")
    pp.field(86, 18, "N° DE PASSEPORT / PASSPORT No", "SP7654321")
    pp.field(40, 24.6, "NOM / SURNAME", "ÉCHANTILLON")
    pp.field(40, 31.2, "PRÉNOMS / GIVEN NAMES", "FRANÇOIS ESSAI")
    pp.field(40, 37.8, "NATIONALITÉ / NATIONALITY", "CAMEROUNAISE")
    pp.field(84, 37.8, "SEXE / SEX", "M")
    pp.field(40, 44.4, "DATE DE NAISSANCE / DATE OF BIRTH", "04 JUIL/JUL 1985")
    pp.field(84, 44.4, "LIEU DE NAISSANCE / PLACE OF BIRTH", "VILLE-TEST")
    pp.field(40, 51.0, "DATE DE DÉLIVRANCE / DATE OF ISSUE", "30 JUIN/JUN 2023")
    pp.field(84, 51.0, "DATE D'EXPIRATION / DATE OF EXPIRY", "30 JUIN/JUN 2028")
    pp.field(40, 57.6, "AUTORITÉ / AUTHORITY", "DGSN TEST")
    pp.stamp(100, 63, cap_mm=3.0, angle=8)
    pp_lines = td3("CMR", "SP7654321", "CMR", "850704", "M", "280630", "ÉCHANTILLON", "FRANÇOIS ESSAI")
    pp.mrz(pp_lines, TD3_MRZ)
    printed = {"surname": "ÉCHANTILLON", "givenNames": "FRANÇOIS ESSAI", "issueDate": "2023-06-30", "birthDate": "1985-07-04", "expiryDate": "2028-06-30"}
    pp_photo = capture(pp.img, rng)
    photos.append(Photo("passport-cmr.jpg", "passport_cmr", "document_front", "passport", "passport", "mrz", pp_photo,
                        mrz={"format": "TD3", "lines": pp_lines}, printed=printed, expect_fields=expected(printed, True),
                        never=["VILLE-TEST", "DGSN TEST", "CAMEROUNAISE"]))
    photos.append(Photo("passport-cmr-blur.jpg", "passport_cmr", "document_front", "passport", "passport", "mrz",
                        pp_photo.filter(ImageFilter.GaussianBlur(8)), mrz={"format": "TD3", "lines": pp_lines},
                        printed=printed, expect_fields={}, variant="out of focus (Gaussian blur, 8 px)", expect={"blurry": True}))

    # --- Foreign passport (state UTO, English only) ---------------------------------------------
    up = Side(TD3_MM, (236, 232, 244), (160, 140, 190))
    up.band(0, 9, (160, 140, 190))
    up.header(["REPUBLIC OF UTOPIA"], y=6.0, cap=1.8)
    up.text(62.5, 14.0, "PASSPORT", cap_mm=2.2, bold=True, anchor="ms")
    up.photo(5, 17, 30, 40)
    up.field(40, 18, "Type", "P")
    up.field(62, 18, "Code", "UTO")
    up.field(92, 18, "Passport No.", "UT1234567")
    up.field(40, 24.6, "Surname", "MODEL")
    up.field(40, 31.2, "Given names", "ALEX SAMPLE")
    up.field(40, 37.8, "Nationality", "UTOPIAN")
    up.field(92, 37.8, "Sex", "X")
    up.field(40, 44.4, "Date of birth", "12 MAR 1979")
    up.field(40, 51.0, "Date of issue", "01 SEP 2022")
    up.field(92, 51.0, "Date of expiry", "31 AUG 2032")
    up.stamp(100, 63, cap_mm=3.0, angle=-8)
    up_lines = td3("UTO", "UT1234567", "UTO", "790312", "<", "320831", "MODEL", "ALEX SAMPLE")
    up.mrz(up_lines, TD3_MRZ)
    printed = {"surname": "MODEL", "givenNames": "ALEX SAMPLE", "issueDate": "2022-09-01", "birthDate": "1979-03-12", "expiryDate": "2032-08-31"}
    up_photo = capture(up.img, rng)
    photos.append(Photo("passport-uto.jpg", "passport_uto", "document_front", "passport", "passport", "mrz", up_photo,
                        mrz={"format": "TD3", "lines": up_lines}, printed=printed, expect_fields=expected(printed, True)))
    photos.append(Photo("passport-uto-upside-down.jpg", "passport_uto", "document_front", "passport", "passport", "mrz",
                        up_photo.rotate(180), rotation=180, mrz={"format": "TD3", "lines": up_lines}, printed=printed,
                        expect_fields=expected(printed, True), variant="upside down"))

    # --- New foreigner cards (TD1 issued by CMR, nationality not CMR) ----------------------------
    for key, title, colours, turn, rotation, code_nat, person in (
        ("sejour_new", ["CARTE DE SÉJOUR", "RESIDENCE PERMIT"], ((246, 218, 228), (210, 120, 150)), -90, 90, "UTO",
         {"surname": "DÉMO", "given": "AÏCHA ESSAI", "sex": "F", "birth": "880521", "birth_print": "21.05.1988", "expiry": "270415", "expiry_print": "15.04.2027", "issue": "15.04.2025", "number": "SJ0004242", "subtype": "carte_de_sejour"}),
        ("resident_new", ["CARTE DE RÉSIDENT", "RESIDENCE CARD"], ((250, 224, 196), (225, 150, 80)), 90, 270, "UTO",
         {"surname": "FICTIF", "given": "OMAR TEST", "sex": "M", "birth": "760930", "birth_print": "30.09.1976", "expiry": "350601", "expiry_print": "01.06.2035", "issue": "01.06.2025", "number": "RS0001717", "subtype": "carte_de_resident"}),
        ("refugee_new", ["CARTE DE RÉFUGIÉ", "REFUGEE CARD"], ((228, 228, 228), (150, 150, 150)), -90, 90, "XXC",
         {"surname": "ESSAI", "given": "GRÂCE EXEMPLE", "sex": "F", "birth": "950117", "birth_print": "17.01.1995", "expiry": "270910", "expiry_print": "10.09.2027", "issue": "10.09.2025", "number": "RF0000808", "subtype": "refugee"}),
    ):
        lines = td1("IR", "CMR", person["number"], person["birth"], person["sex"], person["expiry"], code_nat, person["surname"], person["given"])
        front = new_card_front(title, colours, person, person["number"])
        printed = {"surname": person["surname"], "givenNames": person["given"], "documentNumber": person["number"],
                   "birthDate": _iso(person["birth_print"]), "expiryDate": _iso(person["expiry_print"])}
        photos.append(Photo(f"{key.replace('_', '-')}-front.jpg", key, "document_front", "residence_permit", "residence_permit", "mrz",
                            capture(front, rng, turn=turn), rotation=rotation, orientation="portrait", printed=printed,
                            expect_fields=expected(printed, True), subtype=person["subtype"]))
        nationality = "UTOPIENNE" if code_nat == "UTO" else "INDÉTERMINÉE"
        back = new_card_back(colours, person, [
            ("NATIONALITÉ / NATIONALITY", nationality),
            ("PROFESSION / OCCUPATION", "TESTEUR"),
            ("TAILLE / HEIGHT", "1,70 M"),
            ("DATE DE DÉLIVRANCE / DATE OF ISSUE", person["issue"]),
            ("IDENTIFIANT UNIQUE / UNIQUE IDENTIFIER", "24681357924681357"),
        ], lines)
        printed = {"issueDate": _iso(person["issue"])}
        photos.append(Photo(f"{key.replace('_', '-')}-back.jpg", key, "document_back", "residence_permit", "residence_permit", "mrz",
                            capture(back, rng), mrz={"format": "TD1", "lines": lines}, printed=printed,
                            expect_fields=expected(printed, True), qr=True,
                            never=[nationality, "TESTEUR", "1,70 M", "24681357924681357"]))

    # --- Old cards without code lines: blue residence permit, red refugee card --------------------
    for key, title, colours, person in (
        ("permit_old", ["CARTE DE SÉJOUR / RESIDENCE PERMIT"], ((216, 228, 246), (120, 150, 200)),
         {"surname": "EXEMPLE", "given": "MARIA TEST", "birth": "03.04.1981", "nat": "UTOPIENNE", "issue": "20.01.2024", "expiry": "20.01.2026", "number": "BP0031415", "subtype": "carte_de_sejour"}),
        ("refugee_old", ["CARTE DE RÉFUGIÉ / REFUGEE CARD"], ((244, 214, 210), (200, 110, 100)),
         {"surname": "MODÈLE", "given": "DAVID ESSAI", "birth": "11.12.1990", "nat": "INDÉTERMINÉE", "issue": "05.07.2023", "expiry": "05.07.2025", "number": "RR0027182", "subtype": "refugee"}),
    ):
        f = Side(CARD_MM, *colours)
        f.header(["REPUBLIC OF CAMEROON / RÉPUBLIQUE DU CAMEROUN"], y=4.6, cap=1.45)
        f.text(42.8, 9.6, title[0], cap_mm=1.5, bold=True, anchor="ms", fill=RED)
        f.photo(4, 13, 20, 26)
        y = 15
        for label, value in (("NOM / SURNAME", person["surname"]), ("PRÉNOMS / GIVEN NAMES", person["given"]),
                             ("DATE DE NAISSANCE / DATE OF BIRTH", person["birth"]), ("NATIONALITÉ / NATIONALITY", person["nat"])):
            y = f.field(27, y, label, value)
        f.stamp(68, 46, cap_mm=2.4, angle=10)
        printed = {"surname": person["surname"], "givenNames": person["given"], "birthDate": _iso(person["birth"])}
        photos.append(Photo(f"{key.replace('_', '-')}-front.jpg", key, "document_front", "residence_permit", "residence_permit", "keywords",
                            capture(f.img, rng), printed=printed, expect_fields=expected(printed, False), subtype=person["subtype"],
                            never=[person["nat"]]))
        b = Side(CARD_MM, *colours)
        y = 6
        y = b.field(4, y, "ADRESSE / ADDRESS", "RUE DU TEST", value_cap=1.6)
        y = b.field(4, y, "SIGNES PARTICULIERS / DISTINGUISHING MARKS", "NÉANT", value_cap=1.6)
        b.field(4, y, "DATE DE DÉLIVRANCE / DATE OF ISSUE", person["issue"])
        b.field(44, y, "DATE D'EXPIRATION / DATE OF EXPIRY", person["expiry"])
        y += 6.2
        b.field(4, y, "N° DE CARTE / CARD No", person["number"])
        b.stamp(64, 44, cap_mm=2.4, angle=-10)
        b.text(42.8, 51.5, "CAMEROON", cap_mm=2.2, bold=True, anchor="ms")
        printed = {"issueDate": _iso(person["issue"]), "expiryDate": _iso(person["expiry"]), "documentNumber": person["number"]}
        photos.append(Photo(f"{key.replace('_', '-')}-back.jpg", key, "document_back", "residence_permit", "residence_permit", "keywords",
                            capture(b.img, rng), printed=printed, expect_fields=expected(printed, False), subtype=None,
                            never=["RUE DU TEST", "NÉANT"]))

    # --- Driving licence --------------------------------------------------------------------------
    dl = Side(CARD_MM, (246, 236, 220), (200, 160, 110))
    dl.header(REPUBLIC, y=4.2, cap=1.45)
    dl.text(42.8, 10.4, "PERMIS DE CONDUIRE / DRIVING LICENCE", cap_mm=1.6, bold=True, anchor="ms", fill=(150, 60, 40))
    dl.photo(4, 14, 20, 26)
    dl.inline(27, 17, "1. NOM / SURNAME", "TESTEUR", 52)
    dl.inline(27, 22, "2. PRÉNOMS / GIVEN NAMES", "PAUL ESSAI", 52)
    dl.inline(27, 27, "3. DATE DE NAISSANCE / DATE OF BIRTH", "", 52)
    dl.text(27, 30.2, "01/06/1992", cap_mm=1.7, bold=True)
    dl.inline(27, 35, "4a. DATE DE DÉLIVRANCE / DATE OF ISSUE", "", 52)
    dl.text(27, 38.2, "14/02/2022", cap_mm=1.7, bold=True)
    dl.inline(27, 43, "4b. DATE D'EXPIRATION / DATE OF EXPIRY", "", 52)
    dl.text(27, 46.2, "13/02/2032", cap_mm=1.7, bold=True)
    dl.text(4, 46, "5. N° DU PERMIS / LICENCE No", cap_mm=1.0, fill=LABEL_INK)
    dl.text(4, 49.5, "DL0042424", cap_mm=1.7, bold=True)
    dl.stamp(70, 30, cap_mm=2.4, angle=15)
    printed = {"surname": "TESTEUR", "givenNames": "PAUL ESSAI", "birthDate": "1992-06-01", "issueDate": "2022-02-14", "expiryDate": "2032-02-13", "documentNumber": "DL0042424"}
    dl_photo = capture(dl.img, rng)
    photos.append(Photo("driving-licence-front.jpg", "driving_licence", "document_front", "driving_licence", "driving_licence", "keywords",
                        dl_photo, printed=printed, expect_fields=expected(printed, False)))
    photos.append(Photo("driving-licence-front-sideways.jpg", "driving_licence", "document_front", "driving_licence", "driving_licence", "keywords",
                        dl_photo.rotate(90, expand=True), rotation=90, orientation="landscape", printed=printed,
                        expect_fields=expected(printed, False), variant="turned a quarter (counter-clockwise)"))
    dlb = Side(CARD_MM, (246, 236, 220), (200, 160, 110))
    dlb.text(4, 6, "CATÉGORIES / CATEGORIES", cap_mm=1.5, bold=True)
    for i, (cat, since) in enumerate((("A", "—"), ("B", "14/02/2022"), ("C", "—"), ("D", "—"), ("E", "—"))):
        y = 11 + i * 6.5
        dlb.draw.rectangle((dlb.px(4), dlb.px(y - 4), dlb.px(60), dlb.px(y + 2)), outline=(150, 120, 90), width=2)
        dlb.text(6, y, cat, cap_mm=1.8, bold=True)
        dlb.text(20, y, since, cap_mm=1.6)
    dlb.stamp(72, 24, cap_mm=2.4, angle=-12)
    photos.append(Photo("driving-licence-back.jpg", "driving_licence", "document_back", "driving_licence", "driving_licence", "keywords",
                        capture(dlb.img, rng), printed={}, expect_fields={}))

    # --- Voter card -------------------------------------------------------------------------------
    vc = Side(CARD_MM, (232, 242, 226), (130, 180, 120))
    vc.header(["ELECTIONS CAMEROON (ELECAM)"], y=4.6, cap=1.5)
    vc.text(42.8, 9.8, "CARTE ÉLECTORALE / VOTER'S CARD", cap_mm=1.6, bold=True, anchor="ms", fill=(30, 100, 50))
    vc.photo(4, 13, 20, 26)
    y = 15
    for label, value in (("NOM / SURNAME", "DÉMO"), ("PRÉNOMS / GIVEN NAMES", "ROSE ESSAI"), ("DATE DE NAISSANCE / DATE OF BIRTH", "22.08.1979"),
                         ("BUREAU DE VOTE / POLLING STATION", "ÉCOLE TEST")):
        y = vc.field(27, y, label, value)
    vc.field(4, 46, "N° DE CARTE / CARD No", "VC0012345", value_cap=1.6)
    vc.stamp(70, 44, cap_mm=2.4, angle=10)
    printed = {"surname": "DÉMO", "givenNames": "ROSE ESSAI", "birthDate": "1979-08-22", "documentNumber": "VC0012345"}
    photos.append(Photo("voter-card-front.jpg", "voter_card", "document_front", "voter_card", "voter_card", "keywords",
                        capture(vc.img, rng), printed=printed, expect_fields=expected(printed, False), never=["ÉCOLE TEST"]))
    vcb = Side(CARD_MM, (232, 242, 226), (130, 180, 120))
    y = 6
    for label, value in (("PÈRE / FATHER", "ESSAI PÈRE"), ("MÈRE / MOTHER", "ESSAI MÈRE"), ("PROFESSION / OCCUPATION", "TESTEUSE"),
                         ("ADRESSE / ADDRESS", "QUARTIER TEST")):
        y = vcb.field(4, y, label, value, value_cap=1.6)
    vcb.text(4, 46, "ELECAM", cap_mm=2.2, bold=True, fill=(30, 100, 50))
    vcb.stamp(64, 24, cap_mm=2.4, angle=-10)
    photos.append(Photo("voter-card-back.jpg", "voter_card", "document_back", "voter_card", "voter_card", "keywords",
                        capture(vcb.img, rng), printed={}, expect_fields={}, never=["ESSAI PÈRE", "ESSAI MÈRE", "TESTEUSE", "QUARTIER TEST"]))

    # --- No text, no card ------------------------------------------------------------------------
    blank = Side(CARD_MM, (226, 232, 238), (160, 170, 190))
    photos.append(Photo("blank-card.jpg", "blank", "document_front", "cni_legacy", "unknown", "none", capture(blank.img, rng),
                        orientation="", variant="a sharp card with nothing printed", expect={"textLines": 0}))
    photos.append(Photo("no-document.jpg", "none", "document_front", "cni_legacy", "unknown", "none",
                        table_only(OUTPUT_LONG_SIDE, round(OUTPUT_LONG_SIDE / CARD_MM[0] * CARD_MM[1]), rng),
                        orientation="", variant="the table only", expect={"documentFound": False, "textLines": 0}))
    return photos


def _iso(printed: str) -> str:
    d, m, y = printed.split(".")
    return f"{y}-{m}-{d}"


def _small(img: Image.Image, long_side: int) -> Image.Image:
    scale = long_side / max(img.size)
    return img.resize((round(img.width * scale), round(img.height * scale)), Image.Resampling.LANCZOS)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261014)
    photos = build(rng)
    manifest = {
        "about": "Fictitious SPECIMEN documents drawn by scripts/make-specimens.py for the worker's tests. "
                 "All data is fake; these images test the plumbing, not accuracy on real documents. Do not edit by hand.",
        "fonts": ["scripts/fonts/inter/Inter-Regular.ttf", "scripts/fonts/inter/Inter-Bold.ttf", "scripts/fonts/ocr-b/OCRB.otf"],
        "photos": [],
    }
    total = 0
    for p in photos:
        quality = p.expect.get("jpegQuality", JPEG_QUALITY)
        data = jpeg_bytes(p.image, quality)
        (out / p.file).write_bytes(data)
        total += len(data)
        w, h = p.image.size
        manifest["photos"].append({
            "file": p.file,
            "document": p.document,
            "side": p.side,
            "declaredDocument": p.declared,
            "width": w,
            "height": h,
            "variant": p.variant,
            "expected": {
                "family": p.family,
                "basis": p.basis,
                "rotation": p.rotation,
                "orientation": p.orientation or None,
                "mrz": p.mrz,
                "qr": p.qr,
                "subtype": p.subtype,
                "fields": p.expect_fields,
                **{k: v for k, v in p.expect.items() if k != "jpegQuality"},
            },
            "printed": p.printed,
            "never": p.never,
        })
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(photos)} photos, {total / 1e6:.2f} MB in {out}")


if __name__ == "__main__":
    main()

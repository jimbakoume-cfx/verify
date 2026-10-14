#!/usr/bin/env python3
"""Writes a synthetic camera video (.y4m) for Chromium's fake camera, used by the E2E tests:

    chrome --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file.y4m>

The scene is a clearly fake ID card ("SPECIMEN", made-up fields, a portrait box) lying on a
darker textured table, with a slight hand jitter and exposure drift. Nothing in it resembles a real
document. Its code lines (MRZ) are the fictitious specimen lines rendered in OCR-B by
scripts/make-mrz-fixtures.py: the bare strips in e2e/fixtures/mrz are read from there and pasted
at their physical size and place (manifest.json), so the rider app's reader sees real MRZ
characters with valid check digits. Variants:
    sharp    the card, in focus, filling the rider app's guide
    blurred  the same card, heavily out of focus
    smudged  the card in focus, but its code lines smudged (they cannot be read)
    none     the table only, no card

The card is placed where the rider app's guide falls in the video: the guide is measured in CSS
pixels on the capture screen (--viewport, --guide), and the <video> fills that screen with
`object-fit: cover`, so the guide maps into the video with the cover transform (the same mapping
as mapViewRectToSource in packages/capture/src/geometry.ts).

Pure Python standard library (no numpy), so it runs on any CI image. The playback loops, and the
jitter and exposure paths are periodic, so the loop point is seamless.

Usage:
    python3 scripts/make-fake-camera-video.py OUT.y4m [--variant sharp|blurred|smudged|none]
        [--document id1|passport] [--size 1280x720] [--fps 30] [--seconds 4] [--viewport 390x844]
        [--guide X,Y,W,H] [--fill 0.93] [--blur 0.012] [--seed 7] [--fixtures DIR]
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from itertools import accumulate
from pathlib import Path

# The MRZ strips and their manifest (written by scripts/make-mrz-fixtures.py).
DEFAULT_FIXTURES = Path(__file__).resolve().parent.parent / "e2e" / "fixtures" / "mrz"

# Luma (Y) in video range, 16..235: Chromium converts it to RGB with the limited-range rule, so
# 235 is already white. The card stays well under the analysis glare level (RGB 250 = Y 233).
BG_LUMA = 74
CARD_LUMA = 204
INK_LUMA = 46
LABEL_LUMA = 104
BAND_LUMA = 112
BAND_TEXT_LUMA = 214
PHOTO_LUMA = 172
SILHOUETTE_LUMA = 118
STAMP_LUMA = 150

# Chroma (U, V), 128 = grey. A brownish table, a pale green card, a blue band, a red stamp.
BG_CHROMA = (116, 140)
CARD_CHROMA = (124, 122)
BAND_CHROMA = (152, 112)
STAMP_CHROMA = (112, 172)

# Jitter margin in pixels: the scene is drawn this much larger on every side.
MARGIN = 3

# 5x7 bitmap glyphs (our own), "#" = ink.
GLYPHS = {
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "G": [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
    "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "I": [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "J": ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "M": ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
    "N": ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    "Q": [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
    "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
    "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
    "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
    "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
    "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
    "<": ["...#.", "..#..", ".#...", "#....", ".#...", "..#..", "...#."],
    ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
    ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
    "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
    "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
    " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
}
GLYPH_W, GLYPH_H, ADVANCE = 5, 7, 6

# Made-up content. "SPECIMEN" and "FAKE" make it obvious; no real country, name or number.
FIELDS = [("NOM", "SPECIMEN"), ("PRENOM", "TEST E2E"), ("NE LE", "01.01.1990"), ("NO", "E2E-000000")]
STAMP = "SPECIMEN"

# Per document: header text, the MRZ strip it carries (a document of manifest.json), corner radius
# (share of the width), and the default guide: where the rider app draws it on a 390x844 screen, in
# CSS pixels, measured on the capture screen with a one-line hint (a two-line hint moves it down
# 2 px; that does not matter here).
DOCUMENTS = {
    "id1": {  # ID-1 card (CNI, residence permit, licence, voter card): 85.6 x 53.98 mm, TD1 code lines
        "band": "FAKE ID - SPECIMEN",
        "mrz": "td1",
        "radius": 0.037,
        "guide": "15.6,338.5,358.8,226.3",
    },
    "passport": {  # TD3 passport data page: 125 x 88 mm
        "band": "FAKE PASSPORT - SPECIMEN",
        "mrz": "td3",
        "radius": 0.025,
        "guide": "15.6,325.4,358.8,252.6",
    },
}


class Plane:
    """One 8-bit image plane as rows of bytearrays (row slicing keeps the hot loops in C)."""

    def __init__(self, width: int, height: int, value: int) -> None:
        self.width, self.height = width, height
        self.rows = [bytearray([value]) * width for _ in range(height)]

    def fill(self, x0: float, y0: float, x1: float, y1: float, value: int) -> None:
        xa, xb = max(0, round(x0)), min(self.width, round(x1))
        ya, yb = max(0, round(y0)), min(self.height, round(y1))
        if xb <= xa:
            return
        run = bytes([value]) * (xb - xa)
        for y in range(ya, yb):
            self.rows[y][xa:xb] = run


def clamp8(v: float) -> int:
    return 0 if v < 0 else 255 if v > 255 else int(v)


def parse_pair(text: str, sep: str = "x") -> tuple[int, int]:
    a, b = text.lower().split(sep)
    return int(a), int(b)


def cover_guide_to_source(guide: tuple[float, ...], view: tuple[int, int], src: tuple[int, int]) -> tuple[float, ...]:
    """The guide (CSS pixels on the capture screen) in video pixels, for a <video> with object-fit: cover."""
    (vw, vh), (sw, sh) = view, src
    scale = max(vw / sw, vh / sh)
    ox, oy = (vw - sw * scale) / 2, (vh - sh * scale) / 2
    gx, gy, gw, gh = guide
    return ((gx - ox) / scale, (gy - oy) / scale, gw / scale, gh / scale)


def smooth_tile(rng: random.Random, size: int, sigma: float) -> list[list[float]]:
    """Seamless square tile of fine grain: white noise, box-blurred twice with wrap-around, scaled to
    `sigma` luma levels. A lens renders a real surface smooth at the pixel level; independent pixel
    noise would flicker under the slightest shake (aliasing in the app's downscaled analysis)."""
    noise = [[rng.gauss(0, 1) for _ in range(size)] for _ in range(size)]
    for _ in range(2):
        noise = [[sum(row[(x + d) % size] for d in range(-2, 3)) / 5 for x in range(size)] for row in noise]
        noise = [[sum(noise[(y + d) % size][x] for d in range(-2, 3)) / 5 for x in range(size)] for y in range(size)]
    spread = math.sqrt(sum(v * v for row in noise for v in row) / (size * size))
    return [[max(-3 * sigma, min(3 * sigma, v * sigma / spread)) for v in row] for row in noise]


def draw_table(y_plane: Plane, rng: random.Random) -> None:
    """Dark matte table: soft blotches (a coarse random grid, interpolated) plus a fine grain. No
    long straight lines: the rider app's detector looks for the card's four straight edges, and a
    striped background (wood grain) would be a different, harder test."""
    w, h = y_plane.width, y_plane.height
    cell, tile_size = 64, 128
    grid = [[rng.uniform(-8, 8) for _ in range(w // cell + 2)] for _ in range(h // cell + 2)]
    weights = [(x // cell, (x % cell) / cell) for x in range(w)]
    coarse = [[row[i] + (row[i + 1] - row[i]) * t for i, t in weights] for row in grid]
    tile = smooth_tile(rng, tile_size, 4.0)
    for y in range(h):
        j, t = y // cell, (y % cell) / cell
        grain = (tile[y % tile_size] * (w // tile_size + 1))[:w]
        # Values stay within BG_LUMA +/- 20: no clamping needed.
        y_plane.rows[y][:] = bytes(
            int(BG_LUMA + a + (b - a) * t + g + 0.5) for a, b, g in zip(coarse[j], coarse[j + 1], grain)
        )


def draw_text(plane: Plane, x: float, y: float, text: str, scale: int, value: int) -> float:
    """Draws `text` with its top-left corner at (x, y); returns the x after the last character."""
    for ch in text:
        glyph = GLYPHS.get(ch, GLYPHS[" "])
        for gy, line in enumerate(glyph):
            for gx, bit in enumerate(line):
                if bit == "#":
                    plane.fill(x + gx * scale, y + gy * scale, x + (gx + 1) * scale, y + (gy + 1) * scale, value)
        x += ADVANCE * scale
    return x


def text_scale(width_px: float, chars: int, height_px: float) -> int:
    """Largest whole glyph scale for `chars` characters within width_px, and glyphs within height_px."""
    return max(1, min(int(width_px / (chars * ADVANCE)), int(height_px / GLYPH_H)))


def read_pgm(path: Path) -> tuple[int, int, bytes]:
    """A binary 8-bit PGM (P5): width, height and the pixels, row by row."""
    data = path.read_bytes()
    fields: list[bytes] = []
    pos = 0
    while len(fields) < 4:
        while data[pos : pos + 1].isspace():
            pos += 1
        if data[pos : pos + 1] == b"#":  # a comment runs to the end of the line
            pos = data.index(b"\n", pos) + 1
            continue
        end = pos
        while not data[end : end + 1].isspace():
            end += 1
        fields.append(data[pos:end])
        pos = end
    if fields[0] != b"P5" or fields[3] != b"255":
        raise ValueError(f"{path}: not an 8-bit binary PGM")
    width, height = int(fields[1]), int(fields[2])
    pixels = data[pos + 1 : pos + 1 + width * height]  # a single whitespace ends the header
    if len(pixels) != width * height:
        raise ValueError(f"{path}: truncated")
    return width, height, pixels


def load_strip(fixtures: Path, document: str, smudged: bool) -> dict:
    """The code-line strip of `document` ("td1" or "td3") from manifest.json: its pixels (black ink on
    white), physical size, and where it sits on the document."""
    manifest = json.loads((fixtures / "manifest.json").read_text())
    strip = next(s for s in manifest["strips"] if s["document"] == document and s["smudged"] == smudged)
    width, height, pixels = read_pgm(fixtures / strip["file"])
    return {
        "width": width,
        "height": height,
        "pixels": pixels,
        "size_mm": (strip["widthMm"], strip["heightMm"]),
        "placement_mm": (strip["placementFromBottomLeft"]["leftMm"], strip["placementFromBottomLeft"]["bottomMm"]),
        "document_mm": tuple(manifest["documents"][document]["sizeMm"]),
    }


def resample_weights(src_len: int, src_per_dst: float, start: float, first: int, count: int) -> list[list[tuple[int, float]]]:
    """For destination pixels first..first+count-1 (a strip whose edge is at `start` in destination
    pixels), the source pixels and weights of a triangle filter, widened when shrinking so that
    every source pixel counts (no aliasing). Source pixels outside the strip are left out: they
    are paper, like the strip's own margin."""
    support = max(1.0, src_per_dst)
    out = []
    for x in range(first, first + count):
        u = (x + 0.5 - start) * src_per_dst  # the destination pixel's centre, in source pixels
        lo, hi = max(0, math.floor(u - support)), min(src_len, math.ceil(u + support) + 1)
        taps = [(i, 1 - abs(i + 0.5 - u) / support) for i in range(lo, hi)]
        out.append([(i, w) for i, w in taps if w > 0])
    return out


def paste_strip(y_plane: Plane, card: tuple[float, float, float, float], strip: dict) -> None:
    """Prints the strip on the card at its physical size and place, resampled to the card's scale.
    The ink darkens what is under it (multiply), so the card's own pattern shows through the paper."""
    cx, cy, cw, ch = card
    doc_w_mm, doc_h_mm = strip["document_mm"]
    px_per_mm = cw / doc_w_mm
    (w_mm, h_mm), (left_mm, bottom_mm) = strip["size_mm"], strip["placement_mm"]
    x0, y0 = cx + left_mm * px_per_mm, cy + ch - (bottom_mm + h_mm) * px_per_mm
    sw, sh, pixels = strip["width"], strip["height"], strip["pixels"]
    first_x, first_y = math.floor(x0), math.floor(y0)
    cols = resample_weights(sw, sw / (w_mm * px_per_mm), x0, first_x, math.ceil(x0 + w_mm * px_per_mm) - first_x)
    rows = resample_weights(sh, sh / (h_mm * px_per_mm), y0, first_y, math.ceil(y0 + h_mm * px_per_mm) - first_y)
    # Horizontal pass on every source row, then the vertical pass. Missing taps count as paper (255).
    wide = []
    for r in range(sh):
        line = pixels[r * sw : (r + 1) * sw]
        wide.append([sum(line[i] * w for i, w in taps) + 255 * (1 - sum(w for _, w in taps)) if taps else 255.0 for taps in cols])
    ink_scale = (CARD_LUMA - INK_LUMA) / 255
    for dy, taps in enumerate(rows):
        y = first_y + dy
        if not 0 <= y < y_plane.height:
            continue
        total = sum(w for _, w in taps)
        row = y_plane.rows[y]
        for dx in range(len(cols)):
            x = first_x + dx
            if not 0 <= x < y_plane.width:
                continue
            value = sum(wide[i][dx] * w for i, w in taps) + 255 * (1 - total) if taps else 255.0
            row[x] = clamp8(row[x] * (INK_LUMA + ink_scale * value) / CARD_LUMA + 0.5)


def draw_card(
    y_plane: Plane, u_plane: Plane, v_plane: Plane, card: tuple[float, float, float, float], doc: dict, strip: dict
) -> None:
    cx, cy, cw, ch = card
    radius = doc["radius"] * cw
    # Everything else stays above the code lines, as on a real document (ICAO's clear zone).
    _, doc_h_mm = strip["document_mm"]
    mrz_top = 1 - (strip["placement_mm"][1] + strip["size_mm"][1]) / doc_h_mm
    content_bottom = mrz_top - 0.03

    # Body with rounded corners, and a faint diagonal guilloche (a periodic row pattern, shifted per row).
    period = max(6, round(cw / 60))
    pattern = bytes(CARD_LUMA - (7 if (i % period) < max(1, period // 3) else 0) for i in range(period)) * (int(cw) // period + 4)
    for y in range(max(0, math.floor(cy)), min(y_plane.height, math.ceil(cy + ch))):
        dy = min(y + 0.5 - cy, cy + ch - (y + 0.5))
        inset = radius - math.sqrt(max(0.0, radius * radius - (radius - dy) ** 2)) if dy < radius else 0.0
        x0, x1 = round(cx + inset), round(cx + cw - inset)
        if x1 <= x0:
            continue
        off = (y * 2) % period
        y_plane.rows[y][x0:x1] = pattern[off : off + (x1 - x0)]
        if y % 2 == 0:
            uy = y // 2
            u_plane.fill(x0 / 2, uy, x1 / 2, uy + 1, CARD_CHROMA[0])
            v_plane.fill(x0 / 2, uy, x1 / 2, uy + 1, CARD_CHROMA[1])

    def at(fx: float, fy: float) -> tuple[float, float]:
        return cx + fx * cw, cy + fy * ch

    # Header band, inset from the card edge so the card's own outline stays light against the table.
    bx0, by0 = at(0.04, 0.06)
    bx1, by1 = at(0.96, 0.2)
    y_plane.fill(bx0, by0, bx1, by1, BAND_LUMA)
    u_plane.fill(bx0 / 2, by0 / 2, bx1 / 2, by1 / 2, BAND_CHROMA[0])
    v_plane.fill(bx0 / 2, by0 / 2, bx1 / 2, by1 / 2, BAND_CHROMA[1])
    band = doc["band"]
    s = text_scale(0.8 * (bx1 - bx0), len(band), 0.6 * (by1 - by0))
    tw = len(band) * ADVANCE * s
    draw_text(y_plane, (bx0 + bx1 - tw) / 2, (by0 + by1 - GLYPH_H * s) / 2, band, s, BAND_TEXT_LUMA)

    # Portrait box with a plain silhouette.
    px0, py0 = at(0.05, 0.26)
    px1, py1 = at(0.3, content_bottom)
    pw, ph = px1 - px0, py1 - py0
    y_plane.fill(px0, py0, px1, py1, PHOTO_LUMA)
    head_x, head_y, head_r = px0 + pw / 2, py0 + 0.38 * ph, 0.21 * pw
    sh_x, sh_y, sh_rx, sh_ry = px0 + pw / 2, py1, 0.44 * pw, 0.36 * ph
    for y in range(max(0, round(py0)), min(y_plane.height, round(py1))):
        row = y_plane.rows[y]
        for x in range(max(0, round(px0)), min(y_plane.width, round(px1))):
            in_head = (x - head_x) ** 2 + (y - head_y) ** 2 <= head_r * head_r
            in_body = ((x - sh_x) / sh_rx) ** 2 + ((y - sh_y) / sh_ry) ** 2 <= 1
            if in_head or in_body:
                row[x] = SILHOUETTE_LUMA

    # Fields: label in grey, value in dark ink; four rows, then the stamp, down to the code lines.
    fx0, fy = at(0.35, 0.27)
    line_h = (content_bottom - 0.27) / (len(FIELDS) + 1) * ch
    longest = max(len(f"{k}: {v}") for k, v in FIELDS)
    s = text_scale(0.6 * cw, longest, 0.55 * line_h)
    for label, value in FIELDS:
        x = draw_text(y_plane, fx0, fy, f"{label}:", s, LABEL_LUMA)
        draw_text(y_plane, x + ADVANCE * s, fy, value, s, INK_LUMA)
        fy += line_h

    # Red "SPECIMEN" stamp across the lower right, above the code lines.
    sx0, sy0 = fx0 + 0.01 * cw, fy
    s = text_scale(0.56 * cw, len(STAMP), min(0.12 * ch, 0.8 * line_h))
    end = draw_text(y_plane, sx0, sy0, STAMP, s, STAMP_LUMA)
    u_plane.fill(sx0 / 2, sy0 / 2, end / 2, (sy0 + GLYPH_H * s) / 2, STAMP_CHROMA[0])
    v_plane.fill(sx0 / 2, sy0 / 2, end / 2, (sy0 + GLYPH_H * s) / 2, STAMP_CHROMA[1])

    # The code lines: the real OCR-B strip, at its physical size and place.
    paste_strip(y_plane, card, strip)


def box_blur(plane: Plane, radius: int, passes: int = 3) -> None:
    """Separable box blur, `passes` times (close to a Gaussian of sigma ~ radius)."""
    def blur_rows(rows: list) -> list:
        k = 2 * radius + 1
        out = []
        for row in rows:
            padded = [row[0]] * (radius + 1) + list(row) + [row[-1]] * radius
            acc = list(accumulate(padded))
            out.append(bytes((acc[i + k] - acc[i]) // k for i in range(len(row))))
        return out

    rows: list = plane.rows
    for _ in range(passes):
        rows = blur_rows(rows)
        cols = blur_rows([bytes(c) for c in zip(*rows)])
        rows = [bytes(r) for r in zip(*cols)]
    plane.rows = [bytearray(r) for r in rows]


def write_y4m(path: str, frames: int, fps: int, size: tuple[int, int], planes: tuple[Plane, Plane, Plane], rng: random.Random) -> None:
    w, h = size
    y_plane, u_plane, v_plane = planes
    phases = [rng.random() * 6.28 for _ in range(6)]
    luts: dict[int, bytes] = {}
    with open(path, "wb") as f:
        f.write(f"YUV4MPEG2 W{w} H{h} F{fps}:1 Ip A1:1 C420jpeg\n".encode())
        for i in range(frames):
            t = 2 * math.pi * i / frames  # one loop = one period: no jump when playback wraps
            dx = round(1.2 * math.sin(t + phases[0]) + 0.6 * math.sin(3 * t + phases[1]))
            dy = round(1.0 * math.sin(t + phases[2]) + 0.5 * math.sin(2 * t + phases[3]))
            # Exposure drift of about +/-1.5%, applied through a lookup table per frame.
            gain = round(15 * math.sin(t + phases[4]))  # in 0.1%
            lut = luts.get(gain)
            if lut is None:
                lut = luts[gain] = bytes(clamp8(16 + (v - 16) * (1 + gain / 1000) + 0.5) for v in range(256))
            x0, y0 = MARGIN + dx, MARGIN + dy
            f.write(b"FRAME\n")
            f.write(b"".join(bytes(row[x0 : x0 + w]).translate(lut) for row in y_plane.rows[y0 : y0 + h]))
            cx0, cy0 = (MARGIN + dx) // 2, (MARGIN + dy) // 2  # chroma is half resolution
            for plane in (u_plane, v_plane):
                f.write(b"".join(bytes(row[cx0 : cx0 + w // 2]) for row in plane.rows[cy0 : cy0 + h // 2]))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("output", help="the .y4m file to write")
    parser.add_argument("--variant", choices=["sharp", "blurred", "smudged", "none"], default="sharp")
    parser.add_argument("--document", choices=sorted(DOCUMENTS), default="id1", help="card shape and content")
    parser.add_argument("--size", default="1280x720", help="video size WxH (even numbers)")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--seconds", type=float, default=4.0)
    parser.add_argument("--viewport", default="390x844", help="CSS size of the capture screen, WxH")
    parser.add_argument(
        "--guide",
        help="the guide on the capture screen, x,y,w,h in CSS pixels (default: the document's guide at 390x844)",
    )
    parser.add_argument("--fill", type=float, default=0.93, help="card width as a share of the guide width")
    parser.add_argument("--blur", type=float, default=0.012, help="blur radius as a share of the card width (blurred variant)")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES, help="folder of the MRZ strips and manifest.json")
    args = parser.parse_args(argv)

    w, h = parse_pair(args.size)
    if w % 2 or h % 2 or w < 16 or h < 16:
        parser.error("--size must be even and at least 16x16")
    view = parse_pair(args.viewport)
    doc = DOCUMENTS[args.document]
    guide = tuple(float(v) for v in (args.guide or doc["guide"]).split(","))
    if len(guide) != 4:
        parser.error("--guide needs x,y,w,h")
    rng = random.Random(args.seed)

    sw, sh = w + 2 * MARGIN, h + 2 * MARGIN
    y_plane = Plane(sw, sh, BG_LUMA)
    u_plane = Plane(sw // 2, sh // 2, BG_CHROMA[0])
    v_plane = Plane(sw // 2, sh // 2, BG_CHROMA[1])
    draw_table(y_plane, rng)

    gx, gy, gw, gh = cover_guide_to_source(guide, view, (w, h))
    cw, ch = gw * args.fill, gh * args.fill
    card = (MARGIN + gx + (gw - cw) / 2, MARGIN + gy + (gh - ch) / 2, cw, ch)
    if args.variant != "none":
        strip = load_strip(args.fixtures, doc["mrz"], smudged=args.variant == "smudged")
        draw_card(y_plane, u_plane, v_plane, card, doc, strip)
    if args.variant == "blurred":
        radius = max(1, round(args.blur * cw))
        box_blur(y_plane, radius)
        for plane in (u_plane, v_plane):
            box_blur(plane, max(1, radius // 2))

    frames = max(1, round(args.fps * args.seconds))
    write_y4m(args.output, frames, args.fps, (w, h), (y_plane, u_plane, v_plane), rng)
    print(
        f"{args.output}: {args.variant} {args.document} {w}x{h} {frames} frames; card at "
        f"x={card[0] - MARGIN:.1f} y={card[1] - MARGIN:.1f} w={cw:.1f} h={ch:.1f} (video pixels)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

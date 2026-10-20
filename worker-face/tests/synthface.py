"""A drawn face for the tests: no real person, ever.

MediaPipe's canonical face model (468 points, its triangles and its texture coordinates, from
face_landmarker.task's geometry metadata, Apache-2.0; tests/fixtures/canonical_mesh.json) is painted
with a flat procedural texture (skin, eyes, brows, lips), posed and rendered with a z-buffer and
simple shading. BlazeFace and the face mesh find it, so the real models can be run on scenes we
control exactly: a head turning (real 3-D parallax), a blink, a smile, a printed photo tilted in front
of the camera (a homography of a flat picture), a pixel grid (a screen), a portrait on a fictitious
SPECIMEN document. Two different "people" are two different textures and face shapes.

It says nothing about accuracy on real riders: it tests the plumbing, the geometry and the sign
conventions with the real models.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from verify_face import geometry

MESH = json.loads((Path(__file__).resolve().parent / "fixtures" / "canonical_mesh.json").read_text(encoding="utf-8"))
TRIANGLES = np.asarray(MESH["triangles"], dtype=np.int64)
UV = np.asarray(MESH["uv"], dtype=np.float64)

# Contours of the canonical mesh (MediaPipe's FACEMESH_* connection sets, as rings).
RIGHT_EYE = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7]
LEFT_EYE = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249]
LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146]
RIGHT_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
LEFT_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]


@dataclass(frozen=True)
class Person:
    """A drawn identity: a skin colour, eye and lip colours, and a face shape (scales of the model)."""

    skin: tuple[int, int, int] = (150, 105, 80)
    iris: tuple[int, int, int] = (40, 25, 20)
    lips: tuple[int, int, int] = (120, 55, 55)
    brows: tuple[int, int, int] = (40, 30, 25)
    shape: tuple[float, float, float] = (1.0, 1.0, 1.0)


ALICE = Person()
BOB = Person(skin=(95, 62, 45), iris=(25, 15, 10), lips=(90, 40, 40), brows=(20, 15, 10), shape=(1.12, 0.92, 1.1))


def texture(person: Person, eyes_closed: bool = False, size: int = 512) -> np.ndarray:
    tex = Image.new("RGB", (size, size), person.skin)
    draw = ImageDraw.Draw(tex)

    def point(i: int) -> tuple[float, float]:
        return UV[i][0] * size, (1 - UV[i][1]) * size

    def polygon(ids: list[int], colour: tuple[int, int, int]) -> None:
        draw.polygon([point(i) for i in ids], fill=colour)

    lid = tuple(int(c * 0.8) for c in person.skin)
    for eye in (RIGHT_EYE, LEFT_EYE):
        polygon(eye, lid if eyes_closed else (235, 235, 230))
        if not eyes_closed:
            pts = np.asarray([point(i) for i in eye])
            cx, cy = pts.mean(axis=0)
            r = float(np.ptp(pts[:, 0])) * 0.22
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=person.iris)
    polygon(LIPS, person.lips)
    polygon(RIGHT_BROW, person.brows)
    polygon(LEFT_BROW, person.brows)
    return np.asarray(tex.filter(ImageFilter.GaussianBlur(2)))


def shape(person: Person, smile: float = 0.0) -> np.ndarray:
    """The person's face model, with the mouth corners pulled out and up by `smile` (0..1)."""
    model = geometry.canonical_face() * np.asarray(person.shape)
    canon = geometry.canonical_face()
    for corner, side in ((61, -1.0), (291, 1.0)):
        weight = np.exp(-((canon - canon[corner]) ** 2).sum(axis=1) / (2 * 0.8 ** 2))
        model[:, 0] += side * 0.6 * smile * weight
        model[:, 1] += 0.7 * smile * weight
    return model


def render(
    person: Person = ALICE,
    yaw: float = 0.0,
    pitch: float = 0.0,
    roll: float = 0.0,
    *,
    smile: float = 0.0,
    eyes_closed: bool = False,
    size: tuple[int, int] = (360, 480),
    face_width: float = 170.0,
    centre: tuple[float, float] | None = None,
    background: tuple[int, int, int] = (90, 110, 130),
) -> np.ndarray:
    """An RGB picture (height x width x 3) of the drawn face."""
    width, height = size
    pts = geometry.render_canonical(
        yaw, pitch, roll, size=max(size), face_width=face_width,
        centre=centre or (width / 2, height / 2), shape=shape(person, smile),
    )
    tex = texture(person, eyes_closed)
    th = tex.shape[0]
    img = np.zeros((height, width, 3), dtype=np.float64) + np.asarray(background, dtype=np.float64)
    zbuf = np.full((height, width), np.inf)
    for tri in TRIANGLES:
        a, b, c = pts[tri]
        if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= 0:
            continue  # facing away
        x0, x1 = int(max(0, min(a[0], b[0], c[0]))), int(min(width - 1, max(a[0], b[0], c[0])) + 1)
        y0, y1 = int(max(0, min(a[1], b[1], c[1]))), int(min(height - 1, max(a[1], b[1], c[1])) + 1)
        if x1 <= x0 or y1 <= y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-9:
            continue
        w0 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / den
        w1 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / den
        w2 = 1 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        z = w0 * a[2] + w1 * b[2] + w2 * c[2]
        sub = zbuf[y0:y1, x0:x1]
        update = inside & (z < sub)
        if not update.any():
            continue
        sub[update] = z[update]
        u = w0 * UV[tri[0], 0] + w1 * UV[tri[1], 0] + w2 * UV[tri[2], 0]
        v = w0 * UV[tri[0], 1] + w1 * UV[tri[1], 1] + w2 * UV[tri[2], 1]
        colour = tex[np.clip(((1 - v) * th).astype(int), 0, th - 1), np.clip((u * th).astype(int), 0, th - 1)].astype(np.float64)
        normal = np.cross(b - a, c - a)
        shade = 0.35 + 0.65 * abs(normal[2]) / (np.linalg.norm(normal) + 1e-9)
        img[y0:y1, x0:x1][update] = colour[update] * shade
    return np.clip(img, 0, 255).astype(np.uint8)


def tilted_print(picture: np.ndarray, yaw: float, focal: float = 800.0) -> np.ndarray:
    """The picture as a flat print (or a screen) turned by `yaw` degrees about its vertical axis in
    front of the camera: a pure homography of the picture, what a presentation attack looks like."""
    h, w = picture.shape[:2]
    cx, cy = w / 2, h / 2
    t = math.radians(yaw)
    r = np.array([[math.cos(t), 0, math.sin(t)], [0, 1, 0], [-math.sin(t), 0, math.cos(t)]])
    k = np.array([[focal, 0, cx], [0, focal, cy], [0, 0, 1]])
    plane = np.array([0.0, 0.0, focal])
    homography = k @ (r + np.outer(plane - r @ plane, [0, 0, 1]) / focal) @ np.linalg.inv(k)
    inverse = np.linalg.inv(homography)
    inverse /= inverse[2, 2]
    out = Image.fromarray(picture).transform((w, h), Image.PERSPECTIVE, tuple(inverse.flatten()[:8]), resample=Image.BILINEAR)
    return np.asarray(out)


def screen(picture: np.ndarray, period: float = 3.0, angle: float = 0.2, depth: float = 0.35) -> np.ndarray:
    """The picture shown on a screen and filmed: a fine periodic pixel-grid pattern over it."""
    h, w = picture.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    u = xx * math.cos(angle) + yy * math.sin(angle)
    pattern = 1 - depth * (0.5 + 0.5 * np.cos(2 * math.pi * u / period))
    return np.clip(picture * pattern[..., None] * 1.15, 0, 255).astype(np.uint8)


def document_with_portrait(specimen: Path, portrait: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    """A fictitious SPECIMEN document with the drawn face pasted in its portrait box (x, y, w, h)."""
    doc = Image.open(specimen).convert("RGB")
    x, y, w, h = box
    doc.paste(Image.fromarray(portrait).resize((w, h), Image.BILINEAR), (x, y))
    return np.asarray(doc)


def jpeg(picture: np.ndarray, quality: int = 85) -> bytes:
    import io

    out = io.BytesIO()
    Image.fromarray(picture).save(out, "JPEG", quality=quality)
    return out.getvalue()

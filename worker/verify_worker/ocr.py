"""Printed-text OCR: RapidOCR with the PP-OCRv6 models that ship inside the rapidocr wheel.

Models: PP-OCRv6 det "small" + rec "small" (Apache-2.0, Baidu/PaddleOCR, redistributed by RapidOCR).
They are the only detection/recognition pair the rapidocr 3.9.2 wheel contains; the faster "tiny"
pair would have to be downloaded, and nothing is ever downloaded at run time. The paths are set
explicitly (RapidOCR would otherwise fetch missing models from modelscope.cn) and each file's SHA-256
is checked before it is loaded. The wheel's text-line orientation classifier is loaded by RapidOCR's
constructor but never run (use_cls false): it flips code lines on degraded photos, and the
orientation is decided for the whole card instead (classify.py).

PP-OCRv6's dictionary has about 18,700 entries, Greek and Cyrillic letters among them, so a Latin
P can come back as a Greek Rho. Every line is mapped back to Latin look-alikes here. Accents on
Latin letters (É, Ç...) are kept at this stage: keywords and labels are matched without them, and
fields.py turns the values it sends into ASCII.

Images are passed as numpy arrays only: given a string, RapidOCR would treat it as a path or a URL
and fetch it.
"""

from __future__ import annotations

import hashlib
import os
import threading
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import log

# The model files inside the rapidocr 3.9.2 wheel, and their SHA-256 (also listed in rapidocr's
# default_models.yaml and in docs/LICENSES.md).
MODEL_FILES = {
    "det": ("PP-OCRv6_det_small.onnx", "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f"),
    "rec": ("PP-OCRv6_rec_small.onnx", "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884"),
    "cls": ("ch_ppocr_mobile_v2.0_cls_mobile.onnx", "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c"),
}

# Detection runs on the photo reduced to this longest side (text stays 15+ px tall on a card photo);
# recognition reads the text from the full-resolution photo. RapidOCR's default instead enlarges the
# photo until its shorter side reaches 736 px, which costs more CPU for no better reads on our
# specimens. Provisional, like every threshold here, until tuned on real photos.
DET_LIMIT_SIDE = 960
# Lines the recogniser is less sure of than this are dropped (RapidOCR's default).
TEXT_SCORE = 0.5


class ModelIntegrityError(Exception):
    """A model file is missing or differs from the pinned SHA-256."""


# ---------------------------------------------------------------------------------------------
# Look-alike characters
# ---------------------------------------------------------------------------------------------
# Greek and Cyrillic letters that look like Latin ones. Only these are mapped: other non-Latin
# letters stay as they are (and are dropped from code lines).
_LOOKALIKES = {
    # Greek capitals
    "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
    "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "Ϲ": "C", "Ϳ": "J",
    # Greek small letters that look like Latin ones
    "α": "a", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
    "ϲ": "c", "ϳ": "j",
    # Cyrillic capitals
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C",
    "Т": "T", "У": "Y", "Х": "X", "Ѕ": "S", "І": "I", "Ј": "J", "Ԛ": "Q", "Ԝ": "W", "Ү": "Y",
    "Ғ": "F", "Ӏ": "I", "З": "3", "Ь": "b",
    # Cyrillic small letters
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "ѕ": "s", "і": "i",
    "ј": "j", "ԛ": "q", "ԝ": "w", "һ": "h", "ԁ": "d", "ӏ": "l",
}
# Shapes OCR returns for the code lines' filler '<'.
_FILLERS = "«‹〈⟨❮＜くᐸ"
_LOOKALIKE_TABLE = str.maketrans(_LOOKALIKES)


def fold_lookalikes(text: str) -> str:
    """Compatibility forms folded (full-width letters, ligatures), Greek/Cyrillic look-alikes mapped
    to Latin. Latin accents are kept."""
    text = unicodedata.normalize("NFKC", text)
    return text.translate(_LOOKALIKE_TABLE)


def mrz_characters(text: str) -> str:
    """A line as code-line characters only: look-alikes mapped, accents removed, upper case, filler
    shapes to '<', a vertical bar to I, everything outside A-Z, 0-9 and '<' dropped (spaces too).
    No ICAO correction (O/0, I/1 by field): the Edge Function's shared corrector does that."""
    text = fold_lookalikes(text)
    for c in _FILLERS:
        text = text.replace(c, "<")
    text = text.replace("|", "I")
    text = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    text = text.upper()
    return "".join(ch for ch in text if ("A" <= ch <= "Z") or ("0" <= ch <= "9") or ch == "<")


# ---------------------------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class OcrLine:
    """One detected text line: its text (look-alikes folded), the recogniser's confidence, and its
    four corners in the pixels of the image that was read."""

    text: str
    score: float
    box: tuple[tuple[float, float], ...]

    @property
    def x0(self) -> float:
        return min(p[0] for p in self.box)

    @property
    def x1(self) -> float:
        return max(p[0] for p in self.box)

    @property
    def y0(self) -> float:
        return min(p[1] for p in self.box)

    @property
    def y1(self) -> float:
        return max(p[1] for p in self.box)

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def horizontal(self) -> bool:
        """The text runs left to right in this image (its box is wider than tall)."""
        return (self.x1 - self.x0) >= (self.y1 - self.y0)


@dataclass(frozen=True)
class OcrPage:
    """Everything read from one orientation of the photo, lines in reading order."""

    rotation: int
    width: int
    height: int
    lines: tuple[OcrLine, ...]


def group_rows(lines: list[OcrLine] | tuple[OcrLine, ...]) -> list[list[OcrLine]]:
    """Lines that share a row (they overlap vertically by at least half the smaller one's height),
    rows top to bottom, each row left to right."""
    ordered = sorted(lines, key=lambda line: (line.cy, line.x0))
    rows: list[list[OcrLine]] = []
    for line in ordered:
        if rows:
            ref = rows[-1][0]
            overlap = min(ref.y1, line.y1) - max(ref.y0, line.y0)
            if overlap >= 0.5 * min(ref.y1 - ref.y0, line.y1 - line.y0):
                rows[-1].append(line)
                continue
        rows.append([line])
    return [sorted(row, key=lambda item: item.x0) for row in rows]


def reading_order(lines: list[OcrLine]) -> list[OcrLine]:
    """Top to bottom, then left to right within a row."""
    return [line for row in group_rows(lines) for line in row]


# ---------------------------------------------------------------------------------------------
# The engine
# ---------------------------------------------------------------------------------------------
def model_dir() -> Path:
    import rapidocr  # noqa: PLC0415 - heavy import, only when the models are needed

    return Path(rapidocr.__file__).resolve().parent / "models"


def verify_models(directory: Path) -> dict[str, Path]:
    """Paths of the pinned model files, each checked against its SHA-256."""
    paths = {}
    for role, (name, expected) in MODEL_FILES.items():
        path = directory / name
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as err:
            raise ModelIntegrityError(role) from err
        if digest != expected:
            raise ModelIntegrityError(role)
        paths[role] = path
    return paths


class OcrEngine:
    """RapidOCR, loaded once per process. `read` is serialised: one CPU is all a worker has."""

    def __init__(self, threads: int | None = None):
        threads = threads or int(os.environ.get("WORKER_OCR_THREADS", "1"))
        paths = verify_models(model_dir())
        import onnxruntime  # noqa: PLC0415
        from rapidocr import RapidOCR  # noqa: PLC0415

        onnxruntime.set_default_logger_severity(3)
        self._engine = RapidOCR(
            params={
                "Global.use_cls": False,
                "Global.log_level": "error",
                "Global.text_score": TEXT_SCORE,
                "Det.model_path": str(paths["det"]),
                "Det.limit_type": "max",
                "Det.limit_side_len": DET_LIMIT_SIDE,
                "Rec.model_path": str(paths["rec"]),
                "Cls.model_path": str(paths["cls"]),
                "EngineConfig.onnxruntime.intra_op_num_threads": threads,
                "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            }
        )
        # Importing rapidocr resets its logger to INFO: turn it down again.
        log.configure()
        import logging  # noqa: PLC0415

        logging.getLogger("RapidOCR").setLevel(logging.ERROR)
        self._lock = threading.Lock()

    def read(self, rgb: np.ndarray, rotation: int = 0) -> OcrPage:
        """Reads an RGB image that has already been rotated by `rotation` degrees clockwise."""
        bgr = np.ascontiguousarray(rgb[:, :, ::-1])
        with self._lock:
            result = self._engine(bgr)
        lines: list[OcrLine] = []
        boxes = getattr(result, "boxes", None)
        txts = getattr(result, "txts", None)
        scores = getattr(result, "scores", None)
        if boxes is not None and txts is not None and scores is not None:
            for box, text, score in zip(boxes, txts, scores, strict=True):
                folded = fold_lookalikes(str(text)).strip()
                if not folded:
                    continue
                corners = tuple((float(x), float(y)) for x, y in np.asarray(box).reshape(-1, 2)[:4])
                lines.append(OcrLine(folded, float(score), corners))
        return OcrPage(rotation, int(rgb.shape[1]), int(rgb.shape[0]), tuple(reading_order(lines)))


_engine: OcrEngine | None = None
_engine_lock = threading.Lock()


def get_engine() -> tuple[OcrEngine, bool]:
    """The process-wide engine, loaded on first use; the flag says whether this call loaded it."""
    global _engine
    with _engine_lock:
        if _engine is not None:
            return _engine, False
        _engine = OcrEngine()
        return _engine, True

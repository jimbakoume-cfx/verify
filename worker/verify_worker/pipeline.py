"""One job: from the claimed photo's bytes to the evidence sent back (WorkerResultRequest).

Order: check the bytes against the claim, decode, measure quality (no models needed), look for a QR
code, then OCR in the most likely orientation, pick candidate code lines, count keyword groups and
read the few allowed fields. The photo exists only as arrays in this function's memory.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from . import ENGINE, classify, fields, mrz, quality
from .contract import FIELD_NAMES, MRZ_LAYOUT
from .imaging import check_bytes, decode_jpeg, to_gray
from .ocr import OcrEngine, OcrPage, get_engine

EngineGetter = Callable[[], tuple[OcrEngine, bool]]


def _enough_code_lines(candidates: list[str]) -> bool:
    """At least as many candidates as the shortest MRZ has lines (2, TD3)."""
    return len(candidates) >= min(layout["lines"] for layout in MRZ_LAYOUT.values())


def _has_code_lines(declared: str, side: str, mrz_expectation: dict[str, Any] | None, candidates: list[str], page: OcrPage) -> bool:
    """Whether the document carries code lines, which limits the printed fields read (fields.py).

    The photo first: enough code-line candidates for an MRZ on this side (one stray row is not an
    MRZ), or a front that reads upright as a portrait card (the new models), mean a document with
    code lines whatever was declared. Otherwise the declared document decides (MRZ_EXPECTATION),
    except a declared residence permit, which may be an old card without code lines.
    """
    if _enough_code_lines(candidates):
        return True
    if side == "document_front" and classify.orientation(page) == "portrait":
        return True
    if mrz_expectation is None:
        return False
    return declared != "residence_permit"


def analyse(claim: dict[str, Any], data: bytes, engine_getter: EngineGetter = get_engine) -> dict[str, Any]:
    """The WorkerResultRequest for one claimed job. Raises imaging.ImageRejected for bad bytes."""
    started = time.monotonic()
    image = claim["image"]
    check_bytes(data, image["sha256"], image["byteSize"])
    decoded = decode_jpeg(data, image["width"], image["height"])
    gray = to_gray(decoded.rgb)
    metrics = quality.measure(gray)
    qr = classify.qr_present(gray)
    del gray

    engine, cold = engine_getter()
    declared = claim["declaredDocument"]
    side = claim["side"]

    def is_code_line(page: OcrPage) -> bool:
        return _enough_code_lines(mrz.find_candidates(page))

    read = classify.read_oriented(engine.read, decoded.rgb, declared, side, is_code_line)
    page = read.page
    del decoded

    candidates = mrz.find_candidates(page)
    hits = classify.keyword_hits(page)
    found = fields.extract(
        page,
        _has_code_lines(declared, side, claim.get("mrzExpectation"), candidates, page),
        classify.subtype(page),
    )
    ms = int(round((time.monotonic() - started) * 1000))
    return {
        "jobId": claim["jobId"],
        "attempt": claim["attempt"],
        "engine": ENGINE,
        "quality": {
            "sharpness": metrics.sharpness,
            "glareRatio": metrics.glare_ratio,
            "meanLuma": metrics.mean_luma,
            "documentFound": metrics.document_found,
            "documentConfidence": metrics.document_confidence,
            "longSide": metrics.long_side,
            "textLines": len(page.lines),
        },
        "mrzCandidates": candidates,
        "classification": {
            "rotation": page.rotation,
            "keywordHits": hits,
            "qrPresent": qr,
            "orientation": classify.orientation(page),
        },
        "fields": {name: found[name] for name in FIELD_NAMES if name in found},
        "timing": {"ms": ms, "cold": cold},
    }

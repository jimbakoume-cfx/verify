"""The Python port of the rider app's quality maths gives the same numbers as the TypeScript on the
same pixels. The reference values were computed by packages/capture itself
(tests/tools/make_quality_reference.py, which bundles the TypeScript and runs it in Node)."""

from __future__ import annotations

import hashlib
import json

import pytest

from conftest import FIXTURES
from quality_inputs import CASES, analysis_gray
from verify_worker.quality import MIN_DOCUMENT_CONFIDENCE, guide_in_still, measure_gray

REFERENCE = {c["name"]: c for c in json.loads((FIXTURES / "quality_reference.json").read_text())["cases"]}
METRICS = ("sharpness", "noise", "contrast", "focus", "glareRatio", "glareTileRatio", "meanLuma")


def test_reference_covers_every_case():
    assert sorted(REFERENCE) == sorted(name for name, _, _ in CASES)


@pytest.mark.parametrize("name, file, change", CASES, ids=[c[0] for c in CASES])
def test_same_numbers_as_the_typescript(name, file, change):
    ref = REFERENCE[name]
    gray = analysis_gray(file, change)
    # Same input pixels as the reference saw (a Pillow upgrade that decodes differently shows here).
    assert hashlib.sha256(gray.tobytes()).hexdigest() == ref["graySha256"]
    assert gray.shape == (ref["height"], ref["width"])
    guide = guide_in_still(gray.shape[1], gray.shape[0])
    assert guide.x == pytest.approx(ref["guide"]["x"], abs=1e-12)
    assert guide.width == pytest.approx(ref["guide"]["width"], abs=1e-12)

    detection, metrics = measure_gray(gray)
    expected = ref["metrics"]
    for key in METRICS:
        assert metrics[key] == pytest.approx(expected[key], rel=1e-9, abs=1e-9), key
    assert detection.confidence == pytest.approx(expected["documentConfidence"], abs=1e-9)
    box = detection.box if detection.confidence >= MIN_DOCUMENT_CONFIDENCE else None
    if expected["documentBox"] is None:
        assert box is None
    else:
        assert box is not None
        for key in ("x", "y", "width", "height"):
            assert getattr(box, key) == pytest.approx(expected["documentBox"][key], abs=1e-9), key
            assert getattr(detection.extent, key) == pytest.approx(expected["documentExtent"][key], abs=1e-9), key
        assert detection.angle == pytest.approx(expected["documentAngle"], abs=1e-9)


def test_the_reference_spans_the_interesting_range():
    confidences = {round(c["metrics"]["documentConfidence"], 3) for c in REFERENCE.values()}
    assert 0.0 in confidences and 1.0 in confidences and any(0 < c < 1 for c in confidences)
    assert REFERENCE["tilted"]["metrics"]["documentAngle"] == pytest.approx(-6, abs=1)
    assert REFERENCE["glare"]["metrics"]["glareRatio"] > 0.02
    assert REFERENCE["blur"]["metrics"]["focus"] < REFERENCE["passport-cmr"]["metrics"]["focus"]

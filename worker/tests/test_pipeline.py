"""One job end to end with a fake OCR engine: the result's shape, and what the claim decides."""

from __future__ import annotations

import hashlib
import json

import pytest

from conftest import SPECIMENS
from result_rules import problems
from verify_worker import pipeline
from verify_worker.contract import WORKER_LIMITS
from verify_worker.imaging import ImageRejected
from verify_worker.ocr import OcrLine, OcrPage

JOB = "7b0c3c1e-1a59-4c55-9d40-2f6f2a0d9c11"
TD1 = ["IDCMRSPC0001239<<<<<<<<<<<<<<<", "9002155F3503029CMR<<<<<<<<<<<2", "SPECIMEN<<HELENE<TEST<<<<<<<<<"]


def claim_for(file: str, declared: str = "cni_biometric", side: str = "document_back") -> tuple[dict, bytes]:
    data = (SPECIMENS / file).read_bytes()
    from verify_worker.imaging import decode_jpeg

    img = decode_jpeg(data)
    expectation = {"side": "document_back", "format": "TD1", "required": True} if declared == "cni_biometric" else None
    return (
        {
            "jobId": JOB,
            "attempt": 1,
            "captureId": "0a7f1f5e-5e2b-4f8a-9f53-0d0c4f9d2b10",
            "side": side,
            "declaredDocument": declared,
            "mrzExpectation": expectation,
            "image": {"sha256": hashlib.sha256(data).hexdigest(), "byteSize": len(data), "width": img.width, "height": img.height},
        },
        data,
    )


class FakeEngine:
    def __init__(self, texts: list[str]):
        self.texts = texts
        self.rotations: list[int] = []

    def read(self, rgb, rotation):
        self.rotations.append(rotation)
        lines = tuple(
            OcrLine(t, 0.99, ((50, 40 * i), (50 + 20 * len(t), 40 * i), (50 + 20 * len(t), 40 * i + 30), (50, 40 * i + 30)))
            for i, t in enumerate(self.texts)
        )
        return OcrPage(rotation, rgb.shape[1], rgb.shape[0], lines)


def run(texts: list[str], **kw) -> dict:
    claim, data = claim_for(**kw) if kw else claim_for("cni-new-back.jpg")
    engine = FakeEngine(texts)
    return pipeline.analyse(claim, data, engine_getter=lambda: (engine, True))


BACK = ["DATE DE DÉLIVRANCE / DATE OF ISSUE", "02.03.2025", "PÈRE / FATHER", "ESSAI PAPA", *TD1]


def test_result_follows_the_contract():
    result = run(BACK)
    assert problems(result) == []
    assert result["jobId"] == JOB and result["attempt"] == 1
    assert result["mrzCandidates"] == TD1
    assert result["fields"] == {"issueDate": "2025-03-02"}
    assert result["classification"]["qrPresent"] is True
    assert result["classification"]["rotation"] == 0
    assert result["quality"]["documentFound"] is True and result["quality"]["textLines"] == len(BACK)
    assert result["timing"]["cold"] is True and result["timing"]["ms"] >= 0
    assert len(json.dumps(result)) < WORKER_LIMITS["maxBodyBytes"]


def test_nothing_read_is_still_a_valid_result():
    result = run([])
    assert problems(result) == []
    assert result["mrzCandidates"] == [] and result["fields"] == {} and result["quality"]["textLines"] == 0
    assert result["classification"]["orientation"] is None


def test_documents_with_and_without_code_lines_read_the_same_fields():
    # Since M4: the server compares the printed number and dates with the code lines.
    texts = ["NOM / SURNAME", "EXEMPLE", "DATE DE NAISSANCE / DATE OF BIRTH", "07.11.1984"]
    with_mrz = run(texts, file="cni-old-front.jpg", declared="cni_biometric", side="document_front")
    without = run(texts, file="cni-old-front.jpg", declared="cni_legacy", side="document_front")
    assert with_mrz["fields"] == without["fields"] == {"surname": "EXEMPLE", "birthDate": "1984-11-07"}


def test_one_stray_code_like_row_does_not_make_a_document_with_code_lines():
    """A single candidate is not an MRZ (TD3 has 2 lines, TD1 3): a driving licence with one such row
    still gets the fields of a document without code lines."""
    texts = ["NOM / SURNAME", "EXEMPLE", "N° DU PERMIS / LICENCE NUMBER", "DL1234567", "9002155F3503029CMR<<<<<<<<<<<2"]
    result = run(texts, file="driving-licence-front.jpg", declared="driving_licence", side="document_front")
    assert len(result["mrzCandidates"]) == 1
    assert result["fields"] == {"surname": "EXEMPLE", "documentNumber": "DL1234567"}


def test_bytes_that_differ_from_the_claim_are_refused():
    claim, data = claim_for("cni-new-back.jpg")
    with pytest.raises(ImageRejected):
        pipeline.analyse(claim, data[:-10], engine_getter=lambda: (FakeEngine([]), False))
    claim["image"]["width"] += 1
    with pytest.raises(ImageRejected):
        pipeline.analyse(claim, data, engine_getter=lambda: (FakeEngine([]), False))


def test_models_load_only_after_the_bytes_check_out():
    claim, data = claim_for("cni-new-back.jpg")
    calls = []

    def getter():
        calls.append(1)
        return FakeEngine([]), True

    with pytest.raises(ImageRejected):
        pipeline.analyse(claim, b"\x00" * len(data), engine_getter=getter)
    assert calls == []

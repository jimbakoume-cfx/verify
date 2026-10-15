"""The OCR models come from the rapidocr wheel, pinned by SHA-256; nothing is downloaded."""

from __future__ import annotations

import shutil

import pytest

from verify_worker import ocr


def test_models_in_the_wheel_match_the_pins():
    paths = ocr.verify_models(ocr.model_dir())
    assert sorted(paths) == ["cls", "det", "rec"]


def test_a_changed_or_missing_model_is_refused(tmp_path):
    source = ocr.model_dir()
    for name, _ in ocr.MODEL_FILES.values():
        shutil.copy(source / name, tmp_path / name)
    ocr.verify_models(tmp_path)
    det = tmp_path / ocr.MODEL_FILES["det"][0]
    data = bytearray(det.read_bytes())
    data[-1] ^= 1
    det.write_bytes(bytes(data))
    with pytest.raises(ocr.ModelIntegrityError):
        ocr.verify_models(tmp_path)
    det.unlink()
    with pytest.raises(ocr.ModelIntegrityError):
        ocr.verify_models(tmp_path)


def test_no_download_path_is_reachable(monkeypatch):
    """Loading the engine never calls RapidOCR's downloader (every model path is set explicitly)."""
    import rapidocr.utils.download_file as download_file

    def refuse(*args, **kwargs):
        raise AssertionError("a model download was attempted")

    monkeypatch.setattr(download_file.DownloadFile, "run", classmethod(lambda cls, *a, **k: refuse()))
    import rapidocr.inference_engine.onnxruntime.main as ort_main

    monkeypatch.setattr(ort_main.DownloadFile, "run", classmethod(lambda cls, *a, **k: refuse()))
    engine = ocr.OcrEngine(threads=1)
    assert engine is not None

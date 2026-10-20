"""Loading the models, once per process, after checking every byte.

The files sit in FACE_MODELS_DIR (default: worker-face/models/, filled at build time by
scripts/fetch_models.py and bundled with the function). Each is read whole and its SHA-256 compared
with model_manifest.py before any runtime sees it; a file that is missing or differs stops the ring
(ModelIntegrityError), so a wrong model is never used. The face mesh models are small and always
loaded; AuraFace (261 MB, about 1 s and 500 MB of memory to load) only for face_match jobs.
"""

from __future__ import annotations

import hashlib
import io
import os
import time
import zipfile
from pathlib import Path
from threading import Lock
from typing import Any

from .model_manifest import FORBIDDEN_SHA256, LANDMARKER_MEMBERS, MODELS

DEFAULT_DIR = Path(__file__).resolve().parent.parent / "models"
_lock = Lock()
_landmarker: Any = None
_recogniser: Any = None


class ModelIntegrityError(Exception):
    """A model file is missing or is not the pinned file; `code` says which (logged)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def models_dir() -> Path:
    return Path(os.environ.get("FACE_MODELS_DIR") or DEFAULT_DIR)


def threads() -> int:
    try:
        return max(1, min(4, int(os.environ.get("FACE_MODEL_THREADS", "1"))))
    except ValueError:
        return 1


def read_checked(name: str, directory: Path | None = None) -> bytes:
    """The file's bytes, when its size and SHA-256 are the pinned ones."""
    spec = MODELS[name]
    path = (directory or models_dir()) / name
    try:
        data = path.read_bytes()
    except OSError as err:
        raise ModelIntegrityError(f"missing.{name}") from err
    digest = hashlib.sha256(data).hexdigest()
    if digest in FORBIDDEN_SHA256:
        raise ModelIntegrityError(f"forbidden.{name}")
    if len(data) != spec["size"] or digest != spec["sha256"]:
        raise ModelIntegrityError(f"mismatch.{name}")
    return data


def available(directory: Path | None = None) -> dict[str, bool]:
    """Which model files are present (by name only; the tests use it to skip, never to trust)."""
    base = directory or models_dir()
    return {name: (base / name).is_file() for name in MODELS}


def landmarker_members(task: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(task)) as archive:
        return {name: archive.read(name) for name in LANDMARKER_MEMBERS}


def landmarker() -> tuple[Any, float]:
    """(FaceLandmarker, seconds spent loading now; 0 when it was already loaded)."""
    global _landmarker
    with _lock:
        if _landmarker is not None:
            return _landmarker, 0.0
        started = time.monotonic()
        from .landmarks import FaceLandmarker

        _landmarker = FaceLandmarker(landmarker_members(read_checked("face_landmarker.task")), threads())
        return _landmarker, time.monotonic() - started


def recogniser() -> tuple[Any, float]:
    """(AuraFace ONNX Runtime session, seconds spent loading now)."""
    global _recogniser
    with _lock:
        if _recogniser is not None:
            return _recogniser, 0.0
        started = time.monotonic()
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.intra_op_num_threads = threads()
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        data = read_checked("glintr100.onnx")
        _recogniser = ort.InferenceSession(data, options, providers=["CPUExecutionProvider"])
        del data
        return _recogniser, time.monotonic() - started


def reset() -> None:
    """Forget the loaded models (tests)."""
    global _landmarker, _recogniser
    with _lock:
        _landmarker = _recogniser = None

"""The model files: models.py refuses anything but the pinned bytes, and scripts/fetch_models.py
downloads only those (a local server plays the model host: no network)."""

from __future__ import annotations

import hashlib
import importlib.util
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from conftest import FACE
from verify_face import model_manifest, models
from verify_face.models import ModelIntegrityError


def load_fetch():
    spec = importlib.util.spec_from_file_location("fetch_models", FACE / "scripts" / "fetch_models.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def host():
    """Serves `files` (path -> bytes) on 127.0.0.1."""
    files: dict[str, bytes] = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            return

        def do_GET(self):  # noqa: N802
            data = files.get(self.path)
            if data is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}", files
    server.shutdown()
    server.server_close()


@pytest.fixture
def fake_manifest(monkeypatch, host):
    base, files = host
    good = b"the pinned model bytes"
    files["/model.bin"] = good
    files["/wrong.bin"] = b"not the pinned bytes!!"
    spec = {"url": f"{base}/model.bin", "sha256": hashlib.sha256(good).hexdigest(), "size": len(good), "licence": "Apache-2.0"}
    fetch = load_fetch()
    monkeypatch.setattr(fetch, "MODELS", {"model.bin": spec})
    monkeypatch.setattr(models, "MODELS", {"model.bin": spec})
    return fetch, spec, files, base


def test_fetch_downloads_the_pinned_file_and_keeps_it(tmp_path, fake_manifest):
    fetch, spec, files, _ = fake_manifest
    assert fetch.main(["--dir", str(tmp_path)]) == 0
    assert (tmp_path / "model.bin").read_bytes() == files["/model.bin"]
    assert (tmp_path / "model.bin").stat().st_mode & 0o044 == 0o044  # readable by the function's user
    files["/model.bin"] = b"changed on the host!!!"
    assert fetch.main(["--dir", str(tmp_path)]) == 0  # present and right: kept, not downloaded again
    assert models.read_checked("model.bin", tmp_path) == b"the pinned model bytes"


def test_fetch_refuses_other_bytes_and_leaves_nothing(tmp_path, fake_manifest):
    fetch, spec, _, base = fake_manifest
    spec["url"] = f"{base}/wrong.bin"
    assert fetch.main(["--dir", str(tmp_path)]) == 1
    assert list(tmp_path.iterdir()) == []


def test_fetch_refuses_a_forbidden_file_even_if_pinned_by_mistake(tmp_path, fake_manifest, monkeypatch):
    fetch, spec, files, _ = fake_manifest
    monkeypatch.setattr(fetch, "FORBIDDEN_SHA256", {spec["sha256"]: "a forbidden file"})
    assert fetch.main(["--dir", str(tmp_path)]) == 1
    assert list(tmp_path.iterdir()) == []


def test_models_refuse_a_missing_changed_or_forbidden_file(tmp_path, fake_manifest, monkeypatch):
    _, spec, _, _ = fake_manifest
    with pytest.raises(ModelIntegrityError, match="missing"):
        models.read_checked("model.bin", tmp_path)
    (tmp_path / "model.bin").write_bytes(b"the pinned model bytez")
    with pytest.raises(ModelIntegrityError, match="mismatch"):
        models.read_checked("model.bin", tmp_path)
    monkeypatch.setattr(models, "FORBIDDEN_SHA256", {hashlib.sha256(b"the pinned model bytez").hexdigest(): "x"})
    with pytest.raises(ModelIntegrityError, match="forbidden"):
        models.read_checked("model.bin", tmp_path)


def test_the_manifest_never_pins_an_insightface_file():
    pinned = {spec["sha256"] for spec in model_manifest.MODELS.values()}
    assert not pinned & set(model_manifest.FORBIDDEN_SHA256)
    # AuraFace's own recognition model differs from InsightFace's antelopev2 glintr100.onnx.
    assert model_manifest.MODELS["glintr100.onnx"]["sha256"] != "4ab1d6435d639628a6f3e5008dd4f929edf4c4124b1a7169e1048f9fef534cdf"


def test_the_fetch_script_needs_the_standard_library_only():
    text = (FACE / "scripts" / "fetch_models.py").read_text(encoding="utf-8") + Path(model_manifest.__file__).read_text(encoding="utf-8")
    for module in ("numpy", "PIL", "onnxruntime", "ai_edge_litert", "requests", "cryptography"):
        assert f"import {module}" not in text and f"from {module}" not in text

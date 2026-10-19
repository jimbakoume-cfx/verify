"""vercel.json, the model files and what ships with the function: the settings the deploy relies on,
kept from drifting, and the licence notices of what carries none."""

from __future__ import annotations

import fnmatch
import importlib.metadata
import json
import re
import subprocess
import sys
import tomllib

from conftest import FACE, REPO
from verify_face.model_manifest import FORBIDDEN_SHA256, LANDMARKER_MEMBERS, MODELS

CONFIG = json.loads((FACE / "vercel.json").read_text(encoding="utf-8"))
NOTICE = FACE / "NOTICE"
TABLE = tomllib.loads((REPO / "scripts" / "python-licenses-face.toml").read_text(encoding="utf-8"))
REVIEWED = TABLE["packages"]
RUNTIME = sorted(name for name, row in REVIEWED.items() if row["group"] == "runtime")
LICENCE_FILE = re.compile(r"^(licen[cs]e|copying|notice)", re.IGNORECASE)
FUNCTION = CONFIG["functions"]["api/process.py"]


def test_paris_only_no_git_deployments_and_everything_bundled():
    assert CONFIG["regions"] == ["cdg1"]
    assert CONFIG["git"] == {"deploymentEnabled": False}
    assert CONFIG["build"]["env"]["VERCEL_PYTHON_DISABLE_RUNTIME_INSTALL"] == "1"


def test_the_build_fetches_the_models_and_the_function_ships_them():
    assert CONFIG["buildCommand"] == "python3 scripts/fetch_models.py"
    assert FUNCTION["includeFiles"] == "models/**"
    assert FUNCTION["maxDuration"] <= 300
    assert FUNCTION["memory"] <= 2048  # Hobby's maximum


def _excluded(path: str) -> bool:
    ignored = [line.strip() for line in (FACE / ".vercelignore").read_text(encoding="utf-8").splitlines()]
    patterns = [line for line in ignored if line and not line.startswith("#")]
    exclude = FUNCTION["excludeFiles"]
    patterns += exclude.strip("{}").split(",") if exclude.startswith("{") else [exclude]
    return any(fnmatch.fnmatchcase(path, p) or fnmatch.fnmatchcase(path, p.rstrip("/*")) for p in patterns)


def test_tests_stay_out_and_the_notice_and_models_go_in():
    assert _excluded("tests/test_models.py") and _excluded("README.md")
    assert not _excluded("NOTICE")
    assert not _excluded("models/glintr100.onnx")
    assert not _excluded("verify_face/data/canonical_face.json")


def test_vercel_finds_the_entrypoint():
    pyproject = tomllib.loads((FACE / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["tool"]["vercel"]["entrypoint"] == "api.process:handler"


def test_the_litert_interpreter_needs_numpy_only():
    """The pyproject leaves out the packages ai-edge-litert declares but never imports; importing the
    interpreter in a fresh process must not need them."""
    code = (
        "import sys; before = set(sys.modules); from ai_edge_litert.interpreter import Interpreter; "
        "print(','.join(sorted({m.split('.')[0] for m in set(sys.modules) - before})))"
    )
    loaded = set(subprocess.run([sys.executable, "-c", code], check=True, capture_output=True, text=True).stdout.strip().split(","))
    assert loaded & {"tqdm", "google", "ml_dtypes", "backports", "flatbuffers", "typing_extensions"} == set()
    assert "numpy" in loaded


def test_models_are_pinned_never_forbidden_and_reviewed():
    rows = {row["name"]: row for row in TABLE["model"]}
    assert set(rows) == set(MODELS)
    for name, spec in MODELS.items():
        assert str(spec["url"]).startswith("https://")
        assert spec["sha256"] not in FORBIDDEN_SHA256
        assert rows[name]["sha256"] == spec["sha256"]
        assert rows[name]["license"] == spec["licence"]
    # AuraFace's file is pinned to a commit, never to a moving branch.
    assert "/resolve/af6d057c9b0ec4071d4c49c80e3539258798b609/glintr100.onnx" in str(MODELS["glintr100.onnx"]["url"])
    assert LANDMARKER_MEMBERS == ("face_detector.tflite", "face_landmarks_detector.tflite", "face_blendshapes.tflite")


def test_the_insightface_files_of_the_auraface_repository_are_never_fetched():
    for name in ("scrfd_10g_bnkps.onnx", "2d106det.onnx", "1k3d68.onnx", "genderage.onnx"):
        assert name not in MODELS
        assert not any(name in str(spec["url"]) for spec in MODELS.values())
    assert len(FORBIDDEN_SHA256) == 5


def _has_licence_text(name: str) -> bool:
    files = importlib.metadata.distribution(name).files or []
    return any(LICENCE_FILE.match(file.name) or ".dist-info/licenses/" in file.as_posix() for file in files)


def test_every_runtime_package_and_model_without_licence_text_is_in_the_notice():
    notice = NOTICE.read_text(encoding="utf-8")
    without_text = [name for name in RUNTIME if not _has_licence_text(name)]
    assert without_text == ["ai-edge-litert"]
    for name in without_text:
        assert f"{name} {REVIEWED[name]['version']}" in notice
    for name in MODELS:
        assert f"models/{name}" in notice
    for clause in ("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION", "END OF TERMS AND CONDITIONS"):
        assert clause in notice

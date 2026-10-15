"""vercel.json and what ships with the function: the settings the deploy relies on, kept from
drifting, and the licence notices of the packages that carry none."""

from __future__ import annotations

import fnmatch
import importlib.metadata
import json
import re
import tomllib

from conftest import REPO, WORKER

CONFIG = json.loads((WORKER / "vercel.json").read_text(encoding="utf-8"))
NOTICE = WORKER / "NOTICE"
REVIEWED = tomllib.loads((REPO / "scripts" / "python-licenses.toml").read_text(encoding="utf-8"))["packages"]
RUNTIME = sorted(name for name, row in REVIEWED.items() if row["group"] == "runtime")
LICENCE_FILE = re.compile(r"^(licen[cs]e|copying|notice)", re.IGNORECASE)


def test_paris_only_and_no_git_deployments():
    assert CONFIG["regions"] == ["cdg1"]
    assert CONFIG["git"] == {"deploymentEnabled": False}


def test_every_package_is_bundled_none_installed_at_cold_start():
    """The installed packages are over Vercel's 225 MB standard function size. Without this flag the
    Python builder bundles only what fits and installs the rest from PyPI on every cold start, which
    could bring the OCR models (inside the rapidocr wheel) over the network at run time."""
    assert CONFIG["build"]["env"]["VERCEL_PYTHON_DISABLE_RUNTIME_INSTALL"] == "1"


def test_tests_stay_out_of_the_function_bundle():
    function = CONFIG["functions"]["api/process.py"]
    assert "tests/**" in function["excludeFiles"]
    assert function["maxDuration"] <= 300


def test_vercel_finds_the_entrypoint():
    """With a pyproject.toml present, Vercel builds a Python app and refuses to deploy unless the
    entrypoint is named; the functions entry above must be keyed on the same file."""
    pyproject = tomllib.loads((WORKER / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["tool"]["vercel"]["entrypoint"] == "api.process:handler"
    assert "api/process.py" in CONFIG["functions"]


def _excluded(path: str) -> bool:
    """Whether .vercelignore or the function's excludeFiles drops this path from the deployment."""
    ignored = [line.strip() for line in (WORKER / ".vercelignore").read_text(encoding="utf-8").splitlines()]
    patterns = [line for line in ignored if line and not line.startswith("#")]
    exclude = CONFIG["functions"]["api/process.py"]["excludeFiles"]
    patterns += exclude.strip("{}").split(",") if exclude.startswith("{") else [exclude]
    return any(fnmatch.fnmatchcase(path, pattern) or fnmatch.fnmatchcase(path, pattern.rstrip("/*")) for pattern in patterns)


def _has_licence_text(name: str) -> bool:
    """A licence or notice file in the installed package: its .dist-info (licenses/ folder included)
    or its own folders."""
    files = importlib.metadata.distribution(name).files or []
    return any(LICENCE_FILE.match(file.name) or ".dist-info/licenses/" in file.as_posix() for file in files)


def test_the_notice_ships_with_the_function():
    assert NOTICE.is_file()
    assert not _excluded("NOTICE")
    # The checks above do see an excluded file.
    assert _excluded("README.md") and _excluded("tests/test_deploy_config.py")


def test_every_runtime_package_ships_with_its_licence_text():
    """Apache-2.0 and BSD ask for the licence to go with the software. A wheel without any licence
    file (rapidocr, flatbuffers, antlr4) must have its licence and attribution in worker/NOTICE; a
    new or upgraded package without one fails here until it is added."""
    notice = NOTICE.read_text(encoding="utf-8")
    without_text = [name for name in RUNTIME if not _has_licence_text(name)]
    assert without_text, "every wheel now ships its licence text: trim worker/NOTICE and this test"
    for name in without_text:
        version = REVIEWED[name]["version"]
        assert f"{name} {version}" in notice, f"{name} {version} ships no licence text and is not in worker/NOTICE"
    # The licence texts themselves, in full.
    if any(REVIEWED[name]["license"].startswith("Apache-2.0") for name in without_text):
        for clause in ("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION", "9. Accepting Warranty or Additional Liability",
                       "END OF TERMS AND CONDITIONS"):
            assert clause in notice
    if any(REVIEWED[name]["license"] == "BSD-3-Clause" for name in without_text):
        assert "Redistributions in binary form must reproduce the above copyright" in notice


def test_the_notice_names_the_ocr_models():
    """The PP-OCR models come inside the rapidocr wheel, with no licence file of their own."""
    notice = NOTICE.read_text(encoding="utf-8")
    for model in ("PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx", "ch_ppocr_mobile_v2.0_cls_mobile.onnx"):
        assert model in notice
    assert "PaddlePaddle Authors" in notice

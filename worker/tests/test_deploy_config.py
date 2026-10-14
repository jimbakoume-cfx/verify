"""vercel.json: the settings the deploy relies on, kept from drifting."""

from __future__ import annotations

import json
import tomllib

from conftest import WORKER

CONFIG = json.loads((WORKER / "vercel.json").read_text(encoding="utf-8"))


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

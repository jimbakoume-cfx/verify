"""vercel.json: the settings the deploy relies on, kept from drifting."""

from __future__ import annotations

import json

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

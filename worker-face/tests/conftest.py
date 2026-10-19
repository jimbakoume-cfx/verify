"""Shared test setup: paths, the model files (tests marked `models` are skipped without them), Deno for
the tests that run the real face Edge Function, and a timing report printed at the end of the run
(CPU times are reported, never asserted)."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import pytest

FACE = Path(__file__).resolve().parent.parent
REPO = FACE.parent
SPECIMENS = REPO / "e2e" / "fixtures" / "specimens"

for path in (str(FACE), str(Path(__file__).resolve().parent)):
    if path not in sys.path:
        sys.path.insert(0, path)

from verify_face import models  # noqa: E402

TIMINGS: list[tuple[str, float, float]] = []


def models_present() -> bool:
    return all(models.available().values())


def pytest_collection_modifyitems(config, items):  # noqa: ANN001
    """Tests marked `models` need the fetched model files (scripts/fetch_models.py). Without them they
    are skipped, unless FACE_REQUIRE_MODELS=1 says they must run (then a missing file fails them)."""
    if models_present() or os.environ.get("FACE_REQUIRE_MODELS") == "1":
        return
    skip = pytest.mark.skip(reason="model files not fetched (python3 scripts/fetch_models.py)")
    for item in items:
        if "models" in item.keywords:
            item.add_marker(skip)


def deno_or_skip(why: str = "Deno is not available (run npm ci at the repo root)") -> None:
    if os.environ.get("FACE_REQUIRE_DENO") == "1":
        pytest.fail(why)
    pytest.skip(why)


def has_deno() -> bool:
    return shutil.which("npx") is not None and (REPO / "node_modules" / "deno").exists()


def pytest_terminal_summary(terminalreporter, exitstatus, config):  # noqa: ANN001
    if not TIMINGS:
        return
    terminalreporter.section("face worker CPU time per job (reported, not asserted)")
    for name, cpu, wall in TIMINGS:
        terminalreporter.write_line(f"{name:52s} cpu {cpu:6.2f} s   wall {wall:6.2f} s")

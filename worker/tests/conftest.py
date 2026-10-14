"""Shared test setup: paths, the specimen manifest, the real OCR engine (loaded once), and a
timing report printed at the end of the run (timings are reported, never asserted)."""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import pytest

WORKER = Path(__file__).resolve().parent.parent
REPO = WORKER.parent
SPECIMENS = REPO / "e2e" / "fixtures" / "specimens"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

for path in (str(WORKER), str(Path(__file__).resolve().parent)):
    if path not in sys.path:
        sys.path.insert(0, path)

TIMINGS: list[tuple[str, float, float]] = []


def deno_or_skip(why: str = "Deno is not available (run npm ci at the repo root)") -> None:
    """Skips a test that runs Edge Function code in Deno when Node or the repo's pinned Deno (npx deno,
    from node_modules) is missing. CI sets WORKER_REQUIRE_DENO=1: there a missing toolchain, or a
    Deno run that fails, fails the test instead of skipping it."""
    if os.environ.get("WORKER_REQUIRE_DENO") == "1":
        pytest.fail(why)
    pytest.skip(why)


def has_deno() -> bool:
    return shutil.which("npx") is not None and (REPO / "node_modules" / "deno").exists()


@pytest.fixture(scope="session")
def manifest() -> dict:
    return json.loads((SPECIMENS / "manifest.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def ocr_engine():
    from verify_worker.ocr import get_engine

    engine, _ = get_engine()
    return engine


def pytest_terminal_summary(terminalreporter, exitstatus, config):  # noqa: ANN001
    if not TIMINGS:
        return
    terminalreporter.section("worker timing per image (reported, not asserted)")
    for name, cpu, wall in TIMINGS:
        terminalreporter.write_line(f"{name:40s} cpu {cpu:5.2f} s   wall {wall:5.2f} s")
    cpus = sorted(t[1] for t in TIMINGS)
    terminalreporter.write_line(
        f"{len(cpus)} images: CPU median {cpus[len(cpus) // 2]:.2f} s, max {cpus[-1]:.2f} s, total {sum(cpus):.1f} s"
    )

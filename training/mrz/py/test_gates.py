"""gates.py on hand-made measurements: a candidate passes only with every number it is judged on.

Standard library only (gates.py needs nothing else), so CI runs it with the runner's Python 3:
    python3 -m unittest discover -s training/mrz/py -p "test_*.py"
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATES = HERE.parent / "gates.json"
DOCS = 1000


def write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value))


def g1(name: str, cer: float, line_exact: float = 99.9, lines: int = 600) -> dict:
    return {"set": name, "lines": lines, "cer": cer, "lineExact": line_exact}


def docbench(valid_exact: float = 99.0, valid_wrong: int = 0) -> dict:
    group = {"n": DOCS, "validExact": DOCS, "validWrong": valid_wrong, "invalid": 0, "notFound": 0, "nameExact": DOCS, "cer": 0, "msPerStill": 1}
    return {
        "bench": {"count": DOCS, "sha256": "f" * 64},
        "overall": {"n": DOCS, "validWrong": valid_wrong, "validWrongFromCorrection": 0, "validExactRate": valid_exact, "nameExactRate": 100},
        "groups": {"TD1-clean": group},
    }


class GateTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.cand, self.base = root / "candidate", root / "doubango"
        self.cand.mkdir()
        self.base.mkdir()
        self.model = root / "model.json"
        write(self.model, {"integerGz": {"bytes": 1_000_000}})
        # Doubango's numbers (as in results/baseline-doubango.md) and a candidate better on every set.
        for name, cer in (("clean", 0.014), ("degraded", 5.457), ("lowres", 0.922)):
            write(self.base / f"g1-{name}.json", g1(name, cer))
            write(self.cand / f"g1-{name}.json", g1(name, cer / 2))
        write(self.base / f"docbench-{DOCS}.json", docbench(valid_exact=98.0, valid_wrong=1))
        write(self.cand / "docbench.json", docbench())
        write(self.cand / "fixtures.json", {"fixtureFailures": []})

    def run_gates(self, cand: Path | None = None, model: str | None = None) -> tuple[int, list[dict]]:
        cand = cand or self.cand
        args = [sys.executable, str(HERE / "gates.py"), str(cand), str(self.base), str(GATES), model or str(self.model)]
        done = subprocess.run(args, capture_output=True, text=True, check=False)
        report = json.loads((cand / "report.json").read_text())
        return done.returncode, report["checks"]

    def rows(self, checks: list[dict], gate: str, what: str) -> list[dict]:
        return [x for x in checks if x["gate"] == gate and what in x["check"]]

    def test_a_candidate_with_every_number_passes(self) -> None:
        code, checks = self.run_gates()
        self.assertEqual(code, 0, checks)
        self.assertEqual(len(self.rows(checks, "G1", "vs Doubango")), 3)

    def test_a_missing_baseline_set_is_missing_not_passed(self) -> None:
        # An interrupted baseline run left g1-clean.json only; the candidate is worse than Doubango
        # on degraded lines (8% against 5.457%), which nothing may wave through.
        (self.base / "g1-degraded.json").unlink()
        write(self.cand / "g1-degraded.json", g1("degraded", 8.0))
        code, checks = self.run_gates()
        self.assertEqual(code, 1)
        [row] = self.rows(checks, "G1", "degraded: CER % vs Doubango")
        self.assertEqual(row["result"], "missing")

    def test_a_candidate_without_model_json_fails_on_size(self) -> None:
        code, checks = self.run_gates(model="-")
        self.assertEqual(code, 1)
        [row] = self.rows(checks, "size", "gzipped")
        self.assertEqual(row["result"], "missing")

    def test_the_baseline_is_not_judged_on_size(self) -> None:
        for name in ("clean", "degraded", "lowres"):
            write(self.base / f"g1-{name}.json", g1(name, 0.1))
        write(self.base / "docbench.json", docbench())
        write(self.base / "fixtures.json", {"fixtureFailures": []})
        code, checks = self.run_gates(cand=self.base, model="-")
        self.assertEqual(self.rows(checks, "size", "gzipped"), [])
        self.assertEqual(self.rows(checks, "G1", "vs Doubango"), [])
        self.assertEqual(code, 0, checks)


if __name__ == "__main__":
    unittest.main()

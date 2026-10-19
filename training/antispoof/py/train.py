"""STUB: trains our own screen and print detectors once the attack captures exist (README.md).

  uv run --project ../../worker-face python py/train.py --manifest captures/manifest.jsonl --root captures/

1. Loads and checks the manifest (manifest.py) and refuses to train while readiness() lists a problem.
2. Splits by person (never by frame).
3. Features: the face worker's own measures on each capture (worker-face/verify_face: the face box from
   the landmarker, spoof.measure's moire, glare and detail, plus colour statistics), so what is trained
   is exactly what runs on the server.
4. Model: a logistic regression per attack family, in numpy (no new dependency); later a small CNN on
   face crops if the hand-made features are not enough (a new model file, its own licence row).
5. Report: APCER per attack type and BPCER, overall and per Monk tone group, device and lighting, on the
   evaluation people only; the cut-offs that become face/decide.ts's MOIRE_MIN, SCREEN_GLARE_MIN and
   LOW_DETAIL_MAX (or a new score) are chosen there, with the PM.

Nothing is trained yet: we have no attack photos (PM, 2026-10-19). Running it now says what is missing.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from manifest import load, readiness, split_by_person  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train the screen and print detectors (stub).")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args(argv)
    rows = load(args.manifest.read_text(encoding="utf-8"))
    problems = readiness(rows)
    if problems:
        print("Not enough consented attack captures to train yet:")
        for problem in problems:
            print(f"  - {problem}")
        return 2
    train, test = split_by_person(rows)
    print(f"{len(train)} training rows, {len(test)} evaluation rows. Feature extraction and training: to build (see the docstring).")
    return 1


if __name__ == "__main__":
    sys.exit(main())

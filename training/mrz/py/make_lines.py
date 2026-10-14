"""Renders one shard of synthetic code lines (lines.py) for training or for a held-out G1 set.

Each line is either
- "prepared" (share `--prepared`): drawn with a loose margin like a located band and written as a
  PGM plus a job in <jobs dir>/jobs.jsonl, for node/cutLines.ts to run the rider's prepare step on
  and cut where Tesseract cuts; or
- "grey": cropped here as Tesseract would and written straight to <gt dir> as PNG with its
  .gt.txt and .box (no binarisation: variety for the model, and robustness).

usage: make_lines.py --font OCRB.otf --gt GT_DIR --jobs JOBS_DIR --count N --seed S --prefix P
                     [--preset train|clean|degraded|lowres] [--prepared 0.6] [--random-share 0.15]
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from lines import PRESETS, Fonts, band_margins, check_text, render_line, tesseract_margins, write_box, write_pgm
from mrztext import MrzText


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--font", required=True)
    ap.add_argument("--gt", required=True, type=Path)
    ap.add_argument("--jobs", required=True, type=Path)
    ap.add_argument("--count", required=True, type=int)
    ap.add_argument("--seed", required=True, type=int)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--preset", default="train", choices=sorted(PRESETS))
    ap.add_argument("--prepared", type=float, default=0.6)
    ap.add_argument("--random-share", type=float, default=0.15)
    args = ap.parse_args()

    args.gt.mkdir(parents=True, exist_ok=True)
    args.jobs.mkdir(parents=True, exist_ok=True)
    r = random.Random(args.seed)
    text_gen = MrzText(r)
    fonts = Fonts(args.font)
    preset = PRESETS[args.preset]
    training = args.preset == "train"
    with (args.jobs / "jobs.jsonl").open("w") as jobs:
        for i in range(args.count):
            text = text_gen.line(args.random_share)
            check_text(text)
            name = f"{args.prefix}_{i:05d}"
            if r.random() < args.prepared:
                # The rider straightens the band before preparing it: only a residual tilt is left.
                im, cap = render_line(text, fonts, r, preset, band_margins(r), neighbours=False, specks=training,
                                      max_rotation=0.5 if preset["rot"] else 0.0)
                write_pgm(im, args.jobs / f"{name}.pgm")
                binarization = "local" if r.random() < 0.8 else "otsu"
                jobs.write(json.dumps({"kind": "line", "file": f"{name}.pgm", "text": text, "charHeight": round(cap, 2),
                                       "binarization": binarization, "out": name}) + "\n")
            else:
                im, _ = render_line(text, fonts, r, preset, tesseract_margins(r), neighbours=training, specks=training,
                                    max_rotation=preset["rot"])
                im.save(args.gt / f"{name}.png")
                (args.gt / f"{name}.gt.txt").write_text(text + "\n")
                write_box(args.gt / f"{name}.box", text, im.width, im.height)


if __name__ == "__main__":
    main()

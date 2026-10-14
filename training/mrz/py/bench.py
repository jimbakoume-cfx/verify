"""Renders the G2/G3 document benchmark: fictitious TD1 card backs and TD3 passport pages as the
rider's still shows them, with random data and valid check digits.

The drawing is NOT the training renderer's (py/docs.py): it is the repository's fixture renderer,
scripts/make-mrz-fixtures.py (imported read-only; its layout, fonts, shading and degradation), so
the gates measure reading, not memory of one renderer. Seeds are separate from every training seed.

Item i is TD1 when i is even, TD3 when odd; items alternate in pairs between "clean" (sensor noise
only) and "degraded" (out of focus, noise, JPEG q70; half of them turned up to 2.5 degrees), so
any prefix of the list (the 200-document baseline) is balanced.

usage: bench.py REPO OUT_DIR START END SEED     renders items START..END-1 into OUT_DIR, listing
                                                 them in OUT_DIR/items-START.jsonl
       bench.py --merge OUT_DIR --count N        joins the lists of items 0..N-1 into OUT_DIR/bench.json
"""

from __future__ import annotations

import importlib.util
import json
import random
import sys
from pathlib import Path

# Never write bytecode next to the repository's scripts.
sys.dont_write_bytecode = True

from PIL import Image

from mrztext import MrzText


def load_fixture_renderer(repo: Path):
    spec = importlib.util.spec_from_file_location("make_mrz_fixtures", repo / "scripts" / "make-mrz-fixtures.py")
    fx = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fx)  # type: ignore[union-attr]
    return fx


def render_item(fx, i: int, seed: int) -> tuple[Image.Image, dict]:
    r = random.Random(seed * 1_000_003 + i)
    fmt = "TD1" if i % 2 == 0 else "TD3"
    variant = "clean" if (i // 2) % 2 == 0 else "degraded"
    lines = MrzText(r).document(fmt)
    if fmt == "TD1":
        width = r.randint(720, 900)
        size = (width, round(width * fx.TD1_MM[1] / fx.TD1_MM[0]))
        doc = fx.shade(fx.render_td1(round(width / 1.04), lines, r), r.uniform(0.82, 0.92), 1.0)
    else:
        width = r.randint(700, 880)
        size = (width, round(width * fx.TD3_MM[1] / fx.TD3_MM[0]))
        doc = fx.shade(fx.render_td3(round(width / 1.02), lines, r), r.uniform(0.82, 0.92), 1.0)
    still, _ = fx.on_table(doc, size, r)
    tilt = 0.0
    if variant == "clean":
        still = fx.add_noise(still, 2.0, r)
    else:
        if r.random() < 0.5:
            tilt = round(r.uniform(-2.5, 2.5), 2)
            still = still.rotate(tilt, resample=Image.Resampling.BICUBIC, fillcolor=fx.TABLE)
        still = fx.degrade(still, r.uniform(0.6, 1.2), r)
    name = f"{fmt.lower()}-{i:04d}-{variant}.pgm"
    return still, {"index": i, "file": name, "format": fmt, "variant": variant, "tilt": tilt, "lines": lines}


def main() -> None:
    if sys.argv[1] == "--merge":
        out, count = Path(sys.argv[2]), int(sys.argv[4])
        items = [json.loads(line) for f in sorted(out.glob("items-*.jsonl")) for line in f.read_text().splitlines() if line]
        items = sorted((item for item in items if item["index"] < count), key=lambda item: item["index"])
        if [item["index"] for item in items] != list(range(count)):
            sys.exit(f"error: the benchmark is missing items (found {len(items)} of {count}); run bin/50-bench.sh again")
        (out / "bench.json").write_text(json.dumps(items, indent=0) + "\n")
        print(f"{len(items)} benchmark stills in {out}")
        return
    repo, out, start, end, seed = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    out.mkdir(parents=True, exist_ok=True)
    fx = load_fixture_renderer(repo)
    with (out / f"items-{start:05d}.jsonl").open("w") as listing:
        for i in range(start, end):
            still, item = render_item(fx, i, seed)
            fx.write_pgm(still, out / item["file"])
            listing.write(json.dumps(item) + "\n")


if __name__ == "__main__":
    main()

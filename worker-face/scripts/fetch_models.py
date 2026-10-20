#!/usr/bin/env python3
"""Downloads the face worker's model files into worker-face/models/, refusing any byte that is not the
pinned file (verify_face/model_manifest.py: URL, size, SHA-256).

Standard library only: it runs as Vercel's build command (vercel.json), before the function is
bundled, and in CI. A file already present with the right hash is kept. Nothing is ever downloaded at
run time: the function loads what this put next to it, and checks the hashes again.

Usage: python3 scripts/fetch_models.py [--dir DIR] [--only NAME ...]
Exit status 0 when every requested file is present and correct, 1 otherwise.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from verify_face.model_manifest import FORBIDDEN_SHA256, MODELS  # noqa: E402

CHUNK = 1 << 20


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(name: str, directory: Path) -> bool:
    spec = MODELS[name]
    target = directory / name
    if target.is_file() and target.stat().st_size == spec["size"] and sha256_of(target) == spec["sha256"]:
        print(f"ok (present): {name}")
        return True
    directory.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(str(spec["url"]), headers={"user-agent": "confiance-verify-face-build"})
    digest = hashlib.sha256()
    size = 0
    fd, tmp_name = tempfile.mkstemp(prefix=f".{name}.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(request, timeout=120) as response:
            while True:
                block = response.read(CHUNK)
                if not block:
                    break
                size += len(block)
                if size > int(spec["size"]):
                    raise ValueError("larger than pinned")
                digest.update(block)
                out.write(block)
        got = digest.hexdigest()
        if got in FORBIDDEN_SHA256:
            raise ValueError(f"forbidden file ({FORBIDDEN_SHA256[got]})")
        if size != spec["size"] or got != spec["sha256"]:
            raise ValueError(f"checksum mismatch (size {size}, sha256 {got})")
        # mkstemp makes the file private (0600); the function may run as another user than the build.
        os.chmod(tmp_name, 0o644)
        os.replace(tmp_name, target)
        print(f"ok (downloaded): {name} {size} bytes, sha256 {got}")
        return True
    except Exception as err:  # noqa: BLE001 - report and fail, never keep a partial or wrong file
        print(f"FAILED: {name}: {err}", file=sys.stderr)
        return False
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", type=Path, default=ROOT / "models")
    parser.add_argument("--only", nargs="*", choices=sorted(MODELS), default=sorted(MODELS))
    args = parser.parse_args(argv)
    results = [fetch(name, args.dir) for name in args.only]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())

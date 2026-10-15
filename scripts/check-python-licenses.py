#!/usr/bin/env python3
"""Fails if the AI worker's Python environment holds anything whose licence has not been reviewed.

Run from worker/, in its development environment, after building the production one:

    UV_PROJECT_ENVIRONMENT=/tmp/worker-prod uv sync --frozen --no-dev
    uv run python ../scripts/check-python-licenses.py --prod-python /tmp/worker-prod/bin/python

Three checks against the reviewed table in scripts/python-licenses.toml (the policy is in
docs/LICENSES.md, as for npm in scripts/check-licenses.mjs):
1. the production environment (what Vercel installs) holds exactly the "runtime" packages, at the
   reviewed versions, with the licence metadata pip-licenses reports unchanged;
2. every package of the development environment (pytest, pip-licenses...) is reviewed too;
3. every native file in the production environment (ELF shared library or extension module, and the
   ONNX models) matches exactly one reviewed row, with its pinned SHA-256 where one is given, and no
   row is left without a file. A wheel that starts bundling a new library fails here.
Each reviewed licence expression must be acceptable for commercial use: permissive or file-level
copyleft, LGPL only for a dynamically loaded library, the GCC runtime under its exception, and a
LicenseRef-* only with a written note.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

TABLE = Path(__file__).resolve().parent / "python-licenses.toml"

ALLOWED = {
    "MIT", "MIT-0", "MIT-CMU", "X11", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0",
    "Zlib", "CC0-1.0", "BSL-1.0", "Unlicense", "PSF-2.0", "Python-2.0", "IJG", "libtiff",
    "libpng-2.0", "FTL", "OpenSSL",
    # File-level copyleft: allowed commercially; changes to those files only would have to be published.
    "MPL-2.0",
    # The GCC runtime (libgfortran): the Runtime Library Exception allows use with any code.
    "GPL-3.0-or-later WITH GCC-exception-3.1",
}
# Library-level copyleft: only as a separate shared library loaded at run time (replaceable).
DYNAMIC_ONLY = {"LGPL-2.1-only", "LGPL-2.1-or-later"}


def tokens(expression: str) -> list[str]:
    return re.findall(r"\(|\)|[^\s()]+(?:\s+WITH\s+[^\s()]+)?", expression)


def acceptable(expression: str, *, dynamic: bool, noted: bool) -> bool:
    """SPDX expression: OR needs one acceptable side, AND needs all, parentheses group."""
    items = tokens(expression)
    pos = 0

    def term() -> bool:
        nonlocal pos
        token = items[pos]
        pos += 1
        if token == "(":
            value = either()
            if items[pos] != ")":
                raise ValueError(f"unbalanced: {expression}")
            pos += 1
            return value
        if token in ALLOWED:
            return True
        if token in DYNAMIC_ONLY:
            return dynamic
        return token.startswith("LicenseRef-") and noted

    def both() -> bool:
        nonlocal pos
        value = term()
        while pos < len(items) and items[pos] == "AND":
            pos += 1
            value = term() and value
        return value

    def either() -> bool:
        nonlocal pos
        value = both()
        while pos < len(items) and items[pos] == "OR":
            pos += 1
            value = both() or value
        return value

    result = either()
    if pos != len(items):
        raise ValueError(f"cannot parse: {expression}")
    return result


def pip_licenses(python: str, *, with_system: bool) -> dict[str, dict]:
    """{name: {version, metadata}} as pip-licenses (this environment's) reads `python`'s packages."""
    command = [sys.executable, "-m", "piplicenses", "--python", python, "--from=mixed", "--format=json"]
    if with_system:
        command.append("--with-system")
    out = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    return {p["Name"]: {"version": p["Version"], "metadata": p["License"]} for p in json.loads(out)}


def site_packages(python: str) -> Path:
    code = "import sysconfig; print(sysconfig.get_paths()['purelib'])"
    return Path(subprocess.run([python, "-c", code], check=True, capture_output=True, text=True).stdout.strip())


def native_files(root: Path) -> list[str]:
    """ELF binaries (whatever their name) and ONNX models, as paths relative to `root`."""
    found = []
    for directory, _, files in os.walk(root):
        for name in files:
            path = Path(directory) / name
            if path.is_symlink():
                continue
            with path.open("rb") as handle:
                elf = handle.read(4) == b"\x7fELF"
            if elf or name.endswith(".onnx"):
                found.append(path.relative_to(root).as_posix())
    return sorted(found)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_packages(table: dict, installed: dict[str, dict], groups: set[str], where: str) -> list[str]:
    problems = []
    for name, found in sorted(installed.items()):
        row = table.get(name)
        if row is None or row["group"] not in groups:
            problems.append(f"{where}: {name} {found['version']} ({found['metadata']}) has no reviewed row")
            continue
        if found["version"] != row["version"]:
            problems.append(f"{where}: {name} is {found['version']}, reviewed {row['version']}")
        if found["metadata"] != row["metadata"]:
            problems.append(f"{where}: {name} now declares '{found['metadata']}', reviewed '{row['metadata']}'")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prod-python", required=True, help="interpreter of the production environment (uv sync --no-dev)")
    args = parser.parse_args()

    table = tomllib.loads(TABLE.read_text(encoding="utf-8"))
    packages: dict[str, dict] = table["packages"]
    natives: list[dict] = table["native"]
    problems: list[str] = []

    for name, row in packages.items():
        if row["group"] not in ("runtime", "dev"):
            problems.append(f"table: {name} has group {row['group']!r}")
        if not acceptable(row["license"], dynamic=False, noted=bool(row.get("note"))):
            problems.append(f"table: {name} {row['license']} is not on the commercial-use allowlist")
    for row in natives:
        if row["linking"] not in ("dynamic", "static", "data"):
            problems.append(f"table: {row['path']} has linking {row['linking']!r}")
        if not acceptable(row["license"], dynamic=row["linking"] == "dynamic", noted=bool(row.get("note"))):
            problems.append(f"table: {row['path']} {row['license']} ({row['linking']}) is not acceptable")

    # 1. What ships: exactly the runtime packages.
    production = pip_licenses(args.prod_python, with_system=False)
    problems += check_packages(packages, production, {"runtime"}, "production")
    for name, row in packages.items():
        if row["group"] == "runtime" and name not in production:
            problems.append(f"production: reviewed runtime package {name} is not installed (remove its row?)")

    # 2. The development environment (this interpreter), pip-licenses and its own dependencies included.
    development = pip_licenses(sys.executable, with_system=True)
    problems += check_packages(packages, development, {"runtime", "dev"}, "development")

    # 3. Native files of the production environment.
    root = site_packages(args.prod_python)
    files = native_files(root)
    used = [0] * len(natives)
    for file in files:
        matches = [i for i, row in enumerate(natives) if fnmatch.fnmatchcase(file, row["path"])]
        if len(matches) != 1:
            problems.append(f"native: {file} matches {len(matches)} reviewed rows (expected exactly 1)")
            continue
        row = natives[matches[0]]
        used[matches[0]] += 1
        if "sha256" in row and sha256(root / file) != row["sha256"]:
            problems.append(f"native: {file} does not have the reviewed SHA-256")
    for row, count in zip(natives, used, strict=True):
        if count == 0:
            problems.append(f"native: no file matches the reviewed row {row['path']} (remove it?)")

    if problems:
        print(f"Python licence check FAILED ({len(problems)} problem(s)):", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(f"Review the licence, then update {TABLE.relative_to(TABLE.parent.parent)} and docs/LICENSES.md.", file=sys.stderr)
        return 1
    print(
        f"Python licence check passed: {len(production)} runtime and {len(development) - len(production)} development "
        f"packages, {len(files)} native files in {len(natives)} reviewed rows."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

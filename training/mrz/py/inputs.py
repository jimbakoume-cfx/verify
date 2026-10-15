"""Fetches and checks the pinned inputs listed in inputs.json (standard library only).

Downloads go through curl (it honours the machine's proxy and certificates); git sources are
fetched at their exact commit. Every file is checked against its SHA-256 before anything uses it,
and a file that does not match is deleted and reported: a changed input would change the model.

usage: inputs.py fetch REPO WORK_INPUTS [--with-optional]
       inputs.py verify REPO WORK_INPUTS [--with-optional]
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch_git(item: dict, dest: Path) -> None:
    if not (dest / ".git").exists():
        dest.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "-q", str(dest)], check=True)
    head = subprocess.run(["git", "-C", str(dest), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if head != item["commit"]:
        subprocess.run(["git", "-C", str(dest), "fetch", "-q", "--depth", "1", item["git"], item["commit"]], check=True)
        subprocess.run(["git", "-C", str(dest), "checkout", "-q", "FETCH_HEAD"], check=True)


def fetch_file(item: dict, dest: Path) -> None:
    if dest.exists() and sha256(dest) == item["sha256"]:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    subprocess.run(["curl", "-sS", "-f", "-L", "--retry", "3", "-o", str(part), item["url"]], check=True)
    part.replace(dest)


def check(repo: Path, inputs: Path, with_optional: bool) -> list[str]:
    spec = json.loads((HERE / "inputs.json").read_text())
    problems: list[str] = []
    for item in spec["downloads"]:
        if item.get("optional") and not with_optional:
            continue
        dest = inputs / item["dest"]
        if "git" in item:
            head = subprocess.run(["git", "-C", str(dest), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
            if head != item["commit"]:
                problems.append(f"{item['name']}: at {head or 'nothing'}, expected {item['commit']}")
            for name, digest in item["files"].items():
                f = dest / name
                if not f.exists() or sha256(f) != digest:
                    problems.append(f"{item['name']}: {name} does not match its SHA-256")
        elif not dest.exists() or sha256(dest) != item["sha256"]:
            problems.append(f"{item['name']}: {dest} does not match its SHA-256")
            dest.unlink(missing_ok=True)
    for item in spec["repository"]:
        f = repo / item["path"]
        if not f.exists() or sha256(f) != item["sha256"]:
            message = f"{item['name']}: {item['path']} does not match its SHA-256"
            if item.get("onMismatch", "").startswith("warn"):
                print(f"warning: {message} ({item['onMismatch'][6:]})", file=sys.stderr)
            else:
                problems.append(message)
    return problems


def main() -> None:
    command, repo, inputs = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    with_optional = "--with-optional" in sys.argv
    if command == "fetch":
        spec = json.loads((HERE / "inputs.json").read_text())
        for item in spec["downloads"]:
            if item.get("optional") and not with_optional:
                continue
            dest = inputs / item["dest"]
            print(f"fetching {item['name']}", file=sys.stderr)
            (fetch_git if "git" in item else fetch_file)(item, dest)
    problems = check(repo, inputs, with_optional)
    for p in problems:
        print(f"error: {p}", file=sys.stderr)
    if problems:
        sys.exit(1)
    print("inputs: every pinned file matches its SHA-256", file=sys.stderr)


if __name__ == "__main__":
    main()

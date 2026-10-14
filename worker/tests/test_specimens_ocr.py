"""Integration: the real models on our own SPECIMEN renders, through the whole loop (a stand-in Edge
Function serves the claims and photos and checks every signature).

What passing means: the plumbing works (decoding, rotation, code-line candidates the server's own
corrector and parser accept, keyword evidence, field reading, the result's shape). It is not proof of
accuracy: we drew these documents and their keywords ourselves, in clean fonts. Timing is printed
at the end of the run, never asserted.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import time
import uuid

import pytest

import conftest
from conftest import REPO, SPECIMENS, deno_or_skip
from fake_function import API_KEY, FakeFunction
from result_rules import problems
from verify_worker import log, pipeline
from verify_worker.client import WorkerClient, default_opener
from verify_worker.contract import MRZ_LAYOUT
from verify_worker.fields import to_ascii
from verify_worker.ocr import mrz_characters
from verify_worker.runner import run_ring
from verify_worker.signing import Signer, b64url_encode

pytestmark = pytest.mark.ocr

MRZ_EXPECTATION = {
    "cni_biometric": {"side": "document_back", "format": "TD1", "required": True},
    "passport": {"side": "document_front", "format": "TD3", "required": True},
    "residence_permit": {"side": "document_back", "format": "TD1", "required": False},
}
FAMILY_GROUP = {
    "cni_new": "national_id",
    "cni_old": "national_id",
    "passport_cmr": "passport",
    "passport_uto": "passport",
    "sejour_new": "residence",
    "resident_new": "residence",
    "refugee_new": "residence",
    "permit_old": "residence",
    "refugee_old": "residence",
    "driving_licence": "driving_licence",
    "voter_card": "voter_card",
}


def job_id(file: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"specimen/{file}"))


@pytest.fixture(scope="module")
def run(manifest):
    """Every specimen through the worker's loop once; results by file, plus every log line."""
    log.configure()
    lines: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record):
            lines.append(record.getMessage())

    collector = Collect(level=logging.DEBUG)
    watched = [logging.getLogger(name) for name in ("verify_worker", "RapidOCR", "")]
    for logger in watched:
        logger.addHandler(collector)

    signer = Signer.from_seed("specimens", b64url_encode(bytes(range(32))))
    by_job = {}
    with FakeFunction("specimens", signer.public_key_b64url()) as fake:
        for photo in manifest["photos"]:
            data = (SPECIMENS / photo["file"]).read_bytes()
            jid = job_id(photo["file"])
            by_job[jid] = photo
            import hashlib

            fake.claims.append({
                "jobId": jid,
                "attempt": 1,
                "captureId": str(uuid.uuid4()),
                "side": photo["side"],
                "declaredDocument": photo["declaredDocument"],
                "mrzExpectation": MRZ_EXPECTATION.get(photo["declaredDocument"]),
                "image": {"sha256": hashlib.sha256(data).hexdigest(), "byteSize": len(data), "width": photo["width"], "height": photo["height"]},
            })
            fake.images[jid] = data

        def timed(claim, data):
            cpu, wall = time.process_time(), time.perf_counter()
            result = pipeline.analyse(claim, data)
            conftest.TIMINGS.append((by_job[claim["jobId"]]["file"], time.process_time() - cpu, time.perf_counter() - wall))
            return result

        client = WorkerClient(fake.url, API_KEY, signer, opener=default_opener(proxies={}))
        summary = run_ring(client, timed, window_s=3600, max_jobs=1000)
        results = {by_job[r["jobId"]]["file"]: r for r in fake.results}
        refused = list(fake.refused)
    for logger in watched:
        logger.removeHandler(collector)
    return {"summary": summary, "results": results, "logs": lines, "refused": refused}


def photos(manifest_json: dict, keep=lambda p: True) -> list[dict]:
    return [p for p in manifest_json["photos"] if keep(p)]


MANIFEST = json.loads((SPECIMENS / "manifest.json").read_text(encoding="utf-8"))


def ids(items):
    return [p["file"] for p in items]


def test_every_photo_was_processed_and_recorded(run):
    assert run["refused"] == []
    assert run["summary"].recorded == len(MANIFEST["photos"]) == len(run["results"])
    assert run["summary"].stopped == "no_job"


@pytest.mark.parametrize("photo", MANIFEST["photos"], ids=ids(MANIFEST["photos"]))
def test_result_passes_the_servers_rules(run, photo):
    assert problems(run["results"][photo["file"]]) == []


WITH_TEXT = photos(MANIFEST, lambda p: p["document"] not in ("blank", "none") and not p["expected"].get("blurry"))


@pytest.mark.parametrize("photo", WITH_TEXT, ids=ids(WITH_TEXT))
def test_reads_the_right_way_up(run, photo):
    c = run["results"][photo["file"]]["classification"]
    assert c["rotation"] == photo["expected"]["rotation"]
    assert c["orientation"] == photo["expected"]["orientation"]


def fold(line: str) -> str:
    """Look-alikes made equal, for comparing raw candidates with the printed lines (test only)."""
    return line.translate(str.maketrans("0QD18526", "OOOIBSZG"))


READABLE_MRZ = photos(MANIFEST, lambda p: p["expected"]["mrz"] is not None and not p["expected"].get("blurry"))


@pytest.mark.parametrize("photo", READABLE_MRZ, ids=ids(READABLE_MRZ))
def test_code_lines_are_among_the_candidates(run, photo):
    expected = photo["expected"]["mrz"]["lines"]
    folded = [fold(c) for c in run["results"][photo["file"]]["mrzCandidates"]]
    want = [fold(line) for line in expected]
    assert any(folded[i : i + len(want)] == want for i in range(len(folded))), (photo["file"], len(folded))


def test_the_servers_corrector_reads_them(run):
    """The Edge Function's own corrector and parser (run in Deno) turn the candidates into exactly the
    printed code lines, with every check digit right."""
    if shutil.which("npx") is None:
        deno_or_skip("Node (npx) is not installed")
    batch = [
        {"format": p["expected"]["mrz"]["format"], "candidates": run["results"][p["file"]]["mrzCandidates"]}
        for p in READABLE_MRZ
    ]
    try:
        out = subprocess.run(
            ["npx", "deno", "run", "--quiet", "worker/tests/tools/server_mrz.ts"],
            cwd=REPO, input=json.dumps(batch), capture_output=True, text=True, timeout=300, check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as err:
        deno_or_skip(f"Deno is not available ({type(err).__name__})")
    for photo, read in zip(READABLE_MRZ, json.loads(out.stdout), strict=True):
        assert read["lines"] == photo["expected"]["mrz"]["lines"], photo["file"]
        assert read["valid"] is True, photo["file"]


FRONTS = photos(MANIFEST, lambda p: p["side"] == "document_front" and p["document"] in FAMILY_GROUP and not p["expected"].get("blurry"))


@pytest.mark.parametrize("photo", FRONTS, ids=ids(FRONTS))
def test_family_keywords_on_fronts(run, photo):
    hits = run["results"][photo["file"]]["classification"]["keywordHits"]
    group = FAMILY_GROUP[photo["document"]]
    assert hits[group] > 0
    others = {g for g in FAMILY_GROUP.values() if g != group}
    assert all(hits[g] == 0 for g in others), hits


@pytest.mark.parametrize("photo", MANIFEST["photos"], ids=ids(MANIFEST["photos"]))
def test_qr_and_subtype(run, photo):
    result = run["results"][photo["file"]]
    assert result["classification"]["qrPresent"] is photo["expected"]["qr"]
    if not photo["expected"].get("blurry"):
        assert result["fields"].get("subtype") == photo["expected"]["subtype"]


CLEAN = photos(MANIFEST, lambda p: p["variant"] == "clean" or p["variant"].startswith("upside") or p["variant"].startswith("turned"))


@pytest.mark.parametrize("photo", CLEAN, ids=ids(CLEAN))
def test_printed_fields(run, photo):
    fields = {k: v for k, v in run["results"][photo["file"]]["fields"].items() if k != "subtype"}
    assert fields == photo["expected"]["fields"]


@pytest.mark.parametrize("photo", MANIFEST["photos"], ids=ids(MANIFEST["photos"]))
def test_never_read_values_never_leave(run, photo):
    """Neither in the fields nor among the code-line candidates, which leave the worker too."""
    result = run["results"][photo["file"]]
    values = [v for k, v in result["fields"].items() if k != "subtype"]
    for secret in photo["never"]:
        folded = to_ascii(secret)
        assert all(folded not in to_ascii(v) for v in values), photo["file"]
        as_code = mrz_characters(secret)
        assert all(as_code not in line for line in result["mrzCandidates"]), (photo["file"], "mrzCandidates")


@pytest.mark.parametrize("photo", MANIFEST["photos"], ids=ids(MANIFEST["photos"]))
def test_only_code_lines_are_candidates(run, photo):
    """No printed row of any specimen is sent as a candidate: only its own code lines, if it has any."""
    expected = {fold(line) for line in (photo["expected"]["mrz"] or {}).get("lines", [])}
    for line in run["results"][photo["file"]]["mrzCandidates"]:
        assert fold(line) in expected, photo["file"]


def test_quality_extremes(run):
    r = run["results"]
    assert r["blank-card.jpg"]["quality"]["textLines"] == 0 and r["blank-card.jpg"]["quality"]["documentFound"]
    assert r["no-document.jpg"]["quality"]["textLines"] == 0 and not r["no-document.jpg"]["quality"]["documentFound"]
    assert r["cni-old-front-glare.jpg"]["quality"]["glareRatio"] > 0.02
    assert r["passport-cmr-blur.jpg"]["quality"]["sharpness"] < 5
    clean = [r[p["file"]]["quality"] for p in MANIFEST["photos"] if p["variant"] == "clean" and p["document"] not in ("blank", "none")]
    assert all(q["documentFound"] and q["sharpness"] >= 5 and q["glareRatio"] <= 0.02 and 50 <= q["meanLuma"] <= 225 for q in clean)
    assert all(q["textLines"] >= 3 for q in clean)


def test_logs_carry_codes_and_numbers_only(run):
    assert run["logs"], "the loop logs its events"
    printed = set()
    for photo in MANIFEST["photos"]:
        printed.update(to_ascii(str(v)) for v in photo["printed"].values())
        printed.update(to_ascii(v) for v in photo["never"])
        for line in (photo["expected"]["mrz"] or {}).get("lines", []):
            printed.add(line)
    for line in run["logs"]:
        upper = to_ascii(line)
        assert not any(value and value in upper for value in printed), line
        assert all(part.split("=")[0].replace(".", "").replace("_", "").isalnum() for part in line.split()), line


def test_text_mapping_on_real_output(run):
    """Every candidate is plain A-Z, 0-9 and '<' (look-alikes from other scripts mapped)."""
    for result in run["results"].values():
        for line in result["mrzCandidates"]:
            assert set(line) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<")
            assert any(abs(len(line) - layout["length"]) <= 4 for layout in MRZ_LAYOUT.values())

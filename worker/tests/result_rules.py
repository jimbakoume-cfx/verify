"""The Edge Function's rules for a WorkerResultRequest (supabase/functions/worker/validation.ts),
restated for the tests: a result that breaks one would be refused whole by the server."""

from __future__ import annotations

import re
import uuid

from verify_worker.classify import KEYWORD_GROUPS
from verify_worker.contract import FIELD_NAMES, WORKER_LIMITS


def problems(result: dict) -> list[str]:
    out: list[str] = []

    def check(ok: bool, what: str) -> None:
        if not ok:
            out.append(what)

    def is_int(v, lo, hi) -> bool:
        return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi

    def is_num(v, lo, hi) -> bool:
        return isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi

    check(set(result) == {"jobId", "attempt", "engine", "quality", "mrzCandidates", "classification", "fields", "timing"}, "keys")
    try:
        uuid.UUID(result["jobId"])
    except (ValueError, TypeError, KeyError):
        out.append("jobId")
    check(is_int(result.get("attempt"), 1, 3), "attempt")
    engine = result.get("engine", "")
    check(isinstance(engine, str) and 0 < len(engine) <= WORKER_LIMITS["maxEngineLength"] and re.fullmatch(r"[A-Za-z0-9._/-]+", engine) is not None, "engine")
    q = result.get("quality", {})
    check(set(q) == {"sharpness", "glareRatio", "meanLuma", "documentFound", "documentConfidence", "longSide", "textLines"}, "quality keys")
    check(is_num(q.get("sharpness"), 0, 1e9), "sharpness")
    check(is_num(q.get("glareRatio"), 0, 1), "glareRatio")
    check(is_num(q.get("meanLuma"), 0, 255), "meanLuma")
    check(isinstance(q.get("documentFound"), bool), "documentFound")
    check(is_num(q.get("documentConfidence"), 0, 1), "documentConfidence")
    check(is_int(q.get("longSide"), 0, 16384), "longSide")
    check(is_int(q.get("textLines"), 0, 10000), "textLines")
    cands = result.get("mrzCandidates")
    check(isinstance(cands, list) and len(cands) <= WORKER_LIMITS["maxMrzCandidates"], "mrzCandidates")
    for line in cands or []:
        check(isinstance(line, str) and len(line) <= WORKER_LIMITS["maxCandidateLength"] and re.fullmatch(r"[A-Z0-9<]*", line) is not None, "candidate")
    c = result.get("classification", {})
    check(set(c) == {"rotation", "keywordHits", "qrPresent", "orientation"}, "classification keys")
    check(c.get("rotation") in (0, 90, 180, 270), "rotation")
    hits = c.get("keywordHits", {})
    check(isinstance(hits, dict) and len(hits) <= WORKER_LIMITS["maxKeywordGroups"], "keywordHits")
    for group, count in hits.items():
        check(group in KEYWORD_GROUPS and is_int(count, 0, 1000), f"keyword {group}")
    check(isinstance(c.get("qrPresent"), bool), "qrPresent")
    check(c.get("orientation") in (None, "landscape", "portrait"), "orientation")
    fields = result.get("fields", {})
    check(set(fields) <= set(FIELD_NAMES), "field keys")
    for name, value in fields.items():
        text = value.strip() if isinstance(value, str) else None
        check(text is not None and 0 < len(text) <= WORKER_LIMITS["maxFieldLength"] and re.fullmatch(r"[\x20-\x7e]+", text) is not None, f"field {name}")
        if name == "subtype":
            check(re.fullmatch(r"[a-z_]{1,32}", value) is not None, "subtype")
    t = result.get("timing", {})
    check(set(t) == {"ms", "cold"} and is_int(t.get("ms"), 0, 300_000) and isinstance(t.get("cold"), bool), "timing")
    return out

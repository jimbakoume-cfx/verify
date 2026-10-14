"""verify_worker/contract.py and classify.py mirror supabase/functions/_shared/contract.ts: any drift
fails here (contract.ts is the single source of truth)."""

from __future__ import annotations

import re

from conftest import REPO
from verify_worker import ENGINE, classify, contract

CONTRACT = (REPO / "supabase" / "functions" / "_shared" / "contract.ts").read_text(encoding="utf-8")


def const_block(name: str) -> str:
    m = re.search(rf"export const {name}\b[^=]*=\s*(.+?)(?:\] as const;|\}} as const;|;\n)", CONTRACT, re.S)
    assert m, name
    return m.group(1)


def string_list(name: str) -> list[str]:
    return re.findall(r'"([^"]+)"', const_block(name))


def scalar(name: str) -> str:
    m = re.search(rf"export const {name}\s*=\s*([^;]+);", CONTRACT)
    assert m, name
    return m.group(1).strip()


def ts_number(text: str) -> int:
    return eval(text.replace("_", ""), {})  # noqa: S307 - a literal arithmetic expression from contract.ts


def test_documents_sides_formats():
    assert tuple(string_list("DECLARED_DOCUMENTS")) == contract.DECLARED_DOCUMENTS
    assert tuple(string_list("CAPTURE_SIDES")) == contract.CAPTURE_SIDES
    assert tuple(string_list("MRZ_FORMATS")) == contract.MRZ_FORMATS


def test_mrz_layout():
    for fmt, layout in contract.MRZ_LAYOUT.items():
        assert re.search(rf"{fmt}: \{{ lines: {layout['lines']}, length: {layout['length']} \}}", CONTRACT)


def test_capture_limits():
    block = const_block("CAPTURE_LIMITS")
    assert ts_number(re.search(r"maxBytes: ([^,]+),", block).group(1)) == contract.MAX_CAPTURE_BYTES
    assert ts_number(re.search(r"maxLongSide: ([^,]+),", block).group(1)) == contract.MAX_LONG_SIDE


def test_signature_constants():
    assert scalar("WORKER_SIGNATURE_VERSION") == f'"{contract.WORKER_SIGNATURE_VERSION}"'
    assert scalar("WORKER_AUDIENCE") == f'"{contract.WORKER_AUDIENCE}"'
    assert ts_number(scalar("WORKER_SIGNATURE_WINDOW_S")) == contract.WORKER_SIGNATURE_WINDOW_S
    block = const_block("WORKER_HEADERS")
    for key, header in contract.WORKER_HEADERS.items():
        assert f'{key}: "{header}"' in block


def test_worker_limits():
    block = const_block("WORKER_LIMITS")
    for key, value in contract.WORKER_LIMITS.items():
        m = re.search(rf"{key}: ([^,]+),", block)
        assert m, key
        assert ts_number(m.group(1)) == value, key


def test_keyword_groups_match_the_contract():
    assert list(classify.KEYWORD_GROUPS) == string_list("KEYWORD_GROUPS")
    assert len(classify.KEYWORD_GROUPS) <= contract.WORKER_LIMITS["maxKeywordGroups"]


def test_worker_fields_match_the_contract():
    body = re.search(r"export interface WorkerFields \{(.+?)\n\}", CONTRACT, re.S).group(1)
    names = tuple(re.findall(r"^\s+(\w+)\?:", body, re.M))
    assert names == contract.FIELD_NAMES


def test_engine_label_fits():
    assert len(ENGINE) <= contract.WORKER_LIMITS["maxEngineLength"]
    assert re.fullmatch(r"[A-Za-z0-9._/-]+", ENGINE)


def test_card_subtypes():
    assert tuple(name for name, _ in classify.SUBTYPES) == tuple(string_list("CARD_SUBTYPES"))

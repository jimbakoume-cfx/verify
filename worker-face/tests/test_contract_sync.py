"""verify_face/contract.py mirrors supabase/functions/_shared/contract.ts: any drift fails here
(contract.ts is the single source of truth). The evidence the worker builds has exactly the
contract's keys."""

from __future__ import annotations

import re

from conftest import REPO
from verify_face import ENGINE, contract, liveness

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


def interface_keys(name: str) -> tuple[str, ...]:
    body = re.search(rf"export interface {name} \{{(.+?)\n\}}", CONTRACT, re.S).group(1)
    return tuple(re.findall(r"^  (\w+)\??:", body, re.M))


def test_documents_actions_kinds():
    assert tuple(string_list("DECLARED_DOCUMENTS")) == contract.DECLARED_DOCUMENTS
    assert tuple(string_list("LIVENESS_ACTIONS")) == contract.LIVENESS_ACTIONS
    assert tuple(string_list("FACE_JOB_KINDS")) == contract.FACE_JOB_KINDS


def test_limits():
    capture = const_block("CAPTURE_LIMITS")
    assert ts_number(re.search(r"maxBytes: ([^,]+),", capture).group(1)) == contract.MAX_CAPTURE_BYTES
    assert ts_number(re.search(r"maxLongSide: ([^,]+),", capture).group(1)) == contract.MAX_LONG_SIDE
    live = const_block("LIVENESS_LIMITS")
    assert ts_number(re.search(r"maxFrames: ([^,]+),", live).group(1)) == contract.MAX_FRAMES
    assert ts_number(re.search(r"maxFrameBytes: ([^,]+),", live).group(1)) == contract.MAX_FRAME_BYTES
    assert ts_number(re.search(r"maxFrameLongSide: ([^,]+),", live).group(1)) == contract.MAX_FRAME_LONG_SIDE
    face = const_block("FACE_LIMITS")
    for key, value in contract.FACE_LIMITS.items():
        assert ts_number(re.search(rf"{key}: ([^,]+),", face).group(1)) == value, key


def test_signature_constants():
    assert scalar("WORKER_SIGNATURE_VERSION") == f'"{contract.WORKER_SIGNATURE_VERSION}"'
    assert scalar("FACE_WORKER_AUDIENCE") == f'"{contract.FACE_WORKER_AUDIENCE}"'
    assert scalar("WORKER_AUDIENCE") != scalar("FACE_WORKER_AUDIENCE")
    assert ts_number(scalar("WORKER_SIGNATURE_WINDOW_S")) == contract.WORKER_SIGNATURE_WINDOW_S
    block = const_block("WORKER_HEADERS")
    for key, header in contract.WORKER_HEADERS.items():
        assert f'{key}: "{header}"' in block


def test_frame_measure_keys():
    assert interface_keys("FaceFrameMeasure") == contract.FRAME_MEASURE_KEYS


def test_the_worker_sends_exactly_the_measure_keys():
    """liveness.frame_measure builds the dict the Edge Function validates strictly."""
    import numpy as np

    measure = liveness.frame_measure(liveness.Frame(0, 0, np.zeros((480, 360, 3), np.uint8)), [], None)
    assert tuple(measure) == contract.FRAME_MEASURE_KEYS
    assert measure["faces"] == 0 and all(measure[k] is None for k in contract.FRAME_MEASURE_KEYS[2:])


def test_face_match_evidence_keys():
    assert interface_keys("FaceMatchEvidence") == ("portrait", "selfie", "similarity")
    assert interface_keys("FaceResultRequest") == ("jobId", "attempt", "kind", "engine", "liveness", "faceMatch", "timing")


def test_engine_label_fits():
    assert len(ENGINE) <= contract.FACE_LIMITS["maxEngineLength"]
    assert re.fullmatch(r"[A-Za-z0-9._/-]+", ENGINE)

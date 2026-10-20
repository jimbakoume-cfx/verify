"""The attack-capture manifest of our own screen and print detectors (training/antispoof/README.md).

Standard library only, so its rules run in CI (python3 -m unittest). One JSON object per line:

  {"file": "captures/0001/frame-03.jpg", "label": "bonafide" | "print" | "screen" | "replay" | "mask",
   "person": "v017", "session": "s0042", "device": "tecno-spark-10", "lighting": "indoor-dim",
   "monk": 1..10, "consent": "volunteer-form-v1:v017"}

- Every row names the consent it rests on: a volunteer form (PLAN.md section 5) or a rider who ticked
  "keep my face images" (M5; private.face_training_cases() lists those cases). No consent, no row.
- `person` is a pseudonym; the manifest never holds a name, a document number or a face crop.
- Splits are by person (never by frame): the same face is never in training and in evaluation.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

LABELS = ("bonafide", "print", "screen", "replay", "mask")
ATTACKS = LABELS[1:]
KEYS = ("file", "label", "person", "session", "device", "lighting", "monk", "consent")
PSEUDONYM = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
CONSENT = re.compile(r"^(volunteer-form-v\d+|rider-keep-faces):[A-Za-z0-9-]{1,64}$")
# Enough people to say anything per group; below this the trainer refuses to run.
MIN_PEOPLE = 50
MIN_PEOPLE_PER_ATTACK = 20


@dataclass(frozen=True)
class Row:
    file: str
    label: str
    person: str
    session: str
    device: str
    lighting: str
    monk: int
    consent: str


def parse_line(line: str) -> Row:
    value = json.loads(line)
    if not isinstance(value, dict) or tuple(sorted(value)) != tuple(sorted(KEYS)):
        raise ValueError("a row must have exactly the manifest's keys")
    if value["label"] not in LABELS:
        raise ValueError("unknown label")
    for key in ("person", "session", "device", "lighting"):
        if not isinstance(value[key], str) or not PSEUDONYM.match(value[key]):
            raise ValueError(f"{key} must be a short lower-case code (a pseudonym, never a name)")
    if not isinstance(value["monk"], int) or isinstance(value["monk"], bool) or not 1 <= value["monk"] <= 10:
        raise ValueError("monk must be the Monk skin tone scale, 1 to 10")
    if not isinstance(value["consent"], str) or not CONSENT.match(value["consent"]):
        raise ValueError("every row needs the consent it rests on")
    if not isinstance(value["file"], str) or value["file"].startswith("/") or ".." in value["file"].split("/"):
        raise ValueError("file must be a relative path inside the capture folder")
    return Row(**value)


def load(text: str) -> list[Row]:
    return [parse_line(line) for line in text.splitlines() if line.strip()]


def split_by_person(rows: list[Row], evaluation_share: float = 0.3, salt: str = "antispoof-v1") -> tuple[list[Row], list[Row]]:
    """Deterministic split on a hash of the person: all of a person's rows land on one side."""
    def evaluation(person: str) -> bool:
        digest = hashlib.sha256(f"{salt}:{person}".encode()).digest()
        return int.from_bytes(digest[:4], "big") / 2**32 < evaluation_share

    train = [r for r in rows if not evaluation(r.person)]
    test = [r for r in rows if evaluation(r.person)]
    return train, test


def readiness(rows: list[Row]) -> list[str]:
    """Why the data is not enough to train yet (empty when it is)."""
    problems = []
    people = {r.person for r in rows}
    if len(people) < MIN_PEOPLE:
        problems.append(f"{len(people)} people, at least {MIN_PEOPLE} needed")
    for attack in ATTACKS[:3]:
        n = len({r.person for r in rows if r.label == attack})
        if n < MIN_PEOPLE_PER_ATTACK:
            problems.append(f"{attack}: {n} people, at least {MIN_PEOPLE_PER_ATTACK} needed")
    tones = {r.monk for r in rows if r.label == "bonafide"}
    if not {7, 8, 9, 10} & tones:
        problems.append("no bona fide capture with a Monk tone of 7 or darker")
    return problems


def apcer_bpcer(rows: list[Row], predicted_attack: list[bool]) -> dict[str, float]:
    """ISO/IEC 30107-3: APCER per attack type (attacks accepted as bona fide), BPCER (bona fide refused)."""
    out: dict[str, float] = {}
    for attack in ATTACKS:
        idx = [i for i, r in enumerate(rows) if r.label == attack]
        if idx:
            out[f"APCER.{attack}"] = sum(not predicted_attack[i] for i in idx) / len(idx)
    bona = [i for i, r in enumerate(rows) if r.label == "bonafide"]
    if bona:
        out["BPCER"] = sum(predicted_attack[i] for i in bona) / len(bona)
    return out
